// Tab management tools — tabs_context, tabs_create, tabs_context_mcp, tabs_create_mcp

import type { ToolResult } from '@bro/shared'
import { registerTool } from '../tool-registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TabsCreateArgs {
  active?: boolean
  windowId?: number
  url?: string
}

interface TabsMcpArgs {
  sessionId?: string
  tabId?: number
}

interface TabsCreateMcpArgs extends TabsMcpArgs {
  active?: boolean
  url?: string
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

const SESSION_GROUP_KEY_PREFIX = 'session_group_'

function sessionGroupKey(sessionId: string): string {
  return `${SESSION_GROUP_KEY_PREFIX}${sessionId}`
}

/**
 * Read the tab group ID for a given MCP session from chrome.storage.session.
 */
async function getSessionGroupId(sessionId: string): Promise<number | undefined> {
  const key = sessionGroupKey(sessionId)
  const result = await chrome.storage.session.get(key)
  const value: unknown = result[key]
  if (typeof value === 'number') return value
  return undefined
}

/**
 * Store the tab group ID for a given MCP session in chrome.storage.session.
 */
async function setSessionGroupId(sessionId: string, groupId: number): Promise<void> {
  const key = sessionGroupKey(sessionId)
  await chrome.storage.session.set({ [key]: groupId })
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

interface TabsContextArgs {
  all?: boolean
  tabId?: number
}

function validateTabsContextArgs(args: unknown): TabsContextArgs {
  if (typeof args !== 'object' || args === null) {
    return {}
  }
  const a = args as Record<string, unknown>
  const result: TabsContextArgs = {}
  if (a['all'] !== undefined) {
    if (typeof a['all'] !== 'boolean') {
      throw new Error('tabs_context: "all" must be a boolean')
    }
    result.all = a['all']
  }
  if (a['tabId'] !== undefined) {
    if (typeof a['tabId'] !== 'number' || !Number.isInteger(a['tabId'])) {
      throw new Error('tabs_context: "tabId" must be an integer')
    }
    result.tabId = a['tabId']
  }
  return result
}

function validateTabsCreateArgs(args: unknown): TabsCreateArgs {
  if (typeof args !== 'object' || args === null) {
    return {}
  }
  const a = args as Record<string, unknown>
  const result: TabsCreateArgs = {}
  if (a['active'] !== undefined) {
    if (typeof a['active'] !== 'boolean') {
      throw new Error('tabs_create: "active" must be a boolean')
    }
    result.active = a['active']
  }
  if (a['windowId'] !== undefined) {
    if (typeof a['windowId'] !== 'number' || !Number.isInteger(a['windowId'])) {
      throw new Error('tabs_create: "windowId" must be an integer')
    }
    result.windowId = a['windowId']
  }
  if (a['url'] !== undefined) {
    if (typeof a['url'] !== 'string') {
      throw new Error('tabs_create: "url" must be a string')
    }
    result.url = a['url']
  }
  return result
}

function validateTabsMcpArgs(args: unknown): TabsMcpArgs {
  if (typeof args !== 'object' || args === null) {
    return {}
  }
  const a = args as Record<string, unknown>
  const result: TabsMcpArgs = {}
  if (a['sessionId'] !== undefined) {
    if (typeof a['sessionId'] !== 'string') {
      throw new Error('"sessionId" must be a string')
    }
    result.sessionId = a['sessionId']
  }
  if (a['tabId'] !== undefined) {
    if (typeof a['tabId'] !== 'number' || !Number.isInteger(a['tabId'])) {
      throw new Error('"tabId" must be an integer')
    }
    result.tabId = a['tabId']
  }
  return result
}

function validateTabsCreateMcpArgs(args: unknown): TabsCreateMcpArgs {
  if (typeof args !== 'object' || args === null) {
    return {}
  }
  const a = args as Record<string, unknown>
  const result: TabsCreateMcpArgs = {}
  if (a['sessionId'] !== undefined) {
    if (typeof a['sessionId'] !== 'string') {
      throw new Error('"sessionId" must be a string')
    }
    result.sessionId = a['sessionId']
  }
  if (a['tabId'] !== undefined) {
    if (typeof a['tabId'] !== 'number' || !Number.isInteger(a['tabId'])) {
      throw new Error('"tabId" must be an integer')
    }
    result.tabId = a['tabId']
  }
  if (a['active'] !== undefined) {
    if (typeof a['active'] !== 'boolean') {
      throw new Error('tabs_create_mcp: "active" must be a boolean')
    }
    result.active = a['active']
  }
  if (a['url'] !== undefined) {
    if (typeof a['url'] !== 'string') {
      throw new Error('tabs_create_mcp: "url" must be a string')
    }
    result.url = a['url']
  }
  return result
}

// ---------------------------------------------------------------------------
// Helper: build tab listing text for a set of tabs
// ---------------------------------------------------------------------------

function buildTabListText(
  tabs: chrome.tabs.Tab[],
  activeTabId: number | undefined,
  groupName: string | undefined,
): string {
  const lines: string[] = []

  if (groupName !== undefined) {
    lines.push(`Tab group: ${groupName}`)
  }

  if (activeTabId !== undefined) {
    const activeTab = tabs.find((t) => t.id === activeTabId)
    if (activeTab) {
      lines.push(`Active tab: ${activeTab.url ?? '(no URL)'} (ID: ${activeTab.id ?? 'unknown'})`)
    }
  }

  if (tabs.length > 0) {
    lines.push(`Tabs (${tabs.length}):`)
    for (const tab of tabs) {
      const marker = tab.id === activeTabId ? '*' : ' '
      lines.push(`  ${marker} [${tab.id ?? 'unknown'}] ${tab.url ?? '(no URL)'}`)
    }
  } else {
    lines.push('No tabs in group.')
  }

  return lines.join('\n')
}

async function getActiveTabIdForWindow(windowId: number | undefined): Promise<number | undefined> {
  const queryInfo: chrome.tabs.QueryInfo = { active: true }
  if (windowId !== undefined) {
    queryInfo.windowId = windowId
  } else {
    queryInfo.currentWindow = true
  }
  const activeTabs = await chrome.tabs.query(queryInfo)
  return activeTabs[0]?.id
}

async function getAnchorTab(tabId: number | undefined): Promise<chrome.tabs.Tab> {
  if (tabId !== undefined) {
    return chrome.tabs.get(tabId)
  }

  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const activeTab = activeTabs[0]
  if (!activeTab) {
    throw new Error('No active tab found.')
  }
  return activeTab
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/**
 * tabs_context: Returns info about current tab group and open tabs.
 */
async function getInstanceId(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get({ instance_id: '' }, (items) => {
      void chrome.runtime.lastError
      resolve(typeof items['instance_id'] === 'string' ? items['instance_id'] : '')
    })
  })
}

async function executeTabsContext(_tabId: number, rawArgs: unknown): Promise<ToolResult> {
  const args = validateTabsContextArgs(rawArgs)

  const instanceId = await getInstanceId()
  const browserIdLine = instanceId ? `browserId: ${instanceId}` : ''

  let anchorTab: chrome.tabs.Tab
  try {
    anchorTab = await getAnchorTab(args.tabId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: [browserIdLine, message].filter(Boolean).join('\n') }],
    }
  }

  const windowId = anchorTab.windowId
  const activeTabId = await getActiveTabIdForWindow(windowId)

  if (args.all) {
    // Show all tabs in the anchor tab's window, not whatever window the user
    // happens to have focused now.
    const allTabs = windowId !== undefined
      ? await chrome.tabs.query({ windowId })
      : await chrome.tabs.query({ currentWindow: true })
    const text = [browserIdLine, buildTabListText(allTabs, activeTabId, undefined)].filter(Boolean).join('\n')
    return {
      content: [{ type: 'text', text }],
    }
  }

  const groupId = anchorTab.groupId // -1 means no group

  let groupName: string | undefined
  let groupTabs: chrome.tabs.Tab[]

  if (groupId !== undefined && groupId !== -1) {
    // Tab is in a group — get group info and all tabs in this group
    try {
      const group = await chrome.tabGroups.get(groupId)
      groupName = group.title ?? `Group ${groupId}`
    } catch {
      groupName = `Group ${groupId}`
    }
    groupTabs = await chrome.tabs.query({ groupId })
  } else {
    // No group — just show the anchor tab
    groupTabs = [anchorTab]
  }

  const text = [browserIdLine, buildTabListText(groupTabs, activeTabId, groupName)].filter(Boolean).join('\n')

  return {
    content: [{ type: 'text', text }],
  }
}

/**
 * tabs_create: Creates a new tab.
 */
async function executeTabsCreate(_tabId: number, rawArgs: unknown): Promise<ToolResult> {
  const args = validateTabsCreateArgs(rawArgs)
  const createProperties: chrome.tabs.CreateProperties = {
    url: args.url ?? 'about:blank',
    active: args.active ?? false,
  }
  if (args.windowId !== undefined) {
    createProperties.windowId = args.windowId
  }
  const newTab = await chrome.tabs.create(createProperties)
  return {
    content: [{ type: 'text', text: `Created tab: ${newTab.id ?? 'unknown'}${newTab.windowId !== undefined ? ` (window ${newTab.windowId})` : ''}` }],
  }
}

/**
 * tabs_context_mcp: Like tabs_context but scoped to a session's tab group.
 */
async function executeTabsContextMcp(_tabId: number, rawArgs: unknown): Promise<ToolResult> {
  const args = validateTabsMcpArgs(rawArgs)

  const instanceId = await getInstanceId()
  const browserIdLine = instanceId ? `browserId: ${instanceId}` : ''

  if (!args.sessionId) {
    return {
      content: [{ type: 'text', text: 'No sessionId provided. Cannot determine session tab group.' }],
    }
  }

  const groupId = await getSessionGroupId(args.sessionId)

  if (groupId === undefined) {
    return {
      content: [{ type: 'text', text: `No tab group associated with session "${args.sessionId}".` }],
    }
  }

  // Get group info
  let groupName: string | undefined
  try {
    const group = await chrome.tabGroups.get(groupId)
    groupName = group.title ?? `Group ${groupId}`
  } catch {
    groupName = `Group ${groupId}`
  }

  // Get all tabs in this group
  const groupTabs = await chrome.tabs.query({ groupId })

  const activeTabId = await getActiveTabIdForWindow(groupTabs[0]?.windowId)

  const text = [browserIdLine, buildTabListText(groupTabs, activeTabId, groupName)].filter(Boolean).join('\n')

  return {
    content: [{ type: 'text', text }],
  }
}

/**
 * tabs_create_mcp: Creates a tab in the session's tab group.
 * Creates group if it doesn't exist yet.
 */
async function executeTabsCreateMcp(_tabId: number, rawArgs: unknown): Promise<ToolResult> {
  const args = validateTabsCreateMcpArgs(rawArgs)

  if (!args.sessionId) {
    // Fallback: create tab without group
    const newTab = await chrome.tabs.create({
      url: args.url ?? 'about:blank',
      active: args.active ?? false,
    })
    return {
      content: [{ type: 'text', text: `Created tab: ${newTab.id ?? 'unknown'} (no session)` }],
    }
  }

  // Create the new tab
  const newTab = await chrome.tabs.create({
    url: args.url ?? 'about:blank',
    active: args.active ?? false,
    ...(args.tabId !== undefined ? { openerTabId: args.tabId } : {}),
  })

  const newTabId = newTab.id
  if (newTabId === undefined) {
    throw new Error('tabs_create_mcp: created tab has no ID')
  }

  // Get existing group for this session, or create one
  let groupId = await getSessionGroupId(args.sessionId)

  if (groupId !== undefined) {
    // Verify the group still exists
    try {
      await chrome.tabGroups.get(groupId)
    } catch {
      // Group no longer exists — reset
      groupId = undefined
    }
  }

  if (groupId === undefined) {
    // Create a new group with the tab
    groupId = await chrome.tabs.group({ tabIds: newTabId })
    // Set the group title to the session ID (truncated for readability)
    const title = args.sessionId.length > 20
      ? args.sessionId.slice(0, 20) + '…'
      : args.sessionId
    await chrome.tabGroups.update(groupId, { title })
    await setSessionGroupId(args.sessionId, groupId)
  } else {
    // Add the new tab to the existing group
    await chrome.tabs.group({ tabIds: newTabId, groupId })
  }

  return {
    content: [{ type: 'text', text: `Created tab: ${newTabId}` }],
  }
}

/**
 * tabs_activate: Activates (switches to) a specific tab by ID and focuses its window.
 */
async function executeTabsActivate(_tabId: number, rawArgs: unknown): Promise<ToolResult> {
  const args = typeof rawArgs === 'object' && rawArgs !== null
    ? (rawArgs as Record<string, unknown>)
    : {}

  const targetTabId = args['tabId']
  if (typeof targetTabId !== 'number') {
    throw new Error('tabs_activate: "tabId" must be a number')
  }

  const tab = await chrome.tabs.update(targetTabId, { active: true })
  if (!tab) {
    throw new Error(`tabs_activate: tab ${targetTabId} not found`)
  }
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true })
  }

  return {
    content: [{ type: 'text', text: `Activated tab ${targetTabId}: ${tab.url ?? '(no URL)'}` }],
  }
}

/**
 * tabs_close: Closes a specific tab by ID.
 */
async function executeTabsClose(_tabId: number, rawArgs: unknown): Promise<ToolResult> {
  const args = typeof rawArgs === 'object' && rawArgs !== null
    ? (rawArgs as Record<string, unknown>)
    : {}

  const targetTabId = args['tabId']
  if (typeof targetTabId !== 'number') {
    throw new Error('tabs_close: "tabId" must be a number')
  }

  const tab = await chrome.tabs.get(targetTabId)
  await chrome.tabs.remove(targetTabId)

  return {
    content: [{ type: 'text', text: `Closed tab ${targetTabId}: ${tab.url ?? '(no URL)'}` }],
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool('tabs_context', executeTabsContext)
registerTool('tabs_create', executeTabsCreate)
registerTool('tabs_context_mcp', executeTabsContextMcp)
registerTool('tabs_create_mcp', executeTabsCreateMcp)
registerTool('tabs_activate', executeTabsActivate)
registerTool('tabs_close', executeTabsClose)
