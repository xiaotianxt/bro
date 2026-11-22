// Chrome produces no frames for a tab that is not shown, so
// requestAnimationFrame and IntersectionObserver never run there and lazy
// feeds (YouTube's home grid) stay skeletons. A screenshot forces one frame
// without activating the tab or changing focus. bro pumps frames for the
// tabs it created while render-state.ts says they are hidden, which includes
// an active tab in an occluded window, at a rate that serves lazy loading, not
// animation.
//
// The tab set lives in session storage so a restarted service worker resumes
// pumping tabs that are still open.

import { cdpSession } from './cdp.js'
import { renderState } from './render-state.js'

const PUMP_MS = 250
const STORAGE_KEY = 'render_pump_tabs'

const tabs = new Set<number>()
const inFlight = new Set<number>()
let timer: ReturnType<typeof setInterval> | undefined
let listening = false

export function keepRendering(tabId: number): void {
  listen()
  tabs.add(tabId)
  void persist()
  timer ??= setInterval(tick, PUMP_MS)
}

/** Whether bro is pumping frames into this (hidden) tab. */
export function isRendering(tabId: number): boolean {
  return tabs.has(tabId)
}

export async function restoreRenderPump(): Promise<void> {
  const stored = await chrome.storage.session.get(STORAGE_KEY)
  const ids = stored[STORAGE_KEY] as number[] | undefined
  if (!ids?.length) return
  const open = new Set((await chrome.tabs.query({})).map((tab) => tab.id))
  for (const id of ids) if (open.has(id)) keepRendering(id)
  await persist()
}

function listen(): void {
  if (listening) return
  listening = true
  chrome.tabs.onRemoved.addListener(stop)
}

function stop(tabId: number): void {
  if (!tabs.delete(tabId)) return
  void persist()
  if (tabs.size === 0 && timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

async function persist(): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEY]: [...tabs] })
}

function tick(): void {
  for (const tabId of tabs) {
    if (inFlight.has(tabId)) continue
    inFlight.add(tabId)
    void pump(tabId).finally(() => inFlight.delete(tabId))
  }
}

async function pump(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    // Closed between ticks; onRemoved drops it.
    return
  }
  // Debugger access starts at a web document.
  if (!/^https?:/.test(tab.url ?? '')) return
  try {
    // Only a hidden live tab needs a forced frame: a painting tab renders by
    // itself, and a frozen or discarded one draws nothing for a capture.
    // Active is not painting: an active tab in an occluded window is hidden.
    // Caller-bound, as the capture below and for the same reason.
    if ((await renderState(tabId, 'caller')) !== 'hidden') return
    // No clip: a clipped capture resizes the viewport while it runs, which
    // races hit tests of concurrent clicks.
    // The reply waits for the renderer to draw a frame, which a busy renderer
    // delays past the session timeout (a large AX tree read takes seconds).
    // A session-bound timeout would detach the tab under that read, so this
    // is caller-bound. inFlight leaves at most one waiting capture per tab,
    // and a detach rejects it.
    await cdpSession.send(
      tabId,
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 1, optimizeForSpeed: true },
      'caller',
    )
  } catch (error) {
    // Navigation and closing race the pump; the next tick retries.
    console.debug(`[RenderPump] tab ${tabId}:`, error)
  }
}
