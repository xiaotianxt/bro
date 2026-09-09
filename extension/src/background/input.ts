import { cdpSession } from './cdp.js'

// All trusted input paths share this invariant, not only the computer tool.
export async function prepareInput(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true })
  if (!tab) throw new Error(`Tab ${tabId} disappeared while preparing input`)
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
  await cdpSession.send(tabId, 'Page.bringToFront', {})
}
