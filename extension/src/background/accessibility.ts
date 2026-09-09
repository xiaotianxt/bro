// Browser-owned AX nodes, with short tab/snapshot-scoped handles. Never persist
// identity in page attributes: cloned DOM and new documents must not inherit it.
export interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  properties?: Array<{ name: string; value: { value?: unknown } }>
  backendDOMNodeId?: number
  childIds?: string[]
}

export interface FrameSnapshot {
  id: string
  parentId?: string
  loaderId: string
  url: string
  nodes: AXNode[]
  error?: string
}

export interface RefTarget {
  frameId: string
  loaderId: string
  backendNodeId: number
}

export class SnapshotStore {
  private readonly tabs = new Map<number, Map<string, RefTarget>>()

  publish(tabId: number, refs: Map<string, RefTarget>): void {
    this.tabs.set(tabId, refs)
  }

  resolve(tabId: number, ref: string): RefTarget {
    const target = this.tabs.get(tabId)?.get(ref)
    if (!target)
      throw new Error(
        'Stale or unknown ref. Read a fresh accessibility snapshot for this tab; do not guess refs.',
      )
    return target
  }

  clear(tabId: number): void {
    this.tabs.delete(tabId)
  }
}

export interface SnapshotOptions {
  filter: 'interactive' | 'all'
  depth: number
  maxChars: number
  compact?: boolean
}

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'tab',
  'treeitem',
  'listbox',
  'option',
])
const STATES = new Set([
  'checked',
  'selected',
  'expanded',
  'disabled',
  'readonly',
  'required',
  'multiselectable',
])
const quoted = (value: unknown): string => JSON.stringify(String(value ?? ''))

export function renderSnapshot(
  store: SnapshotStore,
  tabId: number,
  frames: FrameSnapshot[],
  options: SnapshotOptions,
): { text: string; truncated: boolean; unavailableFrames: number } {
  const refs = new Map<string, RefTarget>()
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  const suffix = '\n[Snapshot truncated; narrow the scope or increase maxChars.]'
  let text = ''
  let truncated = false
  const append = (line: string): boolean => {
    if (text.length + line.length + suffix.length > options.maxChars) {
      truncated = true
      return false
    }
    text += line
    return true
  }
  append(
    `Accessibility snapshot — refs belong to this tab and snapshot; re-read after navigation or DOM replacement.\nFrames: ${frames.length}; unavailable: ${frames.filter((f) => f.error).length}\n`,
  )
  const seenFrames = new Set<string>()
  const renderFrame = (frame: FrameSnapshot, frameDepth: number): void => {
    if (seenFrames.has(frame.id) || truncated) return
    seenFrames.add(frame.id)
    const prefix = '  '.repeat(frameDepth)
    if (
      !append(
        `${prefix}Frame ${quoted(frame.id)} ${quoted(frame.url)}${frame.error ? ` [unavailable: ${frame.error}]` : ''}\n`,
      )
    )
      return
    const nodes = new Map(frame.nodes.map((node) => [node.nodeId, node]))
    const seenNodes = new Set<string>()
    const walk = (node: AXNode, depth: number): void => {
      if (seenNodes.has(node.nodeId) || truncated || depth > options.depth) return
      seenNodes.add(node.nodeId)
      const role = String(node.role?.value ?? '')
      const properties = new Map(node.properties?.map((p) => [p.name, p.value.value]))
      const rawName = String(node.name?.value ?? '').trim()
      const name = rawName.length > 300 ? rawName.slice(0, 300) + '…' : rawName
      const interactive =
        INTERACTIVE.has(role) || properties.get('editable') || properties.get('focusable') === true
      const structural =
        ['generic', 'none', 'LabelText', 'MenuListPopup'].includes(role) && !name && !interactive
      const show =
        !node.ignored &&
        role !== 'InlineTextBox' &&
        !(options.compact !== false && structural) &&
        (options.filter === 'all' || interactive || role === 'RootWebArea' || role === 'Iframe')
      if (show) {
        const ref =
          node.backendDOMNodeId && !['RootWebArea', 'StaticText', 'LineBreak'].includes(role)
            ? `ref_${nonce}_${refs.size + 1}`
            : undefined
        let line = `${prefix}${'  '.repeat(depth + 1)}${ref ? `[${ref}] ` : ''}${role} ${quoted(name)}`
        if (node.value?.value !== undefined && !properties.get('protected')) {
          const value = String(node.value.value)
          line += ` value=${quoted(value.length > 500 ? value.slice(0, 500) + '…' : value)}`
          if (value.length > 500) line += ' valueTruncated=true'
        }
        for (const [key, value] of properties) {
          if (
            STATES.has(key) &&
            !(value === false && ['readonly', 'required', 'disabled'].includes(key))
          )
            line += ` ${key}=${quoted(value)}`
        }
        if (!append(line + '\n')) return
        if (ref && node.backendDOMNodeId)
          refs.set(ref, {
            frameId: frame.id,
            loaderId: frame.loaderId,
            backendNodeId: node.backendDOMNodeId,
          })
      }
      if (properties.get('protected')) return
      for (const child of node.childIds ?? []) {
        const next = nodes.get(child)
        if (next) walk(next, depth + (show ? 1 : 0))
      }
    }
    // AX node IDs are local to a document/target, not globally unique.
    const childIds = new Set(frame.nodes.flatMap((n) => n.childIds ?? []))
    for (const node of frame.nodes) if (!childIds.has(node.nodeId)) walk(node, 0)
    for (const child of frames) if (child.parentId === frame.id) renderFrame(child, frameDepth + 1)
  }
  for (const frame of frames)
    if (!frames.some((f) => f.id === frame.parentId)) renderFrame(frame, 0)
  if (truncated) text += suffix
  store.publish(tabId, refs)
  return {
    text: text.slice(0, options.maxChars),
    truncated,
    unavailableFrames: frames.filter((f) => f.error).length,
  }
}
