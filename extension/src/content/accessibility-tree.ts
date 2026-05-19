// Content script: injected into all pages at document_start
// Injects the __generateAccessibilityTree function into the page context.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccessibilityTreeResult {
  pageContent: string
  viewport: { width: number; height: number }
}

type AccessibilityFilter = 'interactive' | 'all'

// Structural roles with no semantic meaning on their own
const STRUCTURAL_ROLES = new Set(['generic', 'group', 'list', 'listitem', 'row', 'cell', 'region', 'article', 'section'])

// ---------------------------------------------------------------------------
// Element map for stable ref IDs
// ---------------------------------------------------------------------------

// Counter for generating unique ref IDs
let refIdCounter = 0

// Map from ref ID number to WeakRef of DOM element
const elementMap = new Map<number, WeakRef<Element>>()

/**
 * Gets or creates a stable numeric ref ID for the given element.
 * Stores a WeakRef to avoid memory leaks.
 */
function getOrCreateRefId(el: Element): number {
  // Check if element already has a ref ID stored as a data attribute
  const existing = (el as HTMLElement).dataset?.['obmcpRefId']
  if (existing !== undefined) {
    const num = parseInt(existing, 10)
    if (!isNaN(num)) {
      // Ensure it's still in the map
      if (!elementMap.has(num)) {
        elementMap.set(num, new WeakRef(el))
      }
      return num
    }
  }

  // Assign a new ID
  const id = ++refIdCounter
  elementMap.set(id, new WeakRef(el))

  // Store in element dataset if accessible
  try {
    ;(el as HTMLElement).dataset['obmcpRefId'] = String(id)
  } catch {
    // Ignore if element doesn't support dataset
  }

  return id
}

/**
 * Gets a DOM element by its ref ID.
 */
function getElementByRefId(refId: number): Element | null {
  const weakRef = elementMap.get(refId)
  if (!weakRef) return null
  const el = weakRef.deref()
  if (!el) {
    // Element was garbage collected
    elementMap.delete(refId)
    return null
  }
  return el
}

// ---------------------------------------------------------------------------
// Accessibility helpers
// ---------------------------------------------------------------------------

/**
 * Gets the accessible name for an element following ARIA conventions.
 */
function getAccessibleName(el: Element): string {
  // aria-label takes highest priority
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel?.trim()) return ariaLabel.trim()

  // aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
    if (parts.length > 0) return parts.join(' ')
  }

  // For inputs, check associated label
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const inputEl = el as HTMLInputElement
    // Check 'id' for associated label
    if (inputEl.id) {
      const label = document.querySelector(`label[for="${CSS.escape(inputEl.id)}"]`)
      if (label?.textContent?.trim()) return label.textContent.trim()
    }
    // Check placeholder
    if ((el as HTMLInputElement).placeholder) {
      return (el as HTMLInputElement).placeholder
    }
    // Check value for inputs
    if ('value' in el && (el as HTMLInputElement).value) {
      return String((el as HTMLInputElement).value)
    }
  }

  // For images, use alt text
  if (el instanceof HTMLImageElement && el.alt) {
    return el.alt
  }

  // Use title attribute
  const title = el.getAttribute('title')
  if (title?.trim()) return title.trim()

  // Use inner text content (truncated)
  const text = el.textContent?.trim() ?? ''
  if (text) {
    return text.length > 80 ? text.slice(0, 80) + '…' : text
  }

  return ''
}

/**
 * Gets the ARIA role for an element, falling back to implicit role.
 */
function getRole(el: Element): string {
  // Explicit ARIA role
  const ariaRole = el.getAttribute('role')
  if (ariaRole?.trim()) return ariaRole.trim()

  // Implicit roles based on tag
  const tag = el.tagName.toLowerCase()

  switch (tag) {
    case 'a':
      return (el as HTMLAnchorElement).href ? 'link' : 'generic'
    case 'button':
      return 'button'
    case 'input': {
      const type = (el as HTMLInputElement).type.toLowerCase()
      switch (type) {
        case 'button':
        case 'submit':
        case 'reset':
          return 'button'
        case 'checkbox':
          return 'checkbox'
        case 'radio':
          return 'radio'
        case 'range':
          return 'slider'
        case 'search':
          return 'searchbox'
        case 'number':
          return 'spinbutton'
        default:
          return 'textbox'
      }
    }
    case 'select':
      return 'combobox'
    case 'textarea':
      return 'textbox'
    case 'img':
      return 'img'
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading'
    case 'nav':
      return 'navigation'
    case 'main':
      return 'main'
    case 'header':
      return 'banner'
    case 'footer':
      return 'contentinfo'
    case 'aside':
      return 'complementary'
    case 'section':
      return 'region'
    case 'article':
      return 'article'
    case 'form':
      return 'form'
    case 'table':
      return 'table'
    case 'tr':
      return 'row'
    case 'td':
      return 'cell'
    case 'th':
      return 'columnheader'
    case 'ul':
    case 'ol':
      return 'list'
    case 'li':
      return 'listitem'
    case 'dialog':
      return 'dialog'
    case 'details':
      return 'group'
    case 'summary':
      return 'button'
    case 'p':
      return 'paragraph'
    case 'span':
    case 'div':
      return 'generic'
    default:
      return tag
  }
}

/**
 * Returns true if the element is interactive.
 */
function isInteractive(el: Element): boolean {
  const role = getRole(el)
  const interactiveRoles = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'slider',
    'spinbutton',
    'searchbox',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'switch',
    'tab',
  ])
  if (interactiveRoles.has(role)) return true

  const tag = el.tagName.toLowerCase()
  if (tag === 'a' && (el as HTMLAnchorElement).href) return true
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return true
  if ((el as HTMLElement).tabIndex !== undefined && (el as HTMLElement).tabIndex >= 0) {
    // Check if it has a valid tabIndex set (not -1)
    const tabIndex = (el as HTMLElement).getAttribute('tabindex')
    if (tabIndex !== null && parseInt(tabIndex) >= 0) return true
  }
  if ((el as HTMLElement).contentEditable === 'true') return true

  return false
}

/**
 * Returns true if the element is meaningless (should be skipped for 'all' filter).
 */
function isMeaningless(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  const meaninglessTags = new Set(['script', 'style', 'noscript', 'meta', 'link', 'head', 'html', 'br', 'hr', 'wbr'])
  return meaninglessTags.has(tag)
}

/**
 * Returns true if the element is hidden/invisible.
 */
function isHidden(el: Element): boolean {
  // Check aria-hidden
  if (el.getAttribute('aria-hidden') === 'true') return true

  // Check display and visibility via computed style
  try {
    const style = window.getComputedStyle(el)
    if (style.display === 'none') return true
    if (style.visibility === 'hidden') return true
    if (style.opacity === '0') return true
  } catch {
    // Ignore errors (cross-origin frames, etc.)
  }

  return false
}

// ---------------------------------------------------------------------------
// Tree walker
// ---------------------------------------------------------------------------


interface WalkOptions {
  filter: AccessibilityFilter
  maxDepth: number
  maxChars: number
  compact: boolean
}

interface WalkState {
  output: string[]
  totalChars: number
  truncated: boolean
}

function walkElement(
  el: Element,
  depth: number,
  opts: WalkOptions,
  state: WalkState,
): void {
  if (state.truncated) return
  if (depth > opts.maxDepth) return
  if (isHidden(el)) return
  if (isMeaningless(el)) return

  const role = getRole(el)
  const tag = el.tagName.toLowerCase()

  // For 'interactive' filter, skip non-interactive elements but still recurse
  const isOutputtable = opts.filter === 'all' || isInteractive(el)

  // Compact mode: suppress printing unnamed structural wrappers as their own
  // line (they still recurse so their children appear). This avoids noise
  // lines like "[ref_5] generic" or "[ref_12] group" with no name.
  const suppressedByCompact =
    opts.compact &&
    isOutputtable &&
    STRUCTURAL_ROLES.has(role) &&
    !getAccessibleName(el)

  const shouldOutput = isOutputtable && !suppressedByCompact

  if (shouldOutput) {
    const name = getAccessibleName(el)
    const refId = getOrCreateRefId(el)
    const indent = '  '.repeat(depth)

    let line = `${indent}[ref_${refId}] ${role}`

    if (name) {
      line += ` "${name}"`
    }

    // Extra attributes for specific element types
    if (tag === 'a') {
      const href = (el as HTMLAnchorElement).href
      if (href && !href.startsWith('javascript:')) {
        // Truncate long URLs
        const displayHref = href.length > 100 ? href.slice(0, 100) + '…' : href
        line += ` href="${displayHref}"`
      }
    }

    if (tag === 'input') {
      const inputEl = el as HTMLInputElement
      const inputType = inputEl.type || 'text'
      line += ` type="${inputType}"`
      if (inputEl.placeholder) {
        line += ` placeholder="${inputEl.placeholder}"`
      }
    }

    if (tag === 'select') {
      const selectEl = el as HTMLSelectElement
      if (selectEl.value) {
        line += ` value="${selectEl.value}"`
      }
    }

    if (tag === 'textarea') {
      const textareaEl = el as HTMLTextAreaElement
      if (textareaEl.placeholder) {
        line += ` placeholder="${textareaEl.placeholder}"`
      }
    }

    if (tag === 'input' && ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio')) {
      const checked = (el as HTMLInputElement).checked
      line += ` checked=${String(checked)}`
    }

    line += '\n'

    const newTotal = state.totalChars + line.length
    if (newTotal > opts.maxChars) {
      state.output.push('[... output truncated due to length limit ...]\n')
      state.truncated = true
      return
    }
    state.output.push(line)
    state.totalChars = newTotal
  }

  // Recurse into shadow root first (if present), then light DOM children
  if (el.shadowRoot) {
    const shadowChildren = el.shadowRoot.children
    for (let i = 0; i < shadowChildren.length; i++) {
      const child = shadowChildren[i]
      if (child) {
        walkElement(child, depth + 1, opts, state)
        if (state.truncated) return
      }
    }
  }

  const children = el.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child) {
      walkElement(child, depth + 1, opts, state)
      if (state.truncated) return
    }
  }
}

// ---------------------------------------------------------------------------
// Main injection functions
// ---------------------------------------------------------------------------

function generateAccessibilityTree(
  filter: AccessibilityFilter = 'interactive',
  depth: number = 10,
  maxChars: number = 50000,
  refId?: number | string,
  compact: boolean = false,
): AccessibilityTreeResult {
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
  }

  // Determine root element
  let root: Element | null = document.body

  if (refId !== undefined) {
    // Strip 'ref_' prefix before parsing so 'ref_6' correctly becomes 6
    const refIdNum =
      typeof refId === 'string'
        ? parseInt(refId.replace(/^ref_/, ''), 10)
        : refId
    if (!isNaN(refIdNum)) {
      const found = getElementByRefId(refIdNum)
      if (found) {
        root = found
      }
    }
  }

  if (!root) {
    return {
      pageContent: '(no body element found)',
      viewport,
    }
  }

  const opts: WalkOptions = {
    filter,
    maxDepth: depth,
    maxChars,
    compact,
  }

  const state: WalkState = {
    output: [],
    totalChars: 0,
    truncated: false,
  }

  // Add page title as header
  const title = document.title
  if (title) {
    const titleLine = `Page: ${title}\n\n`
    state.output.push(titleLine)
    state.totalChars += titleLine.length
  }

  walkElement(root, 0, opts, state)

  return {
    pageContent: state.output.join(''),
    viewport,
  }
}

// ---------------------------------------------------------------------------
// Inject into window object
// ---------------------------------------------------------------------------

// Expose the functions on window for use by chrome.scripting.executeScript
// We use Object.defineProperty to avoid overwriting if already set
if (typeof window !== 'undefined') {
  // Use type assertion to add custom properties
  ;(
    window as Window &
      typeof globalThis & {
        __generateAccessibilityTree: typeof generateAccessibilityTree
        __getElementByRefId: typeof getElementByRefId
        __obmcpElementMap: typeof elementMap
      }
  ).__generateAccessibilityTree = generateAccessibilityTree

  ;(
    window as Window &
      typeof globalThis & {
        __getElementByRefId: typeof getElementByRefId
      }
  ).__getElementByRefId = getElementByRefId
  ;(
    window as Window &
      typeof globalThis & {
        __obmcpElementMap: typeof elementMap
      }
  ).__obmcpElementMap = elementMap
}

export {}
