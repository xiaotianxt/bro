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

import { cdpSession, type ReplyBound } from './cdp.js'

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
 * `bound` is the caller's choice for the page reads (see ReplyBound). The pump
 * asks every tick and must not detach a tab whose renderer is busy for seconds
 * (a large AX tree read), so it passes 'caller'. Input holds the tab's input
 * queue while it asks, so it keeps the session bound: a renderer that never
 * answers fails the input instead of blocking every later one.
 */
export async function renderState(tabId: number, bound: ReplyBound): Promise<RenderState> {
  return (
    (await stalledState(tabId)) ??
    ((await documentVisibility(tabId, bound)) === 'visible' ? 'painting' : 'hidden')
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
    ? `tab ${tabId} is frozen: Chrome runs nothing in a background tab it froze until it unfreezes. Activate the tab (tabs_activate) or reopen its URL.`
    : `tab ${tabId} is discarded: Chrome unloaded its page. Navigate or reload it before acting on it.`
}

async function documentVisibility(tabId: number, bound: ReplyBound): Promise<string> {
  const known = worlds.get(tabId)
  if (known !== undefined) {
    try {
      return await visibilityIn(tabId, known, bound)
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
    bound,
  )
  const world = await cdpSession.send<{ executionContextId: number }>(
    tabId,
    'Page.createIsolatedWorld',
    { frameId: frameTree.frame.id, worldName: 'bro-render-state', grantUniveralAccess: false },
    bound,
  )
  worlds.set(tabId, world.executionContextId)
  return visibilityIn(tabId, world.executionContextId, bound)
}

async function visibilityIn(tabId: number, contextId: number, bound: ReplyBound): Promise<string> {
  const reply = await cdpSession.send<{
    result: { value?: unknown }
    exceptionDetails?: { text: string }
  }>(
    tabId,
    'Runtime.evaluate',
    { expression: 'document.visibilityState', contextId, returnByValue: true },
    bound,
  )
  if (reply.exceptionDetails) throw new Error(`visibility read failed: ${reply.exceptionDetails.text}`)
  if (typeof reply.result.value !== 'string')
    throw new Error(`visibility read returned ${JSON.stringify(reply.result.value)}`)
  return reply.result.value
}
