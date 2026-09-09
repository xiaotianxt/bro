// DOM tools — read_page, find, get_page_text, form_input, javascript_tool

import type { ToolResult } from '@bro/shared'
import { cdpSession } from '../cdp.js'
import { getBrowserFrames, sendToFrame } from '../frames.js'
import { registerTool } from '../tool-registry.js'
import { readAXPage, findAX, refTool, waitAX } from './accessibility.js'

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
interface CDPEvaluateResult {
  result: {
    type: string
    value?: unknown
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

async function executeInPageAwait<T>(
  tabId: number,
  func: (...args: any[]) => Promise<T>,
  args: unknown[],
): Promise<T> {
  const argsJson = args.map((a) => JSON.stringify(a)).join(', ')
  const expression = `(${func.toString()})(${argsJson})`

  const res = await cdpSession.send<CDPEvaluateResult>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
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
  const evaluate = (params: object): Promise<CDPEvaluateResult> => frame === undefined
    ? cdpSession.send(tabId, 'Runtime.evaluate', params)
    : sendToFrame(tabId, frame, 'Runtime.evaluate', params)
  if (awaitPromise) {
    // Async wrapper: await the eval result, then return {result, isError}.
    // CDP awaitPromise:true ensures the outer Promise (from async IIFE) is
    // awaited before returnByValue serializes the result.
    const expression = `(async function() { try { var __r = await eval(${JSON.stringify(code)}); return { result: __r === undefined ? 'undefined' : (() => { try { return JSON.stringify(__r) } catch(e) { return String(__r) } })(), isError: false }; } catch(e) { return { result: e instanceof Error ? e.message : String(e), isError: true }; } })()`
    const res = await evaluate({ expression, returnByValue: true, awaitPromise: true, ...(contextId === undefined ? {} : { contextId }) })
    if (res.exceptionDetails) {
      return {
        result: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Unknown error',
        isError: true,
      }
    }
    const value = res.result.value as { result: string; isError: boolean } | undefined
    if (value && typeof value.result === 'string') {
      return value
    }
    // Fallback: CDP may not have returned by value properly
    return { result: res.result.description ?? '{}', isError: false }
  }

  // Sync wrapper: eval and serialize immediately.
  const expression = `(function() { try { var __r = eval(${JSON.stringify(code)}); return { result: __r === undefined ? 'undefined' : (() => { try { return JSON.stringify(__r) } catch(e) { return String(__r) } })(), isError: false }; } catch(e) { return { result: e instanceof Error ? e.message : String(e), isError: true }; } })()`
  const res = await evaluate({ expression, returnByValue: true, awaitPromise: false, ...(contextId === undefined ? {} : { contextId }) })
  if (res.exceptionDetails) {
    return {
      result: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Unknown error',
      isError: true,
    }
  }
  return res.result.value as { result: string; isError: boolean }
}

// ---------------------------------------------------------------------------
// Page-side functions (run in MAIN world)
// These functions are serialized and sent to the page, so they must be
// self-contained and cannot reference any outer scope variables.
// ---------------------------------------------------------------------------

function pageGetBodyText(maxChars: number): string {
  const body = document.body
  if (!body) return ''
  const raw = (body as HTMLBodyElement).innerText?.trim() ?? ''
  return raw.length > maxChars
    ? raw.slice(0, maxChars) + '\n[... truncated ...]'
    : raw
}

async function pageExtractStable(options: {
  maxChars: number
  maxLinks: number
  minChars: number
  quietMs: number
  guardMs: number
}): Promise<ExtractPageResult> {
  const maxChars = options.maxChars
  const maxLinks = options.maxLinks
  const minChars = options.minChars
  const quietMs = options.quietMs
  const guardMs = options.guardMs

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

  function isHidden(element: Element): boolean {
    const style = window.getComputedStyle(element)
    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    )
  }

  function snapshot(): ExtractPageResult {
    const textParts: string[] = []
    const links: Array<{ text: string; url: string; source: string }> = []
    const seenNodes = new Set<Node>()
    const seenLinks = new Set<string>()
    const ignoredTextTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])
    let visited = 0
    const maxVisitedNodes = 5000

    function addText(value: unknown): void {
      const text = cleanText(value)
      if (text) textParts.push(text)
    }

    function addLink(element: HTMLAnchorElement): void {
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

    function walk(node: Node, depth: number): void {
      if (seenNodes.has(node) || depth > 80) return
      if (visited >= maxVisitedNodes) return
      visited += 1
      seenNodes.add(node)

      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement
        if (
          parent &&
          (ignoredTextTags.has(parent.tagName) || isHidden(parent))
        ) {
          return
        }
        addText(node.textContent)
        return
      }

      if (
        node.nodeType !== Node.ELEMENT_NODE &&
        node.nodeType !== Node.DOCUMENT_NODE &&
        node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
      ) {
        return
      }

      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null
      if (element) {
        if (ignoredTextTags.has(element.tagName)) return
        if (isHidden(element)) return
        addText(element.getAttribute('aria-label'))
        if (element instanceof HTMLAnchorElement) addLink(element)
      }

      for (const child of Array.from(node.childNodes)) {
        walk(child, depth + 1)
      }

      const maybeShadow = element as (Element & { shadowRoot?: ShadowRoot }) | null
      if (maybeShadow?.shadowRoot) {
        walk(maybeShadow.shadowRoot, depth + 1)
      }
    }

    const root = document.body || document.documentElement
    if (root) walk(root, 0)

    const text = Array.from(new Set(textParts)).join('\n').slice(0, maxChars)
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

  return await new Promise<ExtractPageResult>((resolve) => {
    let finished = false
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    let lastSignature = ''
    let stableChecks = 0
    const observer = new MutationObserver(() => scheduleCheck())

    function finish(reason: string): void {
      if (finished) return
      finished = true
      if (quietTimer !== undefined) clearTimeout(quietTimer)
      observer.disconnect()
      window.removeEventListener('load', scheduleCheck)
      const result = snapshot()
      result.readiness.reason = reason
      resolve(result)
    }

    function scheduleCheck(): void {
      if (finished) return
      if (quietTimer !== undefined) clearTimeout(quietTimer)
      quietTimer = setTimeout(checkStable, quietMs)
    }

    function checkStable(): void {
      const current = snapshot()
      const textHead = current.text.slice(0, 160)
      const textTail = current.text.slice(-160)
      const signature = `${current.text.length}:${current.links.length}:${document.readyState}:${textHead}:${textTail}`
      if (signature === lastSignature) {
        stableChecks += 1
      } else {
        stableChecks = 0
        lastSignature = signature
      }

      const enoughText = current.text.length >= minChars
      const documentReady = document.readyState !== 'loading'
      if (
        enoughText &&
        documentReady &&
        stableChecks >= 1 &&
        !looksLikeNavigationShell(current.text)
      ) {
        finish('dom_quiet')
      } else {
        scheduleCheck()
      }
    }

    const root = document.documentElement || document.body
    if (root) {
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }
    window.addEventListener('load', scheduleCheck, { once: true })
    scheduleCheck()
    setTimeout(() => finish('guard'), guardMs)
  })
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

  const text = await executeInPage(
    tabId,
    pageGetBodyText,
    [maxChars],
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

  let result: ExtractPageResult | undefined
  for (let attempt = 0; attempt < EXTRACT_MAX_ATTEMPTS; attempt += 1) {
    try {
      result = await executeInPageAwait(
        tabId,
        pageExtractStable,
        [{ maxChars, maxLinks, minChars, quietMs, guardMs }],
      ) as ExtractPageResult
      result.tabId = tabId
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const transient =
        message.includes('Execution context was destroyed') ||
        message.includes('Cannot find default execution context') ||
        message.includes('Cannot find context with specified id')
      if (!transient || attempt === EXTRACT_MAX_ATTEMPTS - 1) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }

  if (!result) {
    throw new Error('extract_page: extraction did not produce a result')
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
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
