// Whether a tab draws frames and runs work right now. This is the one place
// that answers it; the render pump and input ask here instead of keeping
// their own assumption.
//
// tab.active is not the answer: an active tab whose window is occluded (or on
// a display that is off) is hidden and draws nothing, while a frozen tab runs
// no task at all and a discarded tab has no page. The document's own
// visibility is what Chrome actually rendered for, so a live tab is judged by
// it, read in bro's isolated world, where page scripts that fake visibility
// cannot reach.

import { cdpSession } from './cdp.js'

/**
 * - painting: visible; the tab composites frames by itself.
 * - hidden: live, but draws no frame unless something forces one.
 * - frozen: Chrome runs no task in the page until it unfreezes.
 * - discarded: Chrome unloaded the page; nothing runs until it reloads.
 */
export type RenderState = 'painting' | 'hidden' | 'frozen' | 'discarded'

// Isolated world per tab; a navigation destroys it with its document.
const worlds = new Map<number, number>()
cdpSession.onDetach((tabId) => worlds.delete(tabId))

/**
 * `timeoutMs`, when provided, bounds each CDP visibility read without detaching
 * the session. Input holds the tab's input queue while it asks, so it passes a
 * timeout; the render pump runs in the background and passes none.
 */
export async function renderState(tabId: number, timeoutMs?: number): Promise<RenderState> {
  return (
    (await stalledState(tabId)) ??
    ((await documentVisibility(tabId, timeoutMs)) === 'visible' ? 'painting' : 'hidden')
  )
}

/**
 * Frozen or discarded, from Chrome's tab record alone. A command into such a
 * page gets no reply, so this is what explains a timeout without asking the
 * page again.
 */
export async function stalledState(tabId: number): Promise<'frozen' | 'discarded' | undefined> {
  const tab = await chrome.tabs.get(tabId)
  if (tab.discarded) return 'discarded'
  if (tab.frozen) return 'frozen'
  return undefined
}

/** Why a frozen or discarded tab does not respond, and what the caller can do. */
export function unresponsive(tabId: number, state: 'frozen' | 'discarded'): string {
  return state === 'frozen'
    ? `tab ${tabId} is frozen by Chrome and did not resume: Chrome runs nothing in a background tab it froze. Activate the tab (tabs_activate) or reopen its URL.`
    : `tab ${tabId} is discarded: Chrome unloaded its page. Navigate or reload it before acting on it.`
}

// Chrome freezes background tabs once it holds more than a few, and a frozen
// page answers no injected script until it unfreezes, often a minute later.
// An act or read resumes its tab instead of waiting; a watch only observes and
// reports a frozen tab as an event.
/** How long a resumed tab may take to report it: a page resumes in milliseconds, a loaded machine's in about a second. */
export const RESUME_MS = 3_000
/** How long a page may take to run an injected script: past a busy main thread, well short of the bridge's 30 s. */
export const IN_PAGE_TIMEOUT_MS = 10_000

/**
 * Listens for a change to the tab that `matches` from now on; `within(ms)`
 * resolves true once one was seen, false after `ms` more. Arming before the
 * command that causes the change keeps a fast change from being missed.
 */
function tabChange(tabId: number, matches: (change: chrome.tabs.OnUpdatedInfo) => boolean) {
  let seen = false
  let notify = () => {}
  const listener = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (id !== tabId || !matches(change)) return
    seen = true
    notify()
  }
  chrome.tabs.onUpdated.addListener(listener)
  return {
    within: (ms: number) =>
      new Promise<boolean>((resolve) => {
        if (seen) return resolve(true)
        const timer = setTimeout(() => resolve(false), ms)
        notify = () => {
          clearTimeout(timer)
          resolve(true)
        }
      }),
    stop: () => chrome.tabs.onUpdated.removeListener(listener),
  }
}

// When bro last resumed each tab. Time a page spent frozen is not time it was
// quiet: work it owed (rendering an answer that arrived) runs after this.
// Tab ids are not reused, so a closed tab's entry is only a stale number.
const resumes = new Map<number, number>()

/** Milliseconds since bro last resumed the tab, or Infinity. */
export function sinceResumed(tabId: number): number {
  const at = resumes.get(tabId)
  return at === undefined ? Infinity : Date.now() - at
}

/**
 * Makes a tab bro is about to act on or read run again if Chrome froze it.
 * Fails with the reason when it is discarded or does not resume.
 */
export async function keepLive(tabId: number): Promise<void> {
  const stalled = await stalledState(tabId)
  if (!stalled) return
  if (stalled === 'discarded') throw new Error(unresponsive(tabId, 'discarded'))
  const resumed = tabChange(tabId, (change) => change.frozen === false)
  try {
    const sent = Date.now()
    await cdpSession.send(tabId, 'Page.setWebLifecycleState', { state: 'active' })
    const answered = Date.now() - sent
    if (!(await resumed.within(RESUME_MS)) && (await stalledState(tabId)))
      throw new Error(
        `${unresponsive(tabId, 'frozen')} (Chrome answered the resume in ${answered} ms, then reported no resume within ${RESUME_MS} ms)`,
      )
  } finally {
    resumed.stop()
  }
  resumes.set(tabId, Date.now())
}

/**
 * chrome.scripting.executeScript for act and read paths. The tab is resumed
 * first and again if Chrome freezes it during the call, and the call fails
 * with the reason after IN_PAGE_TIMEOUT_MS instead of waiting for Chrome.
 *
 * The freeze listener is armed before the first check. Chrome can deliver a
 * freeze ahead of the reply to a tab read made just before it, so a check
 * followed by a listener misses that freeze: nothing resumes the tab and the
 * script waits until Chrome unfreezes it by itself, seconds later.
 */
export async function inLivePage<Args extends unknown[], Result>(
  injection: chrome.scripting.ScriptInjection<Args, Result>,
): Promise<chrome.scripting.InjectionResult<chrome.scripting.Awaited<Result>>[]> {
  const tabId = injection.target.tabId
  let stop = () => {}
  const failed = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      void stalledState(tabId).then(
        (stalled) =>
          reject(
            new Error(
              stalled
                ? unresponsive(tabId, stalled)
                : `tab ${tabId} did not run bro's page script within ${IN_PAGE_TIMEOUT_MS} ms: its main thread is busy`,
            ),
          ),
        reject,
      )
    }, IN_PAGE_TIMEOUT_MS)
    const listener = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && (change.frozen || change.discarded)) keepLive(tabId).catch(reject)
    }
    chrome.tabs.onUpdated.addListener(listener)
    stop = () => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
    }
  })
  try {
    await Promise.race([keepLive(tabId), failed])
    return await Promise.race([chrome.scripting.executeScript(injection), failed])
  } finally {
    stop()
  }
}

async function documentVisibility(tabId: number, timeoutMs?: number): Promise<string> {
  const known = worlds.get(tabId)
  if (known !== undefined) {
    try {
      return await visibilityIn(tabId, known, timeoutMs)
    } catch (error) {
      if (!/Cannot find context/.test(String(error))) throw error
      // The document navigated and took its isolated world with it.
      worlds.delete(tabId)
    }
  }
  const { frameTree } = await cdpSession.send<{ frameTree: { frame: { id: string } } }>(
    tabId,
    'Page.getFrameTree',
    undefined,
    timeoutMs,
  )
  const world = await cdpSession.send<{ executionContextId: number }>(
    tabId,
    'Page.createIsolatedWorld',
    { frameId: frameTree.frame.id, worldName: 'bro-render-state', grantUniveralAccess: false },
    timeoutMs,
  )
  worlds.set(tabId, world.executionContextId)
  return visibilityIn(tabId, world.executionContextId, timeoutMs)
}

async function visibilityIn(tabId: number, contextId: number, timeoutMs?: number): Promise<string> {
  const reply = await cdpSession.send<{
    result: { value?: unknown }
    exceptionDetails?: { text: string }
  }>(
    tabId,
    'Runtime.evaluate',
    { expression: 'document.visibilityState', contextId, returnByValue: true },
    timeoutMs,
  )
  if (reply.exceptionDetails) throw new Error(`visibility read failed: ${reply.exceptionDetails.text}`)
  if (typeof reply.result.value !== 'string')
    throw new Error(`visibility read returned ${JSON.stringify(reply.result.value)}`)
  return reply.result.value
}
