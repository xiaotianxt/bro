// DOM tools — read_page, find, get_page_text, form_input, javascript_tool

import type { ToolResult } from '@bro/shared'
import { CDP_COMMAND_TIMEOUT_MS, CdpCommandTimeout, cdpSession } from '../cdp.js'
import { armDialogs } from '../dialogs.js'
import { getBrowserFrames, sendToFrame } from '../frames.js'
import { registerTool } from '../tool-registry.js'
import { readAXPage, findAX, refTool, waitAX, actElement } from './accessibility.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractPageResult {
  tabId?: number
  title: string
  url: string
  text: string
  links: Array<{ text: string; url: string; source: string }>
  readiness: {
    reason: string
    textChars: number
    linkCount: number
    documentReadyState: string
  }
}

const DEFAULT_EXTRACT_MAX_CHARS = 8000
const MAX_EXTRACT_MAX_CHARS = 60000
const DEFAULT_EXTRACT_MAX_LINKS = 20
const MAX_EXTRACT_MAX_LINKS = 200
const DEFAULT_EXTRACT_MIN_CHARS = 120
const MAX_EXTRACT_MIN_CHARS = 10000
const DEFAULT_EXTRACT_QUIET_MS = 250
const MIN_EXTRACT_QUIET_MS = 50
const MAX_EXTRACT_QUIET_MS = 1000
const DEFAULT_EXTRACT_GUARD_MS = 8000
const MIN_EXTRACT_GUARD_MS = 500
const MAX_EXTRACT_GUARD_MS = 8000
const EXTRACT_LOAD_GUARD_MS = 1500
const EXTRACT_MAX_ATTEMPTS = 2

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function getString(
  args: Record<string, unknown>,
  key: string,
  defaultValue?: string,
): string | undefined {
  if (args[key] === undefined) return defaultValue
  if (typeof args[key] !== 'string') {
    throw new Error(`"${key}" must be a string`)
  }
  return args[key] as string
}

function getNumber(
  args: Record<string, unknown>,
  key: string,
  defaultValue?: number,
): number | undefined {
  if (args[key] === undefined) return defaultValue
  if (typeof args[key] !== 'number') {
    throw new Error(`"${key}" must be a number`)
  }
  return args[key] as number
}

function getClampedInteger(
  args: Record<string, unknown>,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = getNumber(args, key, defaultValue) ?? defaultValue
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`"${key}" must be an integer`)
  }
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// CDP scripting helpers
// ---------------------------------------------------------------------------

// CDP Runtime.evaluate response shape (partial)
const EVAL_OBJECT_GROUP = 'bro-javascript-tool'

interface CDPEvaluateResult {
  result: {
    type: string
    subtype?: string
    value?: unknown
    unserializableValue?: string
    objectId?: string
    description?: string
  }
  exceptionDetails?: {
    text: string
    exception?: { description?: string }
  }
}

/**
 * Executes a serializable function with JSON-serializable args in the page
 * context via CDP Runtime.evaluate. Works on frozen/background tabs because
 * CDP bypasses the tab's rendering freeze — unlike chrome.scripting.executeScript
 * which hangs until the tab is unfrozen/activated.
 */
async function executeInPage<T>(
  tabId: number,
  func: (...args: any[]) => T,
  args: unknown[],
): Promise<T> {
  const argsJson = args.map((a) => JSON.stringify(a)).join(', ')
  const expression = `(${func.toString()})(${argsJson})`

  const res = await cdpSession.send<CDPEvaluateResult>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  })

  if (res.exceptionDetails) {
    const msg =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.text ??
      'Unknown error in page'
    throw new Error(msg)
  }

  return res.result.value as T
}

async function waitForTabLoadComplete(
  tabId: number,
  guardMs: number,
): Promise<void> {
  const tab = await chrome.tabs.get(tabId)
  if (tab.status === 'complete') return

  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(guard)
      resolve()
    }
    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
    ): void => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish()
    }
    const guard = setTimeout(finish, guardMs)
    chrome.tabs.onUpdated.addListener(listener)
  })
}

/**
 * Evaluates arbitrary user code in the page via CDP Runtime.evaluate.
 * Returns JSON-stringified result or error details.
 */
async function evaluateInPage(
  tabId: number,
  code: string,
  awaitPromise: boolean,
  frameId?: string,
): Promise<{ result: string; isError: boolean }> {
  const frame = frameId === undefined ? undefined : (await getBrowserFrames(tabId)).find(f => f.id === frameId)
  if (frameId !== undefined && !frame) throw new Error(`Frame ${frameId} is no longer available`)
  const world = frame === undefined ? undefined : await sendToFrame<{ executionContextId: number }>(tabId, frame, 'Page.createIsolatedWorld', { frameId, worldName: 'bro', grantUniveralAccess: false })
  const contextId = world?.executionContextId
  const send = <T>(method: string, params: object): Promise<T> => (frame === undefined
    ? cdpSession.send<T>(tabId, method, params)
    : sendToFrame<T>(tabId, frame, method, params)
  ).catch((error: unknown) => {
    if (!(error instanceof CdpCommandTimeout)) throw error
    throw new Error(
      `evaluate got no result within ${CDP_COMMAND_TIMEOUT_MS}ms: the expression awaited too long or the page's main thread was busy. Instead of a timer, use a wait step for the text or ref state you expect, then evaluate a shorter expression.`,
    )
  })
  // replMode evaluates like the DevTools console: top-level await works and the
  // completion value of the last statement is the result. Like the console it
  // does not unwrap a returned Promise, so awaitPromise awaits it explicitly.
  // The block keeps the caller's let/const out of the page's global scope,
  // where they would collide with the page's own declarations and with the
  // next call.
  let res = await send<CDPEvaluateResult>('Runtime.evaluate', {
    expression: `{\n${code}\n}`,
    replMode: true,
    objectGroup: EVAL_OBJECT_GROUP,
    ...(contextId === undefined ? {} : { contextId }),
  })
  try {
    if (awaitPromise && !res.exceptionDetails && res.result.subtype === 'promise' && res.result.objectId)
      res = await send<CDPEvaluateResult>('Runtime.awaitPromise', { promiseObjectId: res.result.objectId })
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text
      // Page stack frames point into the caller's own snippet; drop them and the
      // error class prefix, as the previous eval wrapper reported e.message.
      return { result: detail.split('\n    at ')[0]!.replace(/^[A-Za-z]*Error: /, ''), isError: true }
    }
    const value = res.result
    if (value.type === 'undefined') return { result: 'undefined', isError: false }
    if (value.objectId === undefined)
      return { result: value.unserializableValue ?? JSON.stringify(value.value), isError: false }
    // Same serialization as before: JSON when possible, else String().
    const serialized = await send<CDPEvaluateResult>('Runtime.callFunctionOn', {
      objectId: value.objectId,
      functionDeclaration: 'function () { try { var s = JSON.stringify(this); return s === undefined ? String(this) : s } catch (e) { return String(this) } }',
      returnByValue: true,
    })
    return { result: String(serialized.result.value), isError: false }
  } finally {
    await send('Runtime.releaseObjectGroup', { objectGroup: EVAL_OBJECT_GROUP }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Page-side functions (run in MAIN world)
// These functions are serialized and sent to the page, so they must be
// self-contained and cannot reference any outer scope variables.
// ---------------------------------------------------------------------------

// `cursor` is a character offset into the same text, so a truncated read can
// be continued without re-reading what the caller already has.
function pageGetBodyText(maxChars: number, cursor: number): string {
  const body = document.body
  if (!body) return ''
  const raw = (body as HTMLBodyElement).innerText?.trim() ?? ''
  const end = cursor + maxChars
  return end < raw.length
    ? raw.slice(cursor, end) + `\n[Truncated; continue with cursor=${end}.]`
    : raw.slice(cursor)
}

// One read of the page; executeExtractPage polls it until it is stable.
function pageExtractSnapshot(options: {
  maxChars: number
  maxLinks: number
}): ExtractPageResult & { shell: boolean } {
  const maxChars = options.maxChars
  const maxLinks = options.maxLinks

  function cleanText(value: unknown): string {
    return String(value ?? '').replace(/\s+/g, ' ').trim()
  }

  function redactUrl(value: string): string {
    try {
      const url = new URL(value, location.href)
      const sensitive = [
        'access_token',
        'auth',
        'code',
        'id_token',
        'key',
        'refresh_token',
        'session',
        'sig',
        'signature',
        'state',
        'token',
      ]
      const queryKeys: string[] = []
      url.searchParams.forEach((_value, key) => queryKeys.push(key))
      for (const key of queryKeys) {
        if (sensitive.some((part) => key.toLowerCase().includes(part))) {
          url.searchParams.set(key, 'REDACTED')
        }
      }
      if (/access_token|id_token|token|session/i.test(url.hash)) {
        url.hash = ''
      }
      return url.href
    } catch {
      return value
    }
  }

  function looksLikeNavigationShell(text: string): boolean {
    const lower = text.toLowerCase()
    const markers = [
      'home',
      'notifications',
      'messaging',
      'my network',
      'for business',
      'primary content',
    ]
    const hits = markers.filter((marker) => lower.includes(marker)).length
    const contentMarkers = [
      'feed post',
      'reaction button',
      'comment',
      'repost',
      'followers',
    ]
    const hasContentMarker = contentMarkers.some((marker) => lower.includes(marker))
    return hits >= 4 && !hasContentMarker
  }

  function snapshot(): ExtractPageResult {
    const links: Array<{ text: string; url: string; source: string }> = []
    const seenLinks = new Set<string>()

    function addLink(element: HTMLAnchorElement): void {
      if (!element.checkVisibility()) return
      const rawUrl = element.href || element.getAttribute('href') || ''
      const url = redactUrl(rawUrl)
      if (!url || seenLinks.has(url) || url.startsWith('javascript:')) return
      seenLinks.add(url)
      const text = cleanText(
        element.getAttribute('aria-label') ||
          element.textContent ||
          url,
      ).slice(0, 240)
      links.push({ text, url, source: 'dom' })
    }

    // Visible text as rendered (innerText): a table row stays on one line and
    // repeated cells stay, so rows can be read off by position. innerText
    // stops at shadow roots; their text follows the document's.
    const parts = [(document.body ?? document.documentElement)?.innerText ?? '']
    function visit(root: Document | ShadowRoot): void {
      for (const element of Array.from(root.querySelectorAll('*'))) {
        if (element instanceof HTMLAnchorElement) addLink(element)
        if (!element.shadowRoot) continue
        for (const child of Array.from(element.shadowRoot.children))
          if (child instanceof HTMLElement) parts.push(child.innerText)
        visit(element.shadowRoot)
      }
    }
    visit(document)

    const text = parts
      .join('\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, maxChars)
    return {
      title: document.title || '',
      url: redactUrl(location.href),
      text,
      links: links.slice(0, maxLinks),
      readiness: {
        reason: 'snapshot',
        textChars: text.length,
        linkCount: links.length,
        documentReadyState: document.readyState,
      },
    }
  }

  const result = snapshot()
  return { ...result, shell: looksLikeNavigationShell(result.text) }
}

// get_page_text tool
// ---------------------------------------------------------------------------

async function executeGetPageText(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}
  const maxChars = getClampedInteger(args, 'maxChars', 12000, 1, 60000)
  const cursor = getClampedInteger(args, 'cursor', 0, 0, 10_000_000)

  const text = await executeInPage(
    tabId,
    pageGetBodyText,
    [maxChars, cursor],
  ) as string

  return {
    content: [
      {
        type: 'text',
        text: text || '(no text content found)',
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// extract_page tool
// ---------------------------------------------------------------------------

/** Short text that announces content still on its way. */
function isLoadingPlaceholder(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed.length < 200 &&
    (/\b(loading|please wait|just a moment)\b/i.test(trimmed) || /(\.\.\.|…)$/.test(trimmed))
  )
}

async function executeExtractPage(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const maxChars = getClampedInteger(
    args,
    'maxChars',
    DEFAULT_EXTRACT_MAX_CHARS,
    1,
    MAX_EXTRACT_MAX_CHARS,
  )
  const maxLinks = getClampedInteger(
    args,
    'maxLinks',
    DEFAULT_EXTRACT_MAX_LINKS,
    0,
    MAX_EXTRACT_MAX_LINKS,
  )
  const minChars = getClampedInteger(
    args,
    'minChars',
    DEFAULT_EXTRACT_MIN_CHARS,
    1,
    MAX_EXTRACT_MIN_CHARS,
  )
  const quietMs = getClampedInteger(
    args,
    'quietMs',
    DEFAULT_EXTRACT_QUIET_MS,
    MIN_EXTRACT_QUIET_MS,
    MAX_EXTRACT_QUIET_MS,
  )
  const guardMs = getClampedInteger(
    args,
    'guardMs',
    DEFAULT_EXTRACT_GUARD_MS,
    MIN_EXTRACT_GUARD_MS,
    MAX_EXTRACT_GUARD_MS,
  )

  await waitForTabLoadComplete(tabId, EXTRACT_LOAD_GUARD_MS)

  // Polled from the service worker: a page-side wait relies on page timers,
  // which Chrome throttles in background tabs, and would hold one CDP command
  // past its timeout. Stable means two equal reads quietMs apart.
  const deadline = Date.now() + guardMs
  let lastSignature = ''
  let result: ExtractPageResult & { shell: boolean }
  let failures = 0
  for (;;) {
    try {
      result = await executeInPage(tabId, pageExtractSnapshot, [{ maxChars, maxLinks }])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const transient =
        message.includes('Execution context was destroyed') ||
        message.includes('Cannot find default execution context') ||
        message.includes('Cannot find context with specified id')
      if (!transient || ++failures === EXTRACT_MAX_ATTEMPTS) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 150 * failures))
      continue
    }
    const { text, links, readiness } = result
    const signature = `${text.length}:${links.length}:${readiness.documentReadyState}:${text.slice(0, 160)}:${text.slice(-160)}`
    // A complete document's short, stable text is its content; only a short
    // loading placeholder ("Loading…") keeps waiting for the real page.
    const ready =
      signature === lastSignature &&
      readiness.documentReadyState !== 'loading' &&
      !result.shell &&
      (text.length >= minChars ||
        (readiness.documentReadyState === 'complete' && text.trim() !== '' && !isLoadingPlaceholder(text)))
    if (ready || Date.now() >= deadline) {
      result.readiness.reason = ready ? 'dom_quiet' : 'guard'
      break
    }
    lastSignature = signature
    await new Promise<void>((resolve) => setTimeout(resolve, quietMs))
  }
  const { shell: _shell, ...page } = result
  const extracted: ExtractPageResult = { ...page, tabId }

  return {
    content: [{ type: 'text', text: JSON.stringify(extracted) }],
  }
}

// ---------------------------------------------------------------------------
// frames_list
// ---------------------------------------------------------------------------

async function executeFramesList(
  tabId: number,
  _rawArgs: unknown,
): Promise<ToolResult> {
  const frames = (await getBrowserFrames(tabId)).map(frame => ({
    frameId: frame.id,
    parentFrameId: frame.parentId ?? null,
    name: frame.name ?? '',
    url: frame.url,
  }))
  return {
    content: [{ type: 'text', text: JSON.stringify(frames) }],
  }
}

// ---------------------------------------------------------------------------
// javascript_tool
// ---------------------------------------------------------------------------

async function executeJavaScriptTool(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const code = getString(args, 'code')
  if (!code) {
    throw new Error('javascript_tool: "code" is required')
  }

  const awaitPromise =
    typeof args['awaitPromise'] === 'boolean' ? args['awaitPromise'] : false
  const frameId = getString(args, 'frameId')

  const { result, isError } = await evaluateInPage(tabId, code, awaitPromise, frameId)

  if (isError) {
    return {
      content: [{ type: 'text', text: result }],
      isError: true,
    } as ToolResult & { isError: true }
  }

  return {
    content: [{ type: 'text', text: result }],
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool('read_page', readAXPage)
registerTool('find', findAX)
registerTool('get_page_text', executeGetPageText)
registerTool('extract_page', executeExtractPage)
registerTool('form_input', (tabId, args) => refTool('form_input', tabId, args))
registerTool('frames_list', executeFramesList)
registerTool('javascript_tool', executeJavaScriptTool)
registerTool('click_element', (tabId, args) => refTool('click_element', tabId, args))
registerTool('scroll_element', (tabId, args) => refTool('scroll_element', tabId, args))
registerTool('fill_element', (tabId, args) => refTool('fill_element', tabId, args))
registerTool('get_element_info', (tabId, args) => refTool('get_element_info', tabId, args))
registerTool('wait_for_element', waitAX)
registerTool('act_element', actElement)
// Internal to browser.act's dialog step: arms an answer for the tab's native
// dialogs until the act call disarms it.
registerTool('dialog_answer', async (tabId, raw) => {
  const args = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  if (args['disarm'] === true) {
    armDialogs(tabId, undefined)
    return { content: [{ type: 'text', text: 'Dialog answer disarmed.' }] }
  }
  if (typeof args['accept'] !== 'boolean') throw new Error('dialog_answer: "accept" must be a boolean')
  if (args['promptText'] !== undefined && typeof args['promptText'] !== 'string')
    throw new Error('dialog_answer: "promptText" must be a string')
  await cdpSession.ensure(tabId)
  armDialogs(tabId, {
    accept: args['accept'],
    ...(args['promptText'] === undefined ? {} : { promptText: args['promptText'] as string }),
  })
  return { content: [{ type: 'text', text: `Dialogs will be ${args['accept'] ? 'accepted' : 'dismissed'}.` }] }
})
