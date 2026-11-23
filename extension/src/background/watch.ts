// The page side of a watch the Go server owns. The server keeps the last value
// it saw and probes on its own clock as a heartbeat (never a page timer, which
// Chrome throttles in background tabs), so a probe that finds its page state
// gone (a navigation, a re-render, a service worker restart) only loses
// transients, never a change that is still on the page.
//
// The page keeps a latch in the extension's isolated world: a MutationObserver
// that re-evaluates the condition when the DOM changes and pushes each new
// value to the service worker at once (chrome.runtime.sendMessage, which wakes
// a sleeping worker), which forwards it to the server. MutationObserver
// callbacks are microtasks, not timers, so throttling does not delay them, and
// the mutations of one task cost one check. A value the worker could not
// forward stays in the latch for the next probe. The latch lives in the
// extension world, which survives service worker restarts and which page
// scripts cannot reach.
//
// Pushing needs no debugger session: bro holds one only for the length of a
// tool call, and one held for a whole watch would keep Chrome's debugging
// banner up and break whenever DevTools opens. A navigation replaces the
// document and its latch; the worker reinstalls the latch when the new
// document is parsed, and a closed tab is pushed from chrome.tabs.onRemoved.
//
// A frozen or discarded tab is reported from Chrome's tab record before any
// script is sent: a frozen page runs no script and would hold the probe.
//
// A target may live in a child frame (a support chat is often a cross-site
// iframe). The latch then runs in that frame's document. Observe names frames
// by CDP frame id, which chrome.scripting does not know; locateFrame finds
// the scripting frame by asking which frame heard an event fired over CDP.

import type { ToolResult } from '@bro/shared'
import { bridgeClient } from './bridge-client.js'
import { getBrowserFrames, sendToFrame, type BrowserFrame } from './frames.js'
import { inLivePage, keepLive, stalledState } from './render-state.js'
import { describeNode, refNode, resolveNamed, withRef } from './tools/accessibility.js'
import { registerTool } from './tool-registry.js'

// frameId is the CDP frame id observe prints; scriptFrame is the
// chrome.scripting frame id a probe resolved it to. Neither means the main frame.
interface InFrame {
  frameId?: string
  scriptFrame?: number
}

export type WatchTarget = InFrame &
  (
    | { kind: 'page' }
    | { kind: 'css'; css: string }
    // A node target pins one element; refId on the first probe, role + name
    // to find its replacement after a re-render.
    | { kind: 'node'; refId?: string; role?: string; name?: string }
  )

export interface WatchCondition {
  kind: 'text' | 'textGone' | 'pattern' | 'state' | 'change' | 'count'
  text?: string
  pattern?: string
  state?: 'visible' | 'hidden' | 'enabled' | 'disabled'
}

/** One evaluation of the condition; the server derives events from these. */
export interface WatchValue {
  at: number
  met?: boolean
  snippet?: string | undefined
  text?: string
  count?: number
  items?: string[]
}

export interface ProbeResult {
  tab: 'live' | 'frozen' | 'discarded' | 'closed'
  url?: string
  // The latch was (re)created by this probe: its earlier records are gone.
  installed?: boolean
  records?: WatchValue[]
  // Records the latch dropped because its buffer was full.
  dropped?: number
  // A node target has no element: not pinned yet, or replaced.
  targetLost?: boolean
  // The role and name a node target was resolved to, for later re-resolution.
  resolved?: { role: string; name: string }
  resolveError?: string
  // The frame this probe resolved the target to, for the next probes.
  frame?: { frameId: string; scriptFrame: number }
  // Condition checks the page ran since it last reported.
  checks?: number
}

interface ProbeCommand {
  watchId: string
  target: WatchTarget
  condition: WatchCondition
  op: 'probe' | 'stop'
  // An act's wait step: its tab is resumed like any act's. A watch only
  // observes, and reports a frozen tab as an event.
  live?: boolean
}

const pinEvent = (watchId: string) => `__bro_watch_pin_${watchId}`
const PUSH = 'BRO_WATCH_PUSH'

// Serialized into the page: everything below must stay self-contained.
function latch(cmd: ProbeCommand, limits: { records: number; snippet: number; text: number; items: number; costFactor: number }, push: string) {
  interface Latch {
    target: WatchTarget
    condition: WatchCondition
    el?: Element
    observer: MutationObserver
    records: WatchValue[]
    dropped: number
    checks: number
    lastKey?: string
    lastEval: number
    lastCost: number
    // A check the cost bound postponed, and whether a push is queued.
    deferred: ReturnType<typeof setTimeout> | undefined
    pushing: boolean
    // The target state the server last heard.
    reportedLost: boolean
    cleanup: () => void
  }
  const scope = globalThis as typeof globalThis & { __broWatches?: Map<string, Latch> }
  const watches = (scope.__broWatches ??= new Map())
  if (cmd.op === 'stop') {
    watches.get(cmd.watchId)?.cleanup()
    watches.delete(cmd.watchId)
    return null
  }
  const n = (s: string) => s.replace(/\s+/g, ' ').trim()
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    return (
      r.width > 0 &&
      r.height > 0 &&
      getComputedStyle(el).visibility === 'visible' &&
      (typeof el.checkVisibility !== 'function' || el.checkVisibility())
    )
  }
  const textOf = (el: Element) => {
    if (el instanceof HTMLInputElement && el.type === 'password') return '[redacted]'
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
      return el.value
    return (el as HTMLElement).innerText ?? el.textContent ?? ''
  }
  const evaluate = (w: Latch): WatchValue => {
    const els =
      w.target.kind === 'page'
        ? document.body ? [document.body] : []
        : w.target.kind === 'css'
          ? [...document.querySelectorAll(w.target.css)]
          : w.el?.isConnected ? [w.el] : []
    const at = Date.now()
    const c = w.condition
    if (c.kind === 'count') {
      const items = els.map((el) => n(textOf(el)).slice(0, limits.snippet))
      return { at, count: els.length, items: items.length > limits.items ? items.slice(-limits.items) : items }
    }
    if (c.kind === 'state') {
      const shown = els.filter(visible)
      const disabled = (el: Element) => el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true'
      const met =
        c.state === 'visible' ? shown.length > 0
        : c.state === 'hidden' ? shown.length === 0
        : c.state === 'enabled' ? shown.some((el) => !disabled(el))
        : shown.some(disabled)
      return { at, met, snippet: shown[0] ? n(textOf(shown[0])).slice(0, limits.snippet) : undefined }
    }
    const hay = n(els.map(textOf).join('\n'))
    if (c.kind === 'change') {
      return { at, text: hay.slice(0, limits.text), count: hay.length }
    }
    // Case-insensitive like the wait step: CSS text-transform changes
    // innerText but not the name a model copies from an observation.
    let index = -1
    let length = 0
    if (c.kind === 'pattern') {
      const m = new RegExp(c.pattern!, 'i').exec(hay)
      if (m) [index, length] = [m.index, m[0].length]
    } else {
      index = hay.toLowerCase().indexOf(n(c.text!).toLowerCase())
      length = n(c.text!).length
    }
    const found = index >= 0
    const half = Math.max(0, Math.floor((limits.snippet - length) / 2))
    const snippet = found ? hay.slice(Math.max(0, index - half), index + length + half) : undefined
    return { at, met: c.kind === 'textGone' ? !found : found, snippet }
  }
  const lost = (w: Latch) => w.target.kind === 'node' && !w.el?.isConnected
  // Takes what the server has not heard yet.
  const report = (w: Latch) => {
    const out = { url: location.href, records: w.records.splice(0), dropped: w.dropped, checks: w.checks, targetLost: lost(w) }
    w.dropped = 0
    w.checks = 0
    w.reportedLost = out.targetLost
    return out
  }
  // Sends the new values of this task in one message, after the task's other
  // mutations; nothing is sent while the value and the target stay the same.
  const schedulePush = (w: Latch) => {
    if (w.pushing) return
    w.pushing = true
    queueMicrotask(() => {
      w.pushing = false
      if (!w.records.length && lost(w) === w.reportedLost) return
      // The extension was reloaded or removed: this latch can never report.
      if (!chrome.runtime?.id) {
        w.cleanup()
        watches.delete(cmd.watchId)
        return
      }
      const heard = w.reportedLost
      const out = report(w)
      // Undelivered: the next push or probe reports it.
      const keep = () => {
        w.records.unshift(...out.records)
        w.dropped += out.dropped
        w.checks += out.checks
        w.reportedLost = heard
      }
      chrome.runtime
        .sendMessage({ type: push, watchId: cmd.watchId, result: { tab: 'live', ...out } })
        .then((reply: { delivered?: boolean } | undefined) => {
          if (!reply?.delivered) keep()
        }, keep)
    })
  }
  // Evaluates and records a new value; the cost of the evaluation bounds how
  // often a mutation may trigger the next one.
  const check = (w: Latch) => {
    const began = performance.now()
    const value = evaluate(w)
    w.checks++
    w.lastEval = performance.now()
    w.lastCost = w.lastEval - began
    const { at: _at, ...rest } = value
    const key = JSON.stringify(rest)
    if (key !== w.lastKey) {
      w.lastKey = key
      w.records.push(value)
      if (w.records.length > limits.records) {
        w.records.shift()
        w.dropped++
      }
    }
    schedulePush(w)
  }
  let w = watches.get(cmd.watchId)
  const installed = !w
  if (!w) {
    const created: Latch = {
      target: cmd.target,
      condition: cmd.condition,
      records: [],
      dropped: 0,
      checks: 0,
      lastEval: 0,
      lastCost: 0,
      deferred: undefined,
      pushing: false,
      reportedLost: false,
      observer: new MutationObserver(() => {
        // innerText lays out, so a large page makes each check costly. Checks
        // run at most every costFactor times the last check's cost: a cheap
        // page sees every mutation batch, a costly one at most 1/costFactor of
        // its main thread. A postponed check runs when the bound allows, so a
        // change that persists is still pushed; only a transient can be
        // missed. Background tabs align that timer to about a second.
        const wait = created.lastEval + limits.costFactor * created.lastCost - performance.now()
        if (wait <= 0) {
          if (created.deferred !== undefined) clearTimeout(created.deferred)
          created.deferred = undefined
          check(created)
        } else
          created.deferred ??= setTimeout(() => {
            created.deferred = undefined
            check(created)
          }, wait)
      }),
      cleanup: () => {},
    }
    const onInput = () => check(created)
    const onPin = (event: Event) => {
      created.el = event.composedPath()[0] as Element
    }
    created.observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled', 'aria-hidden', 'open', 'value'],
    })
    // Typing changes a control's value without a DOM mutation.
    document.addEventListener('input', onInput, true)
    document.addEventListener('change', onInput, true)
    // Capture phase: the pin event does not bubble, so the page never sees it
    // propagate, but capture listeners on the document still run.
    document.addEventListener(`__bro_watch_pin_${cmd.watchId}`, onPin, true)
    created.cleanup = () => {
      if (created.deferred !== undefined) clearTimeout(created.deferred)
      created.observer.disconnect()
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('change', onInput, true)
      document.removeEventListener(`__bro_watch_pin_${cmd.watchId}`, onPin, true)
    }
    watches.set(cmd.watchId, created)
    w = created
  }
  check(w)
  return { installed, ...report(w) }
}

const LIMITS = { records: 50, snippet: 160, text: 4000, items: 200, costFactor: 4 }

function inPage(tabId: number, frameId: number, cmd: ProbeCommand) {
  const injection: chrome.scripting.ScriptInjection<[ProbeCommand, typeof LIMITS, string], ReturnType<typeof latch>> = {
    target: { tabId, frameIds: [frameId] }, world: 'ISOLATED', func: latch, args: [cmd, LIMITS, PUSH],
  }
  return (cmd.live ? inLivePage(injection) : chrome.scripting.executeScript(injection))
    .then(([frame]) => frame?.result as ReturnType<typeof latch> | undefined)
    .catch((error: unknown) => {
      if (frameId !== 0 && /No frame with id/i.test(String(error)))
        throw new Error(`the watched frame is gone (its page navigated or removed it); start a new watch on the current frame`)
      throw error
    })
}

// The chrome.scripting frame id of a CDP frame. Every frame bro can script
// arms a one-shot listener; the target frame then fires the event over CDP,
// and exactly one frame reports hearing it. Exact even when sibling frames
// share a URL, which matching by URL is not.
async function locateFrame(tabId: number, frame: BrowserFrame): Promise<number> {
  if (!frame.parentId) return 0
  const type = `__bro_frame_${crypto.randomUUID().replaceAll('-', '')}`
  type Scope = typeof globalThis & { __broFrameProbe?: { type: string; heard: boolean; stop: () => void } }
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'ISOLATED',
    func: (type: string) => {
      const scope = globalThis as Scope
      scope.__broFrameProbe?.stop()
      const probe = { type, heard: false, stop: () => document.removeEventListener(type, hear, true) }
      const hear = () => {
        probe.heard = true
      }
      document.addEventListener(type, hear, true)
      scope.__broFrameProbe = probe
    },
    args: [type],
  })
  const world = await sendToFrame<{ executionContextId: number }>(tabId, frame, 'Page.createIsolatedWorld', {
    frameId: frame.id,
    worldName: 'bro-frame-probe',
    grantUniveralAccess: false,
  })
  await sendToFrame(tabId, frame, 'Runtime.evaluate', {
    contextId: world.executionContextId,
    expression: `document.dispatchEvent(new CustomEvent(${JSON.stringify(type)}))`,
  })
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'ISOLATED',
    func: (type: string) => {
      const scope = globalThis as Scope
      const probe = scope.__broFrameProbe
      if (probe?.type !== type) return false
      probe.stop()
      delete scope.__broFrameProbe
      return probe.heard
    },
    args: [type],
  })
  const hits = results.filter((r) => r.result === true)
  if (hits.length !== 1)
    throw new Error(`cannot script frame ${frame.id} (${frame.url}): ${hits.length} frames answered`)
  return hits[0]!.frameId
}

async function cdpFrame(tabId: number, frameId: string): Promise<BrowserFrame> {
  const frame = (await getBrowserFrames(tabId)).find((f) => f.id === frameId)
  if (!frame) throw new Error(`frame ${frameId} not found; observe to read current frame IDs`)
  return frame
}

// Points the latch at the element a ref names. The latch must already run in
// the ref's frame, where the element dispatches the pin event.
async function pin(tabId: number, watchId: string, ref: string): Promise<void> {
  await withRef(
    tabId,
    ref,
    function (this: Element, type: string) {
      this.dispatchEvent(new CustomEvent(type))
    },
    [pinEvent(watchId)],
  )
}

export async function probe(tabId: number, cmd: ProbeCommand & { resolve?: boolean }): Promise<ProbeResult> {
  let stalled: Awaited<ReturnType<typeof stalledState>>
  try {
    if (cmd.live) await keepLive(tabId)
    stalled = await stalledState(tabId)
  } catch (error) {
    if (/No tab with id/i.test(String(error))) return { tab: 'closed' }
    throw error
  }
  if (stalled) return { tab: stalled }
  const target = cmd.target
  let scriptFrame = target.scriptFrame
  let located: ProbeResult['frame']
  if (scriptFrame === undefined && cmd.op === 'probe') {
    // A ref names its own frame; otherwise frameId does, or the main frame.
    const frame =
      target.kind === 'node' && target.refId
        ? (await refNode(tabId, target.refId)).frame
        : target.frameId !== undefined
          ? await cdpFrame(tabId, target.frameId)
          : undefined
    scriptFrame = frame ? await locateFrame(tabId, frame) : 0
    if (frame) located = { frameId: frame.id, scriptFrame }
  }
  if (cmd.op === 'stop') {
    active.delete(cmd.watchId)
    await inPage(tabId, scriptFrame ?? 0, cmd)
    return { tab: 'live' }
  }
  const frameId = scriptFrame!
  active.set(cmd.watchId, { tabId, frameId, cmd: { watchId: cmd.watchId, op: 'probe', condition: cmd.condition, target: { ...target, scriptFrame: frameId } } })
  let page = await inPage(tabId, frameId, cmd)
  if (!page) throw new Error('watch probe returned no result from the page')
  const result: ProbeResult = { tab: 'live', url: page.url, installed: page.installed, records: page.records }
  if (page.checks) result.checks = page.checks
  if (located) result.frame = located
  if (page.dropped) result.dropped = page.dropped
  if (page.targetLost && target.kind === 'node') {
    if (cmd.resolve) {
      try {
        const ref =
          target.refId ?? (await resolveNamed(tabId, target.role!, target.name!, located?.frameId ?? target.frameId))
        await pin(tabId, cmd.watchId, ref)
        result.resolved = await describeNode(tabId, ref)
        const pinned = await inPage(tabId, frameId, cmd)
        if (!pinned) throw new Error('watch probe returned no result from the page')
        result.records!.push(...pinned.records)
        result.url = pinned.url
        result.checks = (result.checks ?? 0) + pinned.checks
        page = pinned
      } catch (error) {
        result.resolveError = error instanceof Error ? error.message : String(error)
      }
    }
    result.targetLost = page.targetLost
  }
  return result
}

// The watches this worker has probed, to reinstall their latches after a
// navigation. A worker restart forgets them; the next heartbeat probe
// reinstalls the latch and the entry.
const active = new Map<string, { tabId: number; frameId: number; cmd: ProbeCommand }>()

function sendEvent(watchId: string, tabId: number, result: ProbeResult): boolean {
  if (!bridgeClient.isConnected) return false
  bridgeClient.send({ type: 'watch_event', watchId, tabId, result: result as unknown as Record<string, unknown> })
  return true
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const m = message as { type?: unknown; watchId?: unknown; result?: unknown } | null
  if (m?.type !== PUSH) return false
  const tabId = sender.tab?.id
  const watch = typeof m.watchId === 'string' ? active.get(m.watchId) : undefined
  // Only the latch of a watch this worker knows, in its own tab and frame.
  // An unknown watch (a worker restart) is left for the next probe.
  const ok = sender.id === chrome.runtime.id && watch !== undefined && watch.tabId === tabId && watch.frameId === sender.frameId
  sendResponse({ delivered: ok && sendEvent(watch.cmd.watchId, watch.tabId, m.result as ProbeResult) })
  return false
})

// A new document has no latch. Reinstalling it reports the new page's value
// and URL; the server reports the navigation and re-pins a node target.
chrome.webNavigation.onDOMContentLoaded.addListener(({ tabId, frameId }) => {
  for (const watch of active.values()) {
    if (watch.tabId !== tabId || watch.frameId !== frameId) continue
    void inPage(tabId, frameId, watch.cmd).then(
      (page) => {
        if (page) sendEvent(watch.cmd.watchId, tabId, { tab: 'live', ...page })
      },
      () => {
        // The heartbeat probe reports what failed.
      },
    )
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [id, watch] of active) {
    if (watch.tabId !== tabId) continue
    active.delete(id)
    sendEvent(id, tabId, { tab: 'closed' })
  }
})

registerTool('watch_probe', async (tabId, raw): Promise<ToolResult> => {
  const result = await probe(tabId, raw as ProbeCommand & { resolve?: boolean })
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
})
