// DOM tools — read_page, find, get_page_text, form_input, javascript_tool

import type { ToolResult } from '@bro/shared'
import { cdpSession } from '../cdp.js'
import { registerTool } from '../tool-registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccessibilityTreeResult {
  pageContent: string
  viewport: { width: number; height: number }
}

interface ExtractPageResult {
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

const DEFAULT_EXTRACT_MAX_CHARS = 12000
const MAX_EXTRACT_MAX_CHARS = 60000
const DEFAULT_EXTRACT_MAX_LINKS = 80
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
 * Ensures the accessibility-tree content script is loaded in the page.
 * Uses fetch + CDP Runtime.evaluate so it works on frozen/background tabs.
 */
async function ensureAccessibilityScript(tabId: number): Promise<void> {
  const checkRes = await cdpSession.send<CDPEvaluateResult>(tabId, 'Runtime.evaluate', {
    expression: 'typeof window.__generateAccessibilityTree',
    returnByValue: true,
  })
  if (checkRes.result.value === 'function') return

  const scriptUrl = chrome.runtime.getURL('content/accessibility-tree.js')
  const response = await fetch(scriptUrl)
  const scriptContent = await response.text()
  await cdpSession.send(tabId, 'Runtime.evaluate', {
    expression: scriptContent,
    returnByValue: false,
  })
}

/**
 * Evaluates arbitrary user code in the page via CDP Runtime.evaluate.
 * Returns JSON-stringified result or error details.
 */
async function evaluateInPage(
  tabId: number,
  code: string,
): Promise<{ result: string; isError: boolean }> {
  // Wrap in eval so arbitrary expressions and statements both work
  const expression = `(function() { try { var __r = eval(${JSON.stringify(code)}); return { result: JSON.stringify(__r) !== undefined ? JSON.stringify(__r) : 'undefined', isError: false }; } catch(e) { return { result: e instanceof Error ? e.message : String(e), isError: true }; } })()`

  const res = await cdpSession.send<CDPEvaluateResult>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  })

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

function pageGenerateAccessibilityTree(
  filter: string,
  depth: number,
  maxChars: number,
  refId: string | null,
  compact: boolean,
): AccessibilityTreeResult {
  type WinWithAccessibilityTree = Window &
    typeof globalThis & {
      __generateAccessibilityTree?: (
        filter: string,
        depth: number,
        maxChars: number,
        refId?: string,
        compact?: boolean,
      ) => AccessibilityTreeResult
    }
  const win = window as WinWithAccessibilityTree
  if (typeof win.__generateAccessibilityTree !== 'function') {
    return {
      pageContent:
        '(accessibility tree not available — content script not loaded)',
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  }
  return win.__generateAccessibilityTree(
    filter,
    depth,
    maxChars,
    refId ?? undefined,
    compact,
  )
}

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

type FormInputResult =
  | { success: true; message: string }
  | { success: false; error: string }

function pageFormInput(refId: number, inputValue: string): FormInputResult {
  type WinWithRefId = Window &
    typeof globalThis & {
      __getElementByRefId?: (refId: number) => Element | null
    }
  const win = window as WinWithRefId
  if (typeof win.__getElementByRefId !== 'function') {
    return {
      success: false,
      error:
        'form_input: content script not loaded (__getElementByRefId not available)',
    }
  }

  const el = win.__getElementByRefId(refId)
  if (!el) {
    return {
      success: false,
      error: `form_input: element ref_${refId} not found`,
    }
  }

  const tag = el.tagName.toLowerCase()

  if (tag === 'input') {
    const inputEl = el as HTMLInputElement
    const inputType = inputEl.type.toLowerCase()

    if (inputType === 'checkbox' || inputType === 'radio') {
      const checked =
        inputValue === 'true' || inputValue === '1' || inputValue === 'on'
      inputEl.checked = checked
      inputEl.dispatchEvent(new Event('change', { bubbles: true }))
      return {
        success: true,
        message: `Set ${inputType} ref_${refId} to ${String(checked)}`,
      }
    } else {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(inputEl, inputValue)
      } else {
        inputEl.value = inputValue
      }
      inputEl.dispatchEvent(new Event('input', { bubbles: true }))
      inputEl.dispatchEvent(new Event('change', { bubbles: true }))
      return {
        success: true,
        message: `Set input ref_${refId} value to "${inputValue}"`,
      }
    }
  } else if (tag === 'select') {
    const selectEl = el as HTMLSelectElement
    const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )?.set
    if (nativeSelectValueSetter) {
      nativeSelectValueSetter.call(selectEl, inputValue)
    } else {
      selectEl.value = inputValue
    }
    selectEl.dispatchEvent(new Event('change', { bubbles: true }))
    return {
      success: true,
      message: `Set select ref_${refId} value to "${inputValue}"`,
    }
  } else if (tag === 'textarea') {
    const textareaEl = el as HTMLTextAreaElement
    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set
    if (nativeTextareaValueSetter) {
      nativeTextareaValueSetter.call(textareaEl, inputValue)
    } else {
      textareaEl.value = inputValue
    }
    textareaEl.dispatchEvent(new Event('input', { bubbles: true }))
    textareaEl.dispatchEvent(new Event('change', { bubbles: true }))
    return {
      success: true,
      message: `Set textarea ref_${refId} value to "${inputValue}"`,
    }
  } else if ((el as HTMLElement).contentEditable === 'true') {
    ;(el as HTMLElement).textContent = inputValue
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return {
      success: true,
      message: `Set contenteditable ref_${refId} value to "${inputValue}"`,
    }
  } else {
    return {
      success: false,
      error: `form_input: element ref_${refId} is a <${tag}>, not a form input`,
    }
  }
}

// ---------------------------------------------------------------------------
// read_page tool
// ---------------------------------------------------------------------------

async function executeReadPage(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const filter = getString(args, 'filter', 'interactive') as
    | 'interactive'
    | 'all'
  const depth = getNumber(args, 'depth', 10) ?? 10
  const maxChars = getNumber(args, 'maxChars', 50000) ?? 50000
  const refId = getString(args, 'refId')
  const compact = args['compact'] === true

  if (filter !== 'interactive' && filter !== 'all') {
    throw new Error('read_page: "filter" must be "interactive" or "all"')
  }

  // Ensure accessibility tree content script is loaded (works on frozen tabs)
  await ensureAccessibilityScript(tabId)

  const treeResult = await executeInPage(
    tabId,
    pageGenerateAccessibilityTree,
    [filter, depth, maxChars, refId ?? null, compact],
  ) as AccessibilityTreeResult

  const { pageContent, viewport } = treeResult
  const header = `Viewport: ${viewport.width}x${viewport.height}\n\n`

  return {
    content: [
      {
        type: 'text',
        text: header + pageContent,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// find tool
// ---------------------------------------------------------------------------

async function executeFind(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const description = getString(args, 'description')
  if (!description) {
    throw new Error('find: "description" is required')
  }

  // Ensure accessibility tree content script is loaded (works on frozen tabs)
  await ensureAccessibilityScript(tabId)

  // Get the full accessibility tree (use 'all' filter to find any element)
  // Pass null (not undefined/void 0) as refId — Chrome cannot serialize undefined
  const treeResult = await executeInPage(
    tabId,
    pageGenerateAccessibilityTree,
    ['all', 10, 100000, null],
  ) as AccessibilityTreeResult

  const { pageContent } = treeResult

  // Search for lines matching the description (case-insensitive)
  const descLower = description.toLowerCase()
  const lines = pageContent.split('\n')

  type ScoredLine = { line: string; score: number }
  const scored: ScoredLine[] = []

  for (const line of lines) {
    if (!line.trim()) continue

    // Only consider lines with a ref ID
    if (!line.match(/\[ref_\d+\]/)) continue

    const lineLower = line.toLowerCase()

    // Score by how many words of description appear in the line
    const descWords = descLower.split(/\s+/).filter(Boolean)
    let score = 0

    for (const word of descWords) {
      if (lineLower.includes(word)) {
        score++
      }
    }

    if (score > 0) {
      scored.push({ line: line.trim(), score })
    }
  }

  if (scored.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No elements found matching: "${description}"`,
        },
      ],
    }
  }

  // Sort by score descending, take top 5 matches
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, 5)

  const resultText = top.map((m) => m.line).join('\n')

  return {
    content: [
      {
        type: 'text',
        text: `Found ${scored.length} matching element(s). Top results:\n\n${resultText}`,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// get_page_text tool
// ---------------------------------------------------------------------------

async function executeGetPageText(
  tabId: number,
  _rawArgs: unknown,
): Promise<ToolResult> {
  const MAX_CHARS = 50000

  const text = await executeInPage(
    tabId,
    pageGetBodyText,
    [MAX_CHARS],
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
// form_input tool
// ---------------------------------------------------------------------------

async function executeFormInput(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const refIdStr = getString(args, 'refId')
  if (!refIdStr) {
    throw new Error('form_input: "refId" is required')
  }

  if (typeof args['value'] === 'undefined') {
    throw new Error('form_input: "value" is required')
  }
  const value = String(args['value'])

  // Parse ref_X format
  const match = refIdStr.match(/^ref_(\d+)$/)
  if (!match) {
    throw new Error(
      `form_input: "refId" must be in format "ref_X" (e.g., "ref_42"), got "${refIdStr}"`,
    )
  }
  const refIdNum = parseInt(match[1]!, 10)

  const result = await executeInPage(
    tabId,
    pageFormInput,
    [refIdNum, value],
  ) as FormInputResult

  if (!result.success) {
    return {
      content: [{ type: 'text', text: result.error }],
      isError: true,
    } as ToolResult & { isError: true }
  }

  return {
    content: [{ type: 'text', text: result.message }],
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

  const { result, isError } = await evaluateInPage(tabId, code)

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
// scroll_element tool
// ---------------------------------------------------------------------------

type ScrollElementResult =
  | { success: true; x: number; y: number; message: string }
  | { success: false; error: string }

function pageGetElementScrollCenter(refId: number): ScrollElementResult {
  type WinWithRefId = Window &
    typeof globalThis & {
      __getElementByRefId?: (refId: number) => Element | null
    }
  const win = window as WinWithRefId
  if (typeof win.__getElementByRefId !== 'function') {
    return { success: false, error: 'scroll_element: content script not loaded' }
  }
  const el = win.__getElementByRefId(refId)
  if (!el) {
    return { success: false, error: `scroll_element: element ref_${refId} not found` }
  }
  const rect = el.getBoundingClientRect()
  const x = Math.round(rect.left + rect.width / 2)
  const y = Math.round(rect.top + rect.height / 2)
  return { success: true, x, y, message: `Scrolling ref_${refId} at (${x}, ${y})` }
}

async function executeScrollElement(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const refIdStr = getString(args, 'refId')
  if (!refIdStr) throw new Error('scroll_element: "refId" is required')

  const match = refIdStr.match(/^ref_(\d+)$/)
  if (!match) throw new Error(`scroll_element: "refId" must be in format "ref_X", got "${refIdStr}"`)
  const refIdNum = parseInt(match[1]!, 10)

  const direction = getString(args, 'direction', 'down') as string
  if (!['up', 'down', 'left', 'right'].includes(direction)) {
    throw new Error('scroll_element: "direction" must be one of: up, down, left, right')
  }
  const amount = getNumber(args, 'amount', 3) ?? 3
  const PIXELS_PER_UNIT = 120

  await ensureAccessibilityScript(tabId)

  const result = await executeInPage(tabId, pageGetElementScrollCenter, [refIdNum]) as ScrollElementResult
  if (!result.success) {
    return { content: [{ type: 'text', text: result.error }], isError: true } as ToolResult & { isError: true }
  }

  const { x, y } = result
  let deltaX = 0
  let deltaY = 0
  switch (direction) {
    case 'up': deltaY = -amount * PIXELS_PER_UNIT; break
    case 'down': deltaY = amount * PIXELS_PER_UNIT; break
    case 'left': deltaX = -amount * PIXELS_PER_UNIT; break
    case 'right': deltaX = amount * PIXELS_PER_UNIT; break
  }

  await cdpSession.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX, deltaY,
  })

  return { content: [{ type: 'text', text: result.message }] }
}

// ---------------------------------------------------------------------------
// fill_element tool
// ---------------------------------------------------------------------------

type FillElementResult =
  | { success: true; x: number; y: number; message: string }
  | { success: false; error: string }

function pageGetElementCenterForFill(refId: number): FillElementResult {
  type WinWithRefId = Window &
    typeof globalThis & {
      __getElementByRefId?: (refId: number) => Element | null
    }
  const win = window as WinWithRefId
  if (typeof win.__getElementByRefId !== 'function') {
    return { success: false, error: 'fill_element: content script not loaded' }
  }
  const el = win.__getElementByRefId(refId)
  if (!el) {
    return { success: false, error: `fill_element: element ref_${refId} not found` }
  }
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    return { success: false, error: `fill_element: element ref_${refId} has zero size (may be hidden)` }
  }
  const x = Math.round(rect.left + rect.width / 2)
  const y = Math.round(rect.top + rect.height / 2)
  return { success: true, x, y, message: `Filling ref_${refId}` }
}

async function executeFillElement(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const refIdStr = getString(args, 'refId')
  if (!refIdStr) throw new Error('fill_element: "refId" is required')

  const match = refIdStr.match(/^ref_(\d+)$/)
  if (!match) throw new Error(`fill_element: "refId" must be in format "ref_X", got "${refIdStr}"`)
  const refIdNum = parseInt(match[1]!, 10)

  if (typeof args['text'] === 'undefined') throw new Error('fill_element: "text" is required')
  const text = String(args['text'])

  await ensureAccessibilityScript(tabId)

  // Click to focus
  const centerResult = await executeInPage(tabId, pageGetElementCenterForFill, [refIdNum]) as FillElementResult
  if (!centerResult.success) {
    return { content: [{ type: 'text', text: centerResult.error }], isError: true } as ToolResult & { isError: true }
  }

  const { x, y } = centerResult

  // Triple-click to select all existing text
  await cdpSession.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (let i = 1; i <= 3; i++) {
    await cdpSession.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i })
    await cdpSession.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i })
  }

  // Insert new text (replaces selection)
  if (text.length > 0) {
    await cdpSession.send(tabId, 'Input.insertText', { text })
  }

  return { content: [{ type: 'text', text: `Filled ref_${refIdStr} with: ${JSON.stringify(text)}` }] }
}

// ---------------------------------------------------------------------------
// click_element tool
// ---------------------------------------------------------------------------

type ClickElementResult =
  | { success: true; x: number; y: number; message: string }
  | { success: false; error: string }

function pageGetElementCenter(refId: number): ClickElementResult {
  type WinWithRefId = Window &
    typeof globalThis & {
      __getElementByRefId?: (refId: number) => Element | null
    }
  const win = window as WinWithRefId
  if (typeof win.__getElementByRefId !== 'function') {
    return { success: false, error: 'click_element: content script not loaded' }
  }
  const el = win.__getElementByRefId(refId)
  if (!el) {
    return { success: false, error: `click_element: element ref_${refId} not found` }
  }
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    return { success: false, error: `click_element: element ref_${refId} has zero size (may be hidden)` }
  }
  const x = Math.round(rect.left + rect.width / 2)
  const y = Math.round(rect.top + rect.height / 2)
  return { success: true, x, y, message: `Clicking ref_${refId} at (${x}, ${y})` }
}

async function executeClickElement(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const refIdStr = getString(args, 'refId')
  if (!refIdStr) {
    throw new Error('click_element: "refId" is required')
  }

  const match = refIdStr.match(/^ref_(\d+)$/)
  if (!match) {
    throw new Error(`click_element: "refId" must be in format "ref_X", got "${refIdStr}"`)
  }
  const refIdNum = parseInt(match[1]!, 10)

  await ensureAccessibilityScript(tabId)

  const result = await executeInPage(
    tabId,
    pageGetElementCenter,
    [refIdNum],
  ) as ClickElementResult

  if (!result.success) {
    return { content: [{ type: 'text', text: result.error }], isError: true } as ToolResult & { isError: true }
  }

  const { x, y } = result

  // Dispatch mouse events via CDP
  await cdpSession.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
  })
  await cdpSession.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  })
  await cdpSession.send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  })

  return { content: [{ type: 'text', text: result.message }] }
}

// ---------------------------------------------------------------------------
// get_element_info tool
// ---------------------------------------------------------------------------

interface ElementInfo {
  role: string
  tagName: string
  textContent: string
  innerHTML: string
  value: string | null
  attributes: Record<string, string>
  boundingBox: { x: number; y: number; width: number; height: number }
  computedStyles: Record<string, string>
  isVisible: boolean
}

type GetElementInfoResult =
  | { success: true; info: ElementInfo }
  | { success: false; error: string }

function pageGetElementInfo(refId: number): GetElementInfoResult {
  type WinWithRefId = Window &
    typeof globalThis & {
      __getElementByRefId?: (refId: number) => Element | null
    }
  const win = window as WinWithRefId
  if (typeof win.__getElementByRefId !== 'function') {
    return { success: false, error: 'get_element_info: content script not loaded' }
  }
  const el = win.__getElementByRefId(refId)
  if (!el) {
    return { success: false, error: `get_element_info: element ref_${refId} not found` }
  }

  const rect = el.getBoundingClientRect()
  const style = window.getComputedStyle(el)

  // Collect all attributes
  const attributes: Record<string, string> = {}
  for (const attr of Array.from(el.attributes)) {
    attributes[attr.name] = attr.value
  }

  // Key computed styles
  const styleKeys = ['display', 'visibility', 'opacity', 'position', 'overflow', 'cursor', 'color', 'backgroundColor', 'fontSize', 'fontWeight']
  const computedStyles: Record<string, string> = {}
  for (const key of styleKeys) {
    computedStyles[key] = style.getPropertyValue(key.replace(/([A-Z])/g, '-$1').toLowerCase())
  }

  // Value (for form elements)
  let value: string | null = null
  if ('value' in el) {
    value = String((el as HTMLInputElement).value)
  }

  const isVisible = rect.width > 0 && rect.height > 0 &&
    style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'

  // Truncate innerHTML to avoid huge outputs
  const inner = el.innerHTML
  const truncatedInner = inner.length > 500 ? inner.slice(0, 500) + '…' : inner

  const text = el.textContent?.trim() ?? ''
  const truncatedText = text.length > 200 ? text.slice(0, 200) + '…' : text

  return {
    success: true,
    info: {
      role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
      tagName: el.tagName.toLowerCase(),
      textContent: truncatedText,
      innerHTML: truncatedInner,
      value,
      attributes,
      boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      computedStyles,
      isVisible,
    },
  }
}

async function executeGetElementInfo(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const refIdStr = getString(args, 'refId')
  if (!refIdStr) throw new Error('get_element_info: "refId" is required')

  const match = refIdStr.match(/^ref_(\d+)$/)
  if (!match) throw new Error(`get_element_info: "refId" must be in format "ref_X", got "${refIdStr}"`)
  const refIdNum = parseInt(match[1]!, 10)

  await ensureAccessibilityScript(tabId)

  const result = await executeInPage(tabId, pageGetElementInfo, [refIdNum]) as GetElementInfoResult
  if (!result.success) {
    return { content: [{ type: 'text', text: result.error }], isError: true } as ToolResult & { isError: true }
  }

  const { info } = result
  const lines: string[] = [
    `tag: ${info.tagName}`,
    `role: ${info.role}`,
    `visible: ${String(info.isVisible)}`,
    `boundingBox: x=${info.boundingBox.x} y=${info.boundingBox.y} width=${info.boundingBox.width} height=${info.boundingBox.height}`,
  ]
  if (info.value !== null) lines.push(`value: ${info.value}`)
  if (info.textContent) lines.push(`textContent: ${info.textContent}`)
  if (Object.keys(info.attributes).length > 0) {
    lines.push(`attributes: ${JSON.stringify(info.attributes)}`)
  }
  lines.push(`computedStyles: ${JSON.stringify(info.computedStyles)}`)
  if (info.innerHTML) lines.push(`innerHTML: ${info.innerHTML}`)

  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

// ---------------------------------------------------------------------------
// wait_for_element tool
// ---------------------------------------------------------------------------

function pageCheckElementPresent(refId: number | null, description: string | null): boolean {
  type WinWithAccessibilityTree = Window &
    typeof globalThis & {
      __getElementByRefId?: (refId: number) => Element | null
      __generateAccessibilityTree?: (
        filter: string, depth: number, maxChars: number,
        refId?: string, compact?: boolean,
      ) => { pageContent: string; viewport: { width: number; height: number } }
    }
  const win = window as WinWithAccessibilityTree

  if (refId !== null) {
    if (typeof win.__getElementByRefId !== 'function') return false
    const el = win.__getElementByRefId(refId)
    if (!el) return false
    // Check element is actually visible
    const rect = el.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }

  if (description !== null && typeof win.__generateAccessibilityTree === 'function') {
    const tree = win.__generateAccessibilityTree('interactive', 10, 100000, undefined, false)
    const descLower = description.toLowerCase()
    const words = descLower.split(/\s+/).filter(Boolean)
    for (const line of tree.pageContent.split('\n')) {
      if (!line.match(/\[ref_\d+\]/)) continue
      const lineLower = line.toLowerCase()
      let score = 0
      for (const w of words) { if (lineLower.includes(w)) score++ }
      if (score === words.length) return true
    }
    return false
  }

  return false
}

async function executeWaitForElement(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const refIdStr = getString(args, 'refId')
  const description = getString(args, 'description')

  if (!refIdStr && !description) {
    throw new Error('wait_for_element: either "refId" or "description" is required')
  }

  let refIdNum: number | null = null
  if (refIdStr) {
    const match = refIdStr.match(/^ref_(\d+)$/)
    if (!match) throw new Error(`wait_for_element: "refId" must be in format "ref_X", got "${refIdStr}"`)
    refIdNum = parseInt(match[1]!, 10)
  }

  const timeoutMs = (getNumber(args, 'timeout', 10000) ?? 10000)
  const pollMs = 500
  const deadline = Date.now() + timeoutMs

  await ensureAccessibilityScript(tabId)

  while (Date.now() < deadline) {
    const found = await executeInPage(
      tabId,
      pageCheckElementPresent,
      [refIdNum, description ?? null],
    ) as boolean

    if (found) {
      const label = refIdStr ?? `"${description}"`
      return { content: [{ type: 'text', text: `Element ${label} is present.` }] }
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)))
  }

  const label = refIdStr ?? `"${description}"`
  return {
    content: [{ type: 'text', text: `Timeout: element ${label} did not appear within ${timeoutMs}ms.` }],
    isError: true,
  } as ToolResult & { isError: true }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool('read_page', executeReadPage)
registerTool('find', executeFind)
registerTool('get_page_text', executeGetPageText)
registerTool('extract_page', executeExtractPage)
registerTool('form_input', executeFormInput)
registerTool('javascript_tool', executeJavaScriptTool)
registerTool('click_element', executeClickElement)
registerTool('scroll_element', executeScrollElement)
registerTool('fill_element', executeFillElement)
registerTool('get_element_info', executeGetElementInfo)
registerTool('wait_for_element', executeWaitForElement)
