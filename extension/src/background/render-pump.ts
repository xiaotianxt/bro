// Chrome produces no frames for a tab that is not shown, so
// requestAnimationFrame and IntersectionObserver never run there and lazy
// feeds (YouTube's home grid) stay skeletons. A screenshot forces one frame
// without activating the tab or changing focus. bro pumps frames for the
// background tabs it created, at a rate that serves lazy loading, not animation.
//
// The tab set lives in session storage so a restarted service worker resumes
// pumping tabs that are still open.

import { cdpSession } from './cdp.js'

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
  // A shown tab renders by itself; debugger access starts at a web document.
  if (tab.active || !/^https?:/.test(tab.url ?? '')) return
  try {
    // No clip: a clipped capture resizes the viewport while it runs, which
    // races hit tests of concurrent clicks.
    await cdpSession.send(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 1,
      optimizeForSpeed: true,
    })
  } catch (error) {
    // Navigation and closing race the pump; the next tick retries.
    console.debug(`[RenderPump] tab ${tabId}:`, error)
  }
}
