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
  errorText?: string | undefined
  timestamp: number
  // Captured fields, only rendered when the caller opts in.
  requestHeaders?: Record<string, string> | undefined
  postData?: string | undefined
  responseHeaders?: Record<string, string> | undefined
  mimeType?: string | undefined
  protocol?: string | undefined
  remoteIPAddress?: string | undefined
  remotePort?: number | undefined
  fromDiskCache?: boolean | undefined
  fromServiceWorker?: boolean | undefined
  encodedDataLength?: number | undefined
  timing?: NetworkTiming | undefined
  finished?: boolean | undefined
}

interface NetworkTiming {
  requestTime: number
  proxyStart: number
  proxyEnd: number
  dnsStart: number
  dnsEnd: number
  connectStart: number
  connectEnd: number
  sslStart: number
  sslEnd: number
  workerStart: number
  workerReady: number
  workerFetchStart: number
  workerRespondWithSettled: number
  sendStart: number
  sendEnd: number
  pushStart: number
  pushEnd: number
  receiveHeadersEnd: number
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
    headers: Record<string, string>
    postData?: string
  }
  redirectResponse?: {
    status: number
    statusText: string
    headers: Record<string, string>
    mimeType: string
    protocol: string
    remoteIPAddress: string
    remotePort: number
    fromDiskCache: boolean
    fromServiceWorker: boolean
    encodedDataLength: number
    timing: NetworkTiming
  }
}

interface ResponseReceivedParams {
  requestId: string
  response: {
    status: number
    statusText: string
    headers: Record<string, string>
    mimeType: string
    protocol: string
    remoteIPAddress: string
    remotePort: number
    fromDiskCache: boolean
    fromServiceWorker: boolean
    encodedDataLength: number
    timing: NetworkTiming
  }
}

interface LoadingFailedParams {
  requestId: string
  timestamp: number
  errorText: string
}

interface LoadingFinishedParams {
  requestId: string
  encodedDataLength: number
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
        existing.requestHeaders = p.request.headers
        existing.postData = p.request.postData
        delete existing.status
        delete existing.statusText
        delete existing.failed
        delete existing.errorText
        delete existing.responseHeaders
        delete existing.mimeType
        delete existing.protocol
        delete existing.remoteIPAddress
        delete existing.remotePort
        delete existing.fromDiskCache
        delete existing.fromServiceWorker
        delete existing.encodedDataLength
        delete existing.timing
        delete existing.finished
        existing.timestamp = p.timestamp
      } else {
        buf.push({
          requestId: p.requestId,
          method: p.request.method,
          url: p.request.url,
          timestamp: p.timestamp,
          requestHeaders: p.request.headers,
          postData: p.request.postData,
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
        entry.responseHeaders = p.response.headers
        entry.mimeType = p.response.mimeType
        entry.protocol = p.response.protocol
        entry.remoteIPAddress = p.response.remoteIPAddress
        entry.remotePort = p.response.remotePort
        entry.fromDiskCache = p.response.fromDiskCache
        entry.fromServiceWorker = p.response.fromServiceWorker
        entry.encodedDataLength = p.response.encodedDataLength
        entry.timing = p.response.timing
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
        entry.finished = true
      }
    },
  )

  const unsubFinished = cdpSession.onEvent(
    tabId,
    'Network.loadingFinished',
    (params: unknown) => {
      const p = params as LoadingFinishedParams
      const entry = buf.find((e) => e.requestId === p.requestId)
      if (entry) {
        entry.finished = true
        entry.encodedDataLength = p.encodedDataLength
      }
    },
  )

  unsubs.push(unsubRequest, unsubResponse, unsubFailed, unsubFinished)
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
  includeHeaders?: boolean
  includeDetails?: boolean
  includeTiming?: boolean
  includePostData?: boolean
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

  if (a['includeHeaders'] !== undefined) {
    if (typeof a['includeHeaders'] !== 'boolean') {
      throw new Error('"includeHeaders" must be a boolean')
    }
    result.includeHeaders = a['includeHeaders']
  }

  if (a['includeDetails'] !== undefined) {
    if (typeof a['includeDetails'] !== 'boolean') {
      throw new Error('"includeDetails" must be a boolean')
    }
    result.includeDetails = a['includeDetails']
  }

  if (a['includeTiming'] !== undefined) {
    if (typeof a['includeTiming'] !== 'boolean') {
      throw new Error('"includeTiming" must be a boolean')
    }
    result.includeTiming = a['includeTiming']
  }

  if (a['includePostData'] !== undefined) {
    if (typeof a['includePostData'] !== 'boolean') {
      throw new Error('"includePostData" must be a boolean')
    }
    result.includePostData = a['includePostData']
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

  const lines = buf.map((entry) =>
    formatNetworkEntry(entry, {
      includeHeaders: args.includeHeaders ?? false,
      includeDetails: args.includeDetails ?? false,
      includeTiming: args.includeTiming ?? false,
      includePostData: args.includePostData ?? false,
    }),
  )
  const text = lines.join('\n')

  if (args.clear) {
    networkBuffers.set(tabId, [])
  }

  return {
    content: [{ type: 'text', text: `${text}\n\n${timeoutNotice}` }],
  }
}

interface NetworkFormatOptions {
  includeHeaders: boolean
  includeDetails: boolean
  includeTiming: boolean
  includePostData: boolean
}

function formatHeaders(headers: Record<string, string> | undefined, indent: string): string {
  if (!headers) return `${indent}(none)`
  const entries = Object.entries(headers)
  if (entries.length === 0) return `${indent}(none)`
  return entries.map(([k, v]) => `${indent}${k}: ${v}`).join('\n')
}

function formatTiming(timing: NetworkTiming | undefined, indent: string): string {
  if (!timing) return `${indent}(none)`
  const fields: Array<[string, number]> = [
    ['requestTime', timing.requestTime],
    ['proxyStart', timing.proxyStart],
    ['proxyEnd', timing.proxyEnd],
    ['dnsStart', timing.dnsStart],
    ['dnsEnd', timing.dnsEnd],
    ['connectStart', timing.connectStart],
    ['connectEnd', timing.connectEnd],
    ['sslStart', timing.sslStart],
    ['sslEnd', timing.sslEnd],
    ['workerStart', timing.workerStart],
    ['workerReady', timing.workerReady],
    ['workerFetchStart', timing.workerFetchStart],
    ['workerRespondWithSettled', timing.workerRespondWithSettled],
    ['sendStart', timing.sendStart],
    ['sendEnd', timing.sendEnd],
    ['pushStart', timing.pushStart],
    ['pushEnd', timing.pushEnd],
    ['receiveHeadersEnd', timing.receiveHeadersEnd],
  ]
  return fields.map(([k, v]) => `${indent}${k}: ${v}`).join('\n')
}

function formatNetworkEntry(
  entry: NetworkEntry,
  opts: NetworkFormatOptions,
): string {
  const head =
    entry.failed
      ? `[${entry.requestId}] ${entry.method} ${entry.url} [FAILED: ${entry.errorText ?? 'unknown error'}]`
      : entry.status !== undefined
        ? `[${entry.requestId}] ${entry.method} ${entry.url} ${entry.status}`
        : `[${entry.requestId}] ${entry.method} ${entry.url} [pending]`

  const sections: string[] = [head]

  if (opts.includeHeaders) {
    sections.push(`  Request Headers:`)
    sections.push(formatHeaders(entry.requestHeaders, '    '))
    sections.push(`  Response Headers:`)
    sections.push(formatHeaders(entry.responseHeaders, '    '))
  }

  if (opts.includePostData) {
    sections.push(`  Post Data:`)
    sections.push(`    ${entry.postData ?? '(none)'}`)
  }

  if (opts.includeDetails) {
    const detailLines: string[] = []
    if (entry.mimeType !== undefined) detailLines.push(`mimeType: ${entry.mimeType}`)
    if (entry.protocol !== undefined) detailLines.push(`protocol: ${entry.protocol}`)
    if (entry.remoteIPAddress !== undefined) detailLines.push(`remoteIPAddress: ${entry.remoteIPAddress}`)
    if (entry.remotePort !== undefined) detailLines.push(`remotePort: ${entry.remotePort}`)
    if (entry.fromDiskCache !== undefined) detailLines.push(`fromDiskCache: ${entry.fromDiskCache}`)
    if (entry.fromServiceWorker !== undefined) detailLines.push(`fromServiceWorker: ${entry.fromServiceWorker}`)
    if (entry.encodedDataLength !== undefined) detailLines.push(`encodedDataLength: ${entry.encodedDataLength}`)
    if (detailLines.length > 0) {
      sections.push(`  Details:`)
      sections.push(...detailLines.map((l) => `    ${l}`))
    }
  }

  if (opts.includeTiming) {
    sections.push(`  Timing:`)
    sections.push(formatTiming(entry.timing, '    '))
  }

  return sections.join('\n')
}

// ---------------------------------------------------------------------------
// capture_network tool — one request owns monitor, trigger, collection, and cleanup
// ---------------------------------------------------------------------------

interface CaptureNetworkArgs {
  code: string
  urlIncludes?: string
  timeoutMs: number
  includeResponseBodies: boolean
  includeHeaders: boolean
  includePostData: boolean
  maxBodyChars: number
  maxRequests: number
}

interface CaptureEvaluateResult {
  result: {
    value?: { result?: string; isError?: boolean }
    description?: string
  }
  exceptionDetails?: {
    text: string
    exception?: { description?: string }
  }
}

function validateCaptureNetworkArgs(args: unknown): CaptureNetworkArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('capture_network: args must be an object')
  }
  const value = args as Record<string, unknown>
  if (typeof value['code'] !== 'string' || value['code'].trim() === '') {
    throw new Error('capture_network: "code" must be a non-empty JavaScript expression')
  }

  const timeoutMs = boundedInteger(value['timeoutMs'], 'timeoutMs', 1, 20_000, 10_000)
  const maxBodyChars = boundedInteger(value['maxBodyChars'], 'maxBodyChars', 1, 60_000, 20_000)
  const maxRequests = boundedInteger(value['maxRequests'], 'maxRequests', 1, 100, 20)
  const urlIncludes = value['urlIncludes']
  if (urlIncludes !== undefined && (typeof urlIncludes !== 'string' || urlIncludes === '')) {
    throw new Error('capture_network: "urlIncludes" must be a non-empty string')
  }

  return {
    code: value['code'],
    ...(typeof urlIncludes === 'string' ? { urlIncludes } : {}),
    timeoutMs,
    includeResponseBodies: optionalBoolean(value['includeResponseBodies'], 'includeResponseBodies', true),
    includeHeaders: optionalBoolean(value['includeHeaders'], 'includeHeaders', false),
    includePostData: optionalBoolean(value['includePostData'], 'includePostData', false),
    maxBodyChars,
    maxRequests,
  }
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`capture_network: "${name}" must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new Error(`capture_network: "${name}" must be a boolean`)
  }
  return value
}

async function evaluateCaptureTrigger(tabId: number, code: string): Promise<string> {
  const expression = `(async function() { try { var __r = eval(${JSON.stringify(code)}); if (typeof __r === 'function') __r = __r(); __r = await __r; return { result: __r === undefined ? 'undefined' : (() => { try { return JSON.stringify(__r) } catch(e) { return String(__r) } })(), isError: false }; } catch(e) { return { result: e instanceof Error ? e.message : String(e), isError: true }; } })()`
  const response = await cdpSession.send<CaptureEvaluateResult>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        'Network capture trigger failed',
    )
  }
  const value = response.result.value
  if (value?.isError) throw new Error(value.result ?? 'Network capture trigger failed')
  return value?.result ?? response.result.description ?? 'undefined'
}

function matchingNetworkEntries(tabId: number, args: CaptureNetworkArgs): NetworkEntry[] {
  return getNetworkBuffer(tabId)
    .filter((entry) => args.urlIncludes === undefined || entry.url.includes(args.urlIncludes))
    .slice(0, args.maxRequests)
}

async function waitForMatchingNetworkEntry(
  tabId: number,
  args: CaptureNetworkArgs,
): Promise<NetworkEntry[]> {
  const deadline = Date.now() + args.timeoutMs
  while (Date.now() < deadline) {
    const matches = matchingNetworkEntries(tabId, args)
    if (matches.some((entry) => entry.finished || entry.failed)) return matches
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return matchingNetworkEntries(tabId, args)
}

async function responseBody(
  tabId: number,
  entry: NetworkEntry,
  maxBodyChars: number,
): Promise<Record<string, unknown>> {
  try {
    const result = await cdpSession.send<CDPGetResponseBodyResult>(
      tabId,
      'Network.getResponseBody',
      { requestId: entry.requestId },
    )
    const truncated = result.body.length > maxBodyChars
    return {
      body: result.body.slice(0, maxBodyChars),
      base64Encoded: result.base64Encoded,
      truncated,
    }
  } catch (error) {
    return { bodyError: error instanceof Error ? error.message : String(error) }
  }
}

async function executeCaptureNetwork(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = validateCaptureNetworkArgs(rawArgs)
  clearNetworkIdleTimer(tabId)
  const buffer = getNetworkBuffer(tabId)
  buffer.length = 0
  await enableNetworkMonitoring(tabId)

  try {
    const triggerResult = await evaluateCaptureTrigger(tabId, args.code)
    const matches = await waitForMatchingNetworkEntry(tabId, args)
    const requests: Array<Record<string, unknown>> = []
    let remainingBodyChars = args.maxBodyChars
    for (const entry of matches) {
      let body: Record<string, unknown> = {}
      if (args.includeResponseBodies && entry.finished && !entry.failed) {
        if (remainingBodyChars > 0) {
          body = await responseBody(tabId, entry, remainingBodyChars)
          if (typeof body['body'] === 'string') {
            remainingBodyChars -= body['body'].length
          }
        } else {
          body = { bodyOmitted: 'total response body limit reached' }
        }
      }
      requests.push({
        requestId: entry.requestId,
        method: entry.method,
        url: entry.url,
        ...(entry.status === undefined ? {} : { status: entry.status }),
        ...(entry.failed ? { failed: true, errorText: entry.errorText } : {}),
        ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
        ...(entry.encodedDataLength === undefined ? {} : { encodedDataLength: entry.encodedDataLength }),
        ...(args.includeHeaders
          ? { requestHeaders: entry.requestHeaders ?? {}, responseHeaders: entry.responseHeaders ?? {} }
          : {}),
        ...(args.includePostData ? { postData: entry.postData ?? null } : {}),
        ...body,
      })
    }

    const timedOut =
      matches.length === 0 ||
      !matches.some((entry) => entry.status !== undefined || entry.failed)
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          triggerResult,
          matchedRequests: requests.length,
          timedOut,
          requests,
        }),
      }],
      ...(timedOut ? { isError: true } : {}),
    }
  } finally {
    stopNetworkMonitoring(tabId)
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
registerTool('capture_network', executeCaptureNetwork)
registerTool('get_response_body', executeGetResponseBody)
