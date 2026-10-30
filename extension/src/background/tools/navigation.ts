// Navigation tool — handles URL navigation and window resizing.

import type { ToolResult } from '@bro/shared'
import { registerTool } from '../tool-registry.js'
import { navigateDocument } from '../navigation.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NavigateArgs =
  | { url: string; direction?: never }
  | { direction: 'back' | 'forward'; url?: never }

interface ResizeWindowArgs {
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateNavigateArgs(args: unknown): NavigateArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('navigate: args must be an object')
  }

  const a = args as Record<string, unknown>

  if (a['url'] !== undefined && typeof a['url'] !== 'string') {
    throw new Error('navigate: "url" must be a string')
  }

  if (a['direction'] !== undefined) {
    const dir = a['direction']
    if (dir !== 'back' && dir !== 'forward') {
      throw new Error('navigate: "direction" must be "back" or "forward"')
    }
  }

  if (a['url'] === undefined && a['direction'] === undefined) {
    throw new Error('navigate: either "url" or "direction" must be provided')
  }

  if (a['url'] !== undefined) {
    return { url: a['url'] as string }
  }
  return { direction: a['direction'] as 'back' | 'forward' }
}

function validateResizeWindowArgs(args: unknown): ResizeWindowArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('resize_window: args must be an object')
  }

  const a = args as Record<string, unknown>

  if (typeof a['width'] !== 'number') {
    throw new Error('resize_window: "width" must be a number')
  }

  if (typeof a['height'] !== 'number') {
    throw new Error('resize_window: "height" must be a number')
  }

  return {
    width: a['width'],
    height: a['height'],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Waits for the given tab to finish loading (status === 'complete').
 * Times out after 30 seconds.
 */
function waitForTabComplete(tabId: number, dispatch: () => Promise<void>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const TIMEOUT_MS = 30_000

    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error(`navigate: tab ${tabId} did not finish loading within ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (updatedTabId !== tabId) return
      if (changeInfo.status === 'complete') {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve(tab.url ?? '')
      }
    }

    chrome.tabs.onUpdated.addListener(listener)
    void dispatch().catch((error) => {
      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(listener)
      reject(error)
    })
  })
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function executeNavigate(tabId: number, rawArgs: unknown): Promise<ToolResult> {
  const args = validateNavigateArgs(rawArgs)

  if (args.url !== undefined) {
    const finalUrl = await navigateDocument(tabId, args.url)
    const displayUrl = finalUrl || args.url
    return {
      content: [{ type: 'text', text: `Navigated to ${displayUrl}` }],
    }
  }

  const finalUrl = await waitForTabComplete(tabId, () =>
    args.direction === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId),
  )

  // Get the tab's current URL if waitForTabComplete didn't provide one
  let displayUrl = finalUrl
  if (!displayUrl) {
    const tab = await chrome.tabs.get(tabId)
    displayUrl = tab.url ?? ''
  }

  return {
    content: [{ type: 'text', text: `Navigated to ${displayUrl}` }],
  }
}

async function executeResizeWindow(tabId: number, rawArgs: unknown): Promise<ToolResult> {
  const args = validateResizeWindowArgs(rawArgs)

  // Get the window ID from the tab
  const tab = await chrome.tabs.get(tabId)
  if (tab.windowId === undefined) {
    throw new Error('resize_window: could not determine window ID for tab')
  }

  await chrome.windows.update(tab.windowId, {
    width: args.width,
    height: args.height,
  })

  return {
    content: [
      { type: 'text', text: `Window resized to ${args.width}x${args.height}` },
    ],
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool('navigate', executeNavigate)
registerTool('resize_window', executeResizeWindow)
