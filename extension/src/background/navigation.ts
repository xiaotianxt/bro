import { cdpSession } from './cdp.js'
import { getUnsupportedDebuggerTargetReason } from './debug-target.js'

interface NavigationResult { frameId: string; loaderId?: string; errorText?: string; isDownload?: boolean }
interface MainFrame { id: string; loaderId: string; url: string; urlFragment?: string }

// The navigation was dispatched and may still finish: the tab is intact, only
// readiness is unproven. Distinct from failures that leave no usable document.
export class ReadinessTimeout extends Error {
  constructor() {
    super('Navigation did not reach DOMContentLoaded within 10000ms')
    this.name = 'ReadinessTimeout'
  }
}

// Own readiness where navigation is dispatched, not in dependent evaluation.
// DOMContentLoaded is document-specific and does not require global network idle.
export async function navigateDocument(tabId: number, url: string): Promise<string> {
  const tab = await chrome.tabs.get(tabId)
  if (getUnsupportedDebuggerTargetReason(tab.url, chrome.runtime.id) === 'target is a browser-internal page') {
    const destination = new URL(url)
    if (['http:', 'https:'].includes(destination.protocol) || url === 'about:blank') {
      return navigateFromInternalPage(tabId, destination.href)
    }
  }
  return navigateWithDebugger(tabId, url)
}

async function navigateWithDebugger(tabId: number, url: string): Promise<string> {
  await cdpSession.send(tabId, 'Page.enable')
  const readyDocuments = new Set<string>()
  let navigation: { frameId: string; loaderId: string } | undefined
  let settled = false
  let checking = false
  let resolve!: (url: string) => void
  let reject!: (error: unknown) => void
  const completion = new Promise<string>((yes, no) => { resolve = yes; reject = no })
  const fail = (error: unknown): void => { settled = true; reject(error) }
  const check = (): void => {
    if (settled || checking || !navigation) return
    if (!readyDocuments.has(`${navigation.frameId}:${navigation.loaderId}`)) return
    checking = true
    void cdpSession.send<{ frameTree: { frame: MainFrame } }>(tabId, 'Page.getFrameTree').then(({ frameTree }) => {
      if (settled) return
      const frame = frameTree.frame
      if (frame.id !== navigation!.frameId || frame.loaderId !== navigation!.loaderId) {
        fail(new Error('Navigation was superseded before its document became ready'))
        return
      }
      settled = true
      resolve(frame.url + (frame.urlFragment ?? ''))
    }, fail)
  }
  const offLifecycle = cdpSession.onEvent(tabId, 'Page.lifecycleEvent', (raw) => {
    const event = raw as { name: string; frameId: string; loaderId: string }
    if (event.name !== 'DOMContentLoaded') return
    readyDocuments.add(`${event.frameId}:${event.loaderId}`)
    check()
  })
  const offDetach = cdpSession.onDetach((id) => {
    if (id === tabId) fail(new Error('Navigation interrupted: debugger detached or tab closed'))
  })
  const timer = setTimeout(() => fail(new ReadinessTimeout()), 10000)
  // Listeners precede lifecycle enablement and dispatch, including cached pages.
  void (async () => {
    await cdpSession.send(tabId, 'Page.setLifecycleEventsEnabled', { enabled: true })
    const { frameTree } = await cdpSession.send<{ frameTree: { frame: MainFrame } }>(tabId, 'Page.getFrameTree')
    if (settled) return
    const initial = frameTree.frame
    const result = await cdpSession.send<NavigationResult>(tabId, 'Page.navigate', { url })
    if (settled) return
    if (result.errorText || result.isDownload) throw new Error(result.errorText ?? 'Navigation started a download, not a ready document')
    // A loader-less response preserves the *existing* document, not whichever
    // document happens to occupy this frame when verification eventually runs.
    navigation = { frameId: result.frameId, loaderId: result.loaderId ?? initial.loaderId }
    if (!result.loaderId) {
      if (result.frameId !== initial.id) throw new Error('Same-document navigation changed its main frame')
      // "interactive" alone is not DOMContentLoaded: deferred scripts may
      // still be running. Use the recorded milestone for an already-ready page.
      const state = await cdpSession.send<{ result: { value?: boolean } }>(tabId, 'Runtime.evaluate', {
        expression: 'document.readyState === "complete" || (performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? 0) > 0',
        returnByValue: true,
      })
      if (settled) return
      if (state.result.value === true) {
        readyDocuments.add(`${navigation.frameId}:${navigation.loaderId}`)
      }
    }
    check()
  })().catch(fail)
  try {
    return await completion
  } finally {
    clearTimeout(timer)
    offLifecycle()
    offDetach()
  }
}

// Internal source pages cannot be attached to. Navigate with the tabs API and
// establish destination readiness with webNavigation's document IDs instead.
// Debugger access rules remain unchanged; this path never attaches internally.
function navigateFromInternalPage(tabId: number, url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let started = false
    let committed: string | undefined
    const ready = new Set<string>()
    let settled = false
    let checking = false
    const dispose = (): void => {
      clearTimeout(timer)
      chrome.webNavigation.onBeforeNavigate.removeListener(onBeforeNavigate)
      chrome.webNavigation.onCommitted.removeListener(onCommitted)
      chrome.webNavigation.onDOMContentLoaded.removeListener(onReady)
      chrome.webNavigation.onErrorOccurred.removeListener(onError)
      chrome.tabs.onRemoved.removeListener(onRemoved)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      dispose()
      reject(error)
    }
    const check = (): void => {
      if (settled || checking || !committed || !ready.has(committed)) return
      checking = true
      void chrome.webNavigation.getFrame({ tabId, frameId: 0 }).then((frame) => {
        if (settled) return
        if (!frame || frame.documentId !== committed) {
          fail(new Error('Navigation was superseded before its document became ready'))
          return
        }
        settled = true
        dispose()
        resolve(frame.url)
      }, fail)
    }
    const onBeforeNavigate = (event: chrome.webNavigation.WebNavigationBaseCallbackDetails): void => {
      if (event.tabId === tabId && event.frameId === 0 && event.url === url) started = true
    }
    const onCommitted = (event: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void => {
      if (!started || event.tabId !== tabId || event.frameId !== 0) return
      if (committed && committed !== event.documentId) {
        fail(new Error('Navigation was superseded before its document became ready'))
        return
      }
      committed = event.documentId
      check()
    }
    const onReady = (event: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
      if (event.tabId !== tabId || event.frameId !== 0) return
      ready.add(event.documentId)
      check()
    }
    const onError = (event: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails): void => {
      if (started && event.tabId === tabId && event.frameId === 0) fail(new Error(`Navigation failed: ${event.error}`))
    }
    const onRemoved = (id: number): void => {
      if (id === tabId) fail(new Error('Navigation interrupted: tab closed'))
    }
    const timer = setTimeout(() => fail(new ReadinessTimeout()), 10000)
    chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate)
    chrome.webNavigation.onCommitted.addListener(onCommitted)
    chrome.webNavigation.onDOMContentLoaded.addListener(onReady)
    chrome.webNavigation.onErrorOccurred.addListener(onError)
    chrome.tabs.onRemoved.addListener(onRemoved)
    void chrome.tabs.update(tabId, { url }).catch(fail)
  })
}
