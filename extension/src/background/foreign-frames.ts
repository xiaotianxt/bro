// Chromium refuses chrome.debugger on a tab while any of its frames shows
// another extension's page, and closes a live session the moment such a frame
// is created. Password managers insert exactly that: 1Password's inline menu,
// save prompt and modal are iframes of its own pages inside closed shadow roots.
//
// bro removes those iframes and leaves their host elements in place. 1Password
// keeps its iframe reference and reuses it, so later redraws in the same
// document set src on a detached iframe and create no frame: the session stays
// attached while the agent clicks and types into login fields. The extension
// stays enabled and keeps working elsewhere; reloading or navigating the page
// restores its in-page UI there.

export function isForeignExtensionRejection(browserMessage: string): boolean {
  return browserMessage.includes('Cannot access a chrome-extension:// URL of different extension')
}

/** Removes other extensions' iframes from every frame of the tab; returns how many. */
export async function removeForeignExtensionFrames(tabId: number): Promise<number> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'ISOLATED',
    injectImmediately: true,
    func: removeFrames,
    args: [chrome.runtime.id],
  })
  // A frame that produced no result (e.g. it navigated away) removed nothing.
  return results.reduce((sum, frame) => sum + (frame.result ?? 0), 0)
}

// Serialized into each frame by executeScript: must stay self-contained.
function removeFrames(ownId: string): number {
  const own = `chrome-extension://${ownId}/`
  let removed = 0
  const visit = (root: Document | ShadowRoot) => {
    for (const element of root.querySelectorAll('*')) {
      if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) {
        if (element.src.startsWith('chrome-extension://') && !element.src.startsWith(own)) {
          element.remove()
          removed++
        }
        continue
      }
      // Extension UI lives in closed shadow roots the page itself cannot see.
      const shadow = element instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(element) : null
      if (shadow) visit(shadow)
    }
  }
  visit(document)
  return removed
}
