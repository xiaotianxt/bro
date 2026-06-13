const BROWSER_INTERNAL_PROTOCOLS = new Set([
  'chrome:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
])

export function getUnsupportedDebuggerTargetReason(
  tabUrl: string | undefined,
  ownExtensionId: string,
): string | undefined {
  if (!tabUrl) return undefined

  let parsed: URL
  try {
    parsed = new URL(tabUrl)
  } catch {
    return undefined
  }

  if (
    parsed.protocol === 'chrome-extension:' &&
    parsed.hostname !== ownExtensionId
  ) {
    return 'target is a page from another extension'
  }

  if (BROWSER_INTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return 'target is a browser-internal page'
  }

  return undefined
}

export async function getDebuggerTargetBlockReason(
  tabId: number,
): Promise<string | undefined> {
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return undefined
  }

  return getUnsupportedDebuggerTargetReason(tab.url, chrome.runtime.id)
}
