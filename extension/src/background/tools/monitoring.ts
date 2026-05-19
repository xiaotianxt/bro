// Monitoring tools — read_console_messages, read_network_requests

import type { ToolResult } from '@bro/shared'
import { cdpSession } from '../cdp.js'
import { registerTool } from '../tool-registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConsoleEntry {
  level: string
  text: string
  timestamp: number
}

interface NetworkEntry {
  requestId: string
  method: string
  url: string
  status?: number
  statusText?: string
  failed?: boolean
  errorText?: string
  timestamp: number
}

// CDP event param types
interface ConsoleAPICalledParams {
  type: string
  args: Array<{ type: string; value?: unknown; description?: string }>
  timestamp: number
}

interface ExceptionThrownParams {
  timestamp: number
  exceptionDetails: {
    text: string
    exception?: { description?: string }
  }
}

interface RequestWillBeSentParams {
  requestId: string
  timestamp: number
  request: {
    method: string
    url: string
  }
}

interface ResponseReceivedParams {
  requestId: string
  response: {
    status: number
    statusText: string
  }
}

interface LoadingFailedParams {
  requestId: string
  timestamp: number
  errorText: string
}

// ---------------------------------------------------------------------------
// Buffers (per-tab)
// ---------------------------------------------------------------------------

const consoleBuffers = new Map<number, ConsoleEntry[]>()
const networkBuffers = new Map<number, NetworkEntry[]>()

// Track which tabs have monitoring enabled
const monitoringEnabled = new Map<number, { console: boolean; network: boolean }>()

// Store unsubscribe functions per tab
type MonitoringKind = 'console' | 'network'

interface MonitoringUnsubscribers {
  console: Array<() => void>
  network: Array<() => void>
}

const unsubscribeFns = new Map<number, MonitoringUnsubscribers>()
const networkIdleTimers = new Map<number, ReturnType<typeof setTimeout>>()

const DEFAULT_NETWORK_IDLE_TIMEOUT_MS = 30_000
const MAX_NETWORK_IDLE_TIMEOUT_MS = 10 * 60_000

cdpSession.onDetach((tabId) => cleanupTab(tabId))

// ---------------------------------------------------------------------------
// Monitoring setup
// ---------------------------------------------------------------------------

function getConsoleBuffer(tabId: number): ConsoleEntry[] {
  let buf = consoleBuffers.get(tabId)
  if (!buf) {
    buf = []
    consoleBuffers.set(tabId, buf)
  }
  return buf
}

function getNetworkBuffer(tabId: number): NetworkEntry[] {
  let buf = networkBuffers.get(tabId)
  if (!buf) {
    buf = []
    networkBuffers.set(tabId, buf)
  }
  return buf
}

function getUnsubscribers(
  tabId: number,
  kind: MonitoringKind,
): Array<() => void> {
  let fns = unsubscribeFns.get(tabId)
  if (!fns) {
    fns = { console: [], network: [] }
    unsubscribeFns.set(tabId, fns)
  }
  return fns[kind]
}

function clearNetworkIdleTimer(tabId: number): void {
  const timer = networkIdleTimers.get(tabId)
  if (timer !== undefined) {
    clearTimeout(timer)
    networkIdleTimers.delete(tabId)
  }
}

function compactUnsubscribers(tabId: number): void {
  const fns = unsubscribeFns.get(tabId)
  if (!fns) return
  if (fns.console.length === 0 && fns.network.length === 0) {
    unsubscribeFns.delete(tabId)
  }
}

function compactMonitoringState(tabId: number): void {
  const state = monitoringEnabled.get(tabId)
  if (!state) return
  if (!state.console && !state.network) {
    monitoringEnabled.delete(tabId)
  }
}

function scheduleNetworkIdleStop(tabId: number, timeoutMs: number): void {
  clearNetworkIdleTimer(tabId)

  if (timeoutMs === 0) return

  networkIdleTimers.set(tabId, setTimeout(() => {
    networkIdleTimers.delete(tabId)
    stopNetworkMonitoring(tabId)
  }, timeoutMs))
}

function formatNetworkTimeoutNotice(timeoutMs: number): string {
  if (timeoutMs === 0) {
    return 'Network monitoring will remain active until agent_done, Stop, tab close, or extension reload.'
  }

  return `Network monitoring will auto-stop after ${Math.round(timeoutMs / 1000)}s idle.`
}

/**
 * Format console args from CDP into a single string.
 */
function formatConsoleArgs(
  args: Array<{ type: string; value?: unknown; description?: string }>,
): string {
  return args
    .map((arg) => {
      if (arg.type === 'string' && typeof arg.value === 'string') {
        return arg.value
      }
      if (arg.description !== undefined) {
        return arg.description
      }
      if (arg.value !== undefined) {
        return String(arg.value)
      }
      return `[${arg.type}]`
    })
    .join(' ')
}

/**
 * Enable console monitoring for a tab (if not already enabled).
 */
async function enableConsoleMonitoring(tabId: number): Promise<void> {
  // Initialize tab state synchronously before any awaits (Fix 3: prevents race condition
  // where a second concurrent call overwrites the first call's completed flag)
  let state = monitoringEnabled.get(tabId)
  if (!state) {
    state = { console: false, network: false }
    monitoringEnabled.set(tabId, state)
  }
  if (state.console) return
  state.console = true

  await cdpSession.ensure(tabId)
  await cdpSession.send(tabId, 'Runtime.enable', {})

  const buf = getConsoleBuffer(tabId)
  const unsubs = getUnsubscribers(tabId, 'console')

  const unsubConsole = cdpSession.onEvent(
    tabId,
    'Runtime.consoleAPICalled',
    (params: unknown) => {
      const p = params as ConsoleAPICalledParams
      const text = formatConsoleArgs(p.args)
      buf.push({ level: p.type, text, timestamp: p.timestamp })
    },
  )

  const unsubException = cdpSession.onEvent(
    tabId,
    'Runtime.exceptionThrown',
    (params: unknown) => {
      const p = params as ExceptionThrownParams
      const text =
        p.exceptionDetails.exception?.description ??
        p.exceptionDetails.text ??
        'Unknown exception'
      buf.push({ level: 'error', text, timestamp: p.timestamp })
    },
  )

  unsubs.push(unsubConsole, unsubException)
}

/**
 * Enable network monitoring for a tab (if not already enabled).
 */
async function enableNetworkMonitoring(tabId: number): Promise<void> {
  // Initialize tab state synchronously before any awaits (Fix 3: prevents race condition
  // where a second concurrent call overwrites the first call's completed flag)
  let state = monitoringEnabled.get(tabId)
  if (!state) {
    state = { console: false, network: false }
    monitoringEnabled.set(tabId, state)
  }
  if (state.network) return
  state.network = true

  await cdpSession.ensure(tabId)
  await cdpSession.send(tabId, 'Network.enable', {})

  const buf = getNetworkBuffer(tabId)
  const unsubs = getUnsubscribers(tabId, 'network')

  const unsubRequest = cdpSession.onEvent(
    tabId,
    'Network.requestWillBeSent',
    (params: unknown) => {
      const p = params as RequestWillBeSentParams
      // Upsert: update existing entry if requestId already present (redirect)
      const existing = buf.find((e) => e.requestId === p.requestId)
      if (existing) {
        existing.method = p.request.method
        existing.url = p.request.url
        delete existing.status
        delete existing.statusText
        delete existing.failed
        delete existing.errorText
        existing.timestamp = p.timestamp
      } else {
        buf.push({
          requestId: p.requestId,
          method: p.request.method,
          url: p.request.url,
          timestamp: p.timestamp,
        })
      }
    },
  )

  const unsubResponse = cdpSession.onEvent(
    tabId,
    'Network.responseReceived',
    (params: unknown) => {
      const p = params as ResponseReceivedParams
      const entry = buf.find((e) => e.requestId === p.requestId)
      if (entry) {
        entry.status = p.response.status
        entry.statusText = p.response.statusText
      }
    },
  )

  const unsubFailed = cdpSession.onEvent(
    tabId,
    'Network.loadingFailed',
    (params: unknown) => {
      const p = params as LoadingFailedParams
      const entry = buf.find((e) => e.requestId === p.requestId)
      if (entry) {
        entry.failed = true
        entry.errorText = p.errorText
      }
    },
  )

  unsubs.push(unsubRequest, unsubResponse, unsubFailed)
}

/**
 * Clean up monitoring state for a tab (on tab close).
 */
function cleanupTab(tabId: number): void {
  clearNetworkIdleTimer(tabId)

  const unsubs = unsubscribeFns.get(tabId)
  if (unsubs) {
    for (const fn of [...unsubs.console, ...unsubs.network]) {
      fn()
    }
    unsubscribeFns.delete(tabId)
  }
  consoleBuffers.delete(tabId)
  networkBuffers.delete(tabId)
  monitoringEnabled.delete(tabId)
}

function stopNetworkMonitoring(tabId: number): void {
  clearNetworkIdleTimer(tabId)

  const unsubs = unsubscribeFns.get(tabId)
  if (unsubs) {
    for (const fn of unsubs.network) {
      fn()
    }
    unsubs.network.length = 0
    compactUnsubscribers(tabId)
  }

  const state = monitoringEnabled.get(tabId)
  if (state) {
    state.network = false
    compactMonitoringState(tabId)
  }

  void cdpSession.detachIfIdle(tabId).catch(() => {
    // Best-effort cleanup after the network idle timeout.
  })
}

export function stopMonitoring(tabId: number): void {
  cleanupTab(tabId)
}

export function stopAllMonitoring(): void {
  for (const tabId of Array.from(monitoringEnabled.keys())) {
    cleanupTab(tabId)
  }
}

// Listen for tab close to clean up
chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTab(tabId)
})

// ---------------------------------------------------------------------------
// Auto-enable on tab load
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return

  const state = monitoringEnabled.get(tabId)
  if (!state) return

  const shouldEnableConsole = state.console
  const shouldEnableNetwork = state.network
  if (!shouldEnableConsole && !shouldEnableNetwork) return

  // Reset state to allow re-enabling after navigation.
  state.console = false
  state.network = false

  // Call unsubscribe functions before clearing (Fix 1: prevent listener accumulation)
  const unsubs = unsubscribeFns.get(tabId)
  if (unsubs) {
    if (shouldEnableConsole) {
      unsubs.console.forEach((fn) => fn())
      unsubs.console.length = 0
    }
    if (shouldEnableNetwork) {
      unsubs.network.forEach((fn) => fn())
      unsubs.network.length = 0
    }
    compactUnsubscribers(tabId)
  }

  // Clear buffers so old-page entries are not mixed with new-page entries (Fix 2)
  consoleBuffers.set(tabId, [])
  networkBuffers.set(tabId, [])

  // Only resume monitors that were explicitly enabled for this tab.
  if (shouldEnableConsole) {
    void enableConsoleMonitoring(tabId).catch(() => {
      // Tab may not be in a debuggable state yet — ignore errors here
    })
  }

  if (shouldEnableNetwork) {
    void enableNetworkMonitoring(tabId).catch(() => {
      // Tab may not be in a debuggable state yet — ignore errors here
    })
  }
})

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

interface ReadArgs {
  clear?: boolean
}

interface ReadNetworkArgs extends ReadArgs {
  timeoutMs: number
}

function validateReadArgs(args: unknown): ReadArgs {
  if (typeof args !== 'object' || args === null) {
    return {}
  }
  const a = args as Record<string, unknown>
  const result: ReadArgs = {}
  if (a['clear'] !== undefined) {
    if (typeof a['clear'] !== 'boolean') {
      throw new Error('"clear" must be a boolean')
    }
    result.clear = a['clear']
  }
  return result
}

function validateReadNetworkArgs(args: unknown): ReadNetworkArgs {
  const result: ReadNetworkArgs = {
    ...validateReadArgs(args),
    timeoutMs: DEFAULT_NETWORK_IDLE_TIMEOUT_MS,
  }

  if (typeof args !== 'object' || args === null) {
    return result
  }

  const a = args as Record<string, unknown>
  if (a['timeoutMs'] !== undefined) {
    if (
      typeof a['timeoutMs'] !== 'number' ||
      !Number.isFinite(a['timeoutMs']) ||
      !Number.isInteger(a['timeoutMs']) ||
      a['timeoutMs'] < 0 ||
      a['timeoutMs'] > MAX_NETWORK_IDLE_TIMEOUT_MS
    ) {
      throw new Error(
        `"timeoutMs" must be an integer between 0 and ${MAX_NETWORK_IDLE_TIMEOUT_MS}`,
      )
    }
    result.timeoutMs = a['timeoutMs']
  }

  return result
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function executeReadConsoleMessages(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = validateReadArgs(rawArgs)

  // Ensure monitoring is enabled for this tab
  await enableConsoleMonitoring(tabId)

  const buf = getConsoleBuffer(tabId)

  if (buf.length === 0) {
    if (args.clear) {
      consoleBuffers.set(tabId, [])
    }
    return {
      content: [{ type: 'text', text: 'No console messages recorded.' }],
    }
  }

  const lines = buf.map((entry) => `[${entry.level}] ${entry.text}`)
  const text = lines.join('\n')

  if (args.clear) {
    consoleBuffers.set(tabId, [])
  }

  return {
    content: [{ type: 'text', text }],
  }
}

async function executeReadNetworkRequests(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = validateReadNetworkArgs(rawArgs)

  // Ensure monitoring is enabled for this tab
  await enableNetworkMonitoring(tabId)
  scheduleNetworkIdleStop(tabId, args.timeoutMs)

  const buf = getNetworkBuffer(tabId)
  const timeoutNotice = formatNetworkTimeoutNotice(args.timeoutMs)

  if (buf.length === 0) {
    if (args.clear) {
      networkBuffers.set(tabId, [])
    }
    return {
      content: [{ type: 'text', text: `No network requests recorded.\n\n${timeoutNotice}` }],
    }
  }

  const lines = buf.map((entry) => {
    if (entry.failed) {
      return `[${entry.requestId}] ${entry.method} ${entry.url} [FAILED: ${entry.errorText ?? 'unknown error'}]`
    }
    if (entry.status !== undefined) {
      return `[${entry.requestId}] ${entry.method} ${entry.url} ${entry.status}`
    }
    return `[${entry.requestId}] ${entry.method} ${entry.url} [pending]`
  })
  const text = lines.join('\n')

  if (args.clear) {
    networkBuffers.set(tabId, [])
  }

  return {
    content: [{ type: 'text', text: `${text}\n\n${timeoutNotice}` }],
  }
}

// ---------------------------------------------------------------------------
// get_response_body tool
// ---------------------------------------------------------------------------

interface GetResponseBodyArgs {
  requestId: string
}

function validateGetResponseBodyArgs(args: unknown): GetResponseBodyArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('get_response_body: args must be an object')
  }
  const a = args as Record<string, unknown>
  if (typeof a['requestId'] !== 'string' || !a['requestId']) {
    throw new Error('get_response_body: "requestId" must be a non-empty string')
  }
  return { requestId: a['requestId'] }
}

interface CDPGetResponseBodyResult {
  body: string
  base64Encoded: boolean
}

async function executeGetResponseBody(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = validateGetResponseBodyArgs(rawArgs)

  await enableNetworkMonitoring(tabId)
  scheduleNetworkIdleStop(tabId, DEFAULT_NETWORK_IDLE_TIMEOUT_MS)

  const result = await cdpSession.send<CDPGetResponseBodyResult>(
    tabId,
    'Network.getResponseBody',
    { requestId: args.requestId },
  )

  if (result.base64Encoded) {
    return {
      content: [{ type: 'text', text: `[base64-encoded binary body]\n${result.body}` }],
    }
  }

  return {
    content: [{ type: 'text', text: result.body }],
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool('read_console_messages', executeReadConsoleMessages)
registerTool('read_network_requests', executeReadNetworkRequests)
registerTool('get_response_body', executeGetResponseBody)
