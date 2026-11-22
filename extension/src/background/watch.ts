// One probe of a watch the Go server owns. The server decides when to probe
// (its own clock, never a page timer, which Chrome throttles in background
// tabs) and keeps the last value it saw, so a probe that finds its page state
// gone (a navigation, a re-render, a service worker restart) only loses
// transients, never a change that is still on the page.
//
// The page keeps a latch in the extension's isolated world: a MutationObserver
// that re-evaluates the condition when the DOM changes and records each new
// value, so a change that comes and goes between two probes is still seen.
// MutationObserver callbacks are microtasks, not timers, so throttling does not
// delay them. The latch lives in the extension world, which survives service
// worker restarts and which page scripts cannot reach.
//
// A frozen or discarded tab is reported from Chrome's tab record before any
// script is sent: a frozen page runs no script and would hold the probe.

import type { ToolResult } from '@bro/shared'
import { stalledState } from './render-state.js'
import { describeNode, refNode, resolveNamed, withRef } from './tools/accessibility.js'
import { registerTool } from './tool-registry.js'

export type WatchTarget =
  | { kind: 'page' }
  | { kind: 'css'; css: string }
  // A node target pins one element; refId on the first probe, role + name to
  // find its replacement after a re-render.
  | { kind: 'node'; refId?: string; role?: string; name?: string }

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
}

interface ProbeCommand {
  watchId: string
  target: WatchTarget
  condition: WatchCondition
  op: 'probe' | 'stop'
}

const pinEvent = (watchId: string) => `__bro_watch_pin_${watchId}`

// Serialized into the page: everything below must stay self-contained.
function latch(cmd: ProbeCommand, limits: { records: number; snippet: number; text: number; items: number; costFactor: number }) {
  interface Latch {
    target: WatchTarget
    condition: WatchCondition
    el?: Element
    observer: MutationObserver
    records: WatchValue[]
    dropped: number
    lastKey?: string
    lastEval: number
    lastCost: number
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
  // Evaluates and records a new value; the cost of the evaluation bounds how
  // often a mutation may trigger the next one.
  const check = (w: Latch) => {
    const began = performance.now()
    const value = evaluate(w)
    w.lastEval = performance.now()
    w.lastCost = w.lastEval - began
    const { at: _at, ...rest } = value
    const key = JSON.stringify(rest)
    if (key === w.lastKey) return
    w.lastKey = key
    w.records.push(value)
    if (w.records.length > limits.records) {
      w.records.shift()
      w.dropped++
    }
  }
  let w = watches.get(cmd.watchId)
  const installed = !w
  if (!w) {
    const created: Latch = {
      target: cmd.target,
      condition: cmd.condition,
      records: [],
      dropped: 0,
      lastEval: 0,
      lastCost: 0,
      observer: new MutationObserver(() => {
        // innerText lays out, so a large page makes each check costly. Checks
        // run at most every costFactor times the last check's cost: a cheap
        // page sees every mutation batch, a costly one at most 1/costFactor of
        // its main thread. The probe checks regardless, so a skipped mutation
        // that persists is still seen; only a transient can be missed.
        if (performance.now() - created.lastEval >= limits.costFactor * created.lastCost) check(created)
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
      created.observer.disconnect()
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('change', onInput, true)
      document.removeEventListener(`__bro_watch_pin_${cmd.watchId}`, onPin, true)
    }
    watches.set(cmd.watchId, created)
    w = created
  }
  check(w)
  const records = w.records.splice(0)
  const dropped = w.dropped
  w.dropped = 0
  return {
    installed,
    url: location.href,
    records,
    dropped,
    targetLost: w.target.kind === 'node' && !w.el?.isConnected,
  }
}

const LIMITS = { records: 50, snippet: 160, text: 4000, items: 200, costFactor: 4 }

function inPage(tabId: number, cmd: ProbeCommand) {
  return chrome.scripting
    .executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: latch, args: [cmd, LIMITS] })
    .then(([frame]) => frame?.result as ReturnType<typeof latch> | undefined)
}

// Points the page latch at the element a ref names. Main frame only: the latch
// lives in the main frame's document.
async function pin(tabId: number, watchId: string, ref: string): Promise<void> {
  const { frame } = await refNode(tabId, ref)
  if (frame.parentId) throw new Error(`watch targets main-frame elements only; ${ref} is in a child frame`)
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
    stalled = await stalledState(tabId)
  } catch (error) {
    if (/No tab with id/i.test(String(error))) return { tab: 'closed' }
    throw error
  }
  if (stalled) return { tab: stalled }
  if (cmd.op === 'stop') {
    await inPage(tabId, cmd)
    return { tab: 'live' }
  }
  let page = await inPage(tabId, cmd)
  if (!page) throw new Error('watch probe returned no result from the page')
  const result: ProbeResult = { tab: 'live', url: page.url, installed: page.installed, records: page.records }
  if (page.dropped) result.dropped = page.dropped
  if (page.targetLost && cmd.target.kind === 'node') {
    if (cmd.resolve) {
      try {
        const ref = cmd.target.refId ?? (await resolveNamed(tabId, cmd.target.role!, cmd.target.name!))
        await pin(tabId, cmd.watchId, ref)
        result.resolved = await describeNode(tabId, ref)
        const pinned = await inPage(tabId, cmd)
        if (!pinned) throw new Error('watch probe returned no result from the page')
        result.records!.push(...pinned.records)
        result.url = pinned.url
        page = pinned
      } catch (error) {
        result.resolveError = error instanceof Error ? error.message : String(error)
      }
    }
    result.targetLost = page.targetLost
  }
  return result
}

registerTool('watch_probe', async (tabId, raw): Promise<ToolResult> => {
  const result = await probe(tabId, raw as ProbeCommand & { resolve?: boolean })
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
})
