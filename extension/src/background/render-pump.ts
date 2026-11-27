// Chrome produces no frames for a tab that is not shown, so
// requestAnimationFrame and IntersectionObserver never run there and lazy
// feeds (YouTube's home grid) stay skeletons. A screenshot forces one frame
// without activating the tab or changing focus. bro pumps frames for the
// tabs it created while render-state.ts says they are hidden, which includes
// an active tab in an occluded window, at a rate that serves lazy loading, not
// animation.
//
// Chrome draws every tab's forced frame through one shared path, so captures
// in flight at once slow each other and everything else that waits for a
// frame: an action's own composited frame and the input it dispatches. The
// pump is background work and takes at most MAX_CAPTURES turns on that path,
// handed out oldest first; with more hidden tabs each tab gets frames less
// often, and an action still takes what it takes with one tab open.
//
// The tab set lives in session storage so a restarted service worker resumes
// pumping tabs that are still open.

import { cdpSession } from './cdp.js'
import { renderState } from './render-state.js'

const PUMP_MS = 250
const STORAGE_KEY = 'render_pump_tabs'

// Measured with 12 to 15 hidden tabs under four concurrent agents: unbounded,
// 3 to 9 captures were in flight at 150-280 ms each and a click took 250-1200
// ms to dispatch; at 2 a capture takes about 60 ms and a click 150-300 ms, for
// the same captures per second. At 1 the pump draws about half as many frames.
const MAX_CAPTURES = 2
// A capture this late waits on its own renderer (a multi-second AX read, a
// busy main thread), not on the shared path. It gives its turn back so busy
// tabs cannot stop the pump for the others.
const LATE_MS = 1_000

const tabs = new Set<number>()
// A tab is in here from its tick until its capture replied, whether it is
// reading render state, waiting for a turn, capturing, or late.
const inFlight = new Set<number>()
let capturing = 0
const waiting: (() => void)[] = []
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

/** Resolves once the caller may capture, with the function that gives the turn back. */
function captureTurn(): Promise<() => void> {
  const take = () => {
    capturing++
    let held = true
    return () => {
      if (!held) return
      held = false
      capturing--
      waiting.shift()?.()
    }
  }
  if (capturing < MAX_CAPTURES) return Promise.resolve(take())
  return new Promise((resolve) => waiting.push(() => resolve(take())))
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
    if ((await renderState(tabId)) !== 'hidden') return
    // No clip: a clipped capture resizes the viewport while it runs, which
    // races hit tests of concurrent clicks. inFlight leaves at most one
    // waiting capture per tab, and a detach rejects it. cdp.ts sends it after
    // any capture already running in the tab.
    const giveBack = await captureTurn()
    const late = setTimeout(giveBack, LATE_MS)
    try {
      await cdpSession.send(
        tabId,
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 1, optimizeForSpeed: true },
      )
    } finally {
      clearTimeout(late)
      giveBack()
    }
  } catch (error) {
    // Navigation and closing race the pump; the next tick retries.
    console.debug(`[RenderPump] tab ${tabId}:`, error)
  }
}
