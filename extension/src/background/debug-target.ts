import { isForeignExtensionRejection } from './foreign-frames.js'

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

export function formatDebuggerAttachError(tabId: number, browserMessage: string): string {
  const original = `CDP attach failed for tab ${tabId}: ${browserMessage}`
  if (!isForeignExtensionRejection(browserMessage)) return original
  return `${original}\n[CDP_FOREIGN_EXTENSION] Another extension's page is embedded in this tab, so Chromium refuses debugger access; screenshots and coordinate input use the same attach. This is not an MCP disconnect. bro already removed the other extensions' iframes it could reach in the page and retried, so this frame is out of its reach.\nFor authorized username/password login, discover \"1Password login\" tools: login_form_inspect works without CDP; onepassword_find_logins matches saved origins, then onepassword_fill_login privately fills the selected item without submitting. That path needs no extension pause. If login needs passkeys or native approval, keep it enabled and use the authorized native-UI workflow; ask the user for unlock/MFA only when needed.\nOtherwise discover \"CDP extension recovery\" tools (Pi: bro_search_tools): debugger_diagnose on this tab, extensions_status on the same browserId. Only with explicit user authorization for the exact extension and profile-wide impact, use extensions_pause, then extensions_resume with the returned token and verify extensions_status. Do not automatically disable extensions, refresh unsaved pages, or replay input.\nIf these tools are unavailable, use bro Settings > Temporary extension pause or upgrade the matching server/extension; do not retry indefinitely.`
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
