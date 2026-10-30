// Browser-owned AX nodes, with volatile document-bound handles. Never persist
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

// Short refs are `<epoch><sequence>`, e.g. `kqx297`. A sequence is never
// reissued within an epoch; a fresh epoch per registry (service-worker restart)
// lets resolve() reject handles from an earlier registry instead of guessing.
// Three random letters make a cross-restart collision 1/17576 per restart.
export const REF_PATTERN = /^([a-z]{3})(\d+)$/

function randomEpoch(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) =>
    String.fromCharCode(97 + (byte % 26)),
  ).join('')
}

export class SnapshotStore {
  private readonly tabs = new Map<number, Map<string, RefTarget>>()
  private readonly identities = new Map<string, string>()
  private readonly retained = new Map<string, number>()
  private sequence = 0

  // FIFO retention bounds all tabs together. Protect handles in the response
  // being published; otherwise reads do not refresh age. Never recycle a handle.
  constructor(
    private readonly capacity = 10000,
    readonly epoch = randomEpoch(),
  ) {
    if (!/^[a-z]{3}$/.test(epoch)) throw new Error('Ref epoch must be three lowercase letters')
  }

  private key(tabId: number, target: RefTarget): string {
    return JSON.stringify([tabId, target.frameId, target.loaderId, target.backendNodeId])
  }

  handle(tabId: number, target: RefTarget): string {
    return this.identities.get(this.key(tabId, target)) ?? `${this.epoch}${++this.sequence}`
  }

  publish(tabId: number, refs: Map<string, RefTarget>): void {
    if (refs.size > this.capacity) throw new Error('Snapshot exceeds ref registry capacity')
    if (!refs.size) return
    let tab = this.tabs.get(tabId)
    if (!tab) this.tabs.set(tabId, (tab = new Map()))
    for (const [ref, target] of refs) {
      tab.set(ref, target)
      this.identities.set(this.key(tabId, target), ref)
      this.retained.set(ref, tabId)
    }
    for (const [ref, owner] of this.retained) {
      if (this.retained.size <= this.capacity) break
      if (!refs.has(ref)) this.remove(owner, ref)
    }
  }

  private remove(tabId: number, ref: string): void {
    const tab = this.tabs.get(tabId)!
    const target = tab.get(ref)!
    this.identities.delete(this.key(tabId, target))
    this.retained.delete(ref)
    tab.delete(ref)
    if (!tab.size) this.tabs.delete(tabId)
  }

  // Only complete frame inventories can prove a document disappeared. A
  // filtered/scoped AX tree says nothing about omitted nodes or sibling frames.
  reconcile(tabId: number, frames: Array<{ id: string; loaderId: string }>): void {
    const documents = new Map(frames.map((frame) => [frame.id, frame.loaderId]))
    for (const [ref, target] of this.tabs.get(tabId) ?? []) {
      if (documents.get(target.frameId) !== target.loaderId) this.remove(tabId, ref)
    }
  }

  resolve(tabId: number, ref: string): RefTarget {
    const target = this.tabs.get(tabId)?.get(ref)
    if (target) return target
    const epoch = REF_PATTERN.exec(ref)?.[1]
    if (epoch && epoch !== this.epoch)
      throw new Error(
        `Ref ${ref} is from an earlier page registry (the extension restarted). Observe again for fresh refs.`,
      )
    throw new Error(`Stale or unknown ref ${ref}. Observe this target again; do not guess refs.`)
  }

  clear(tabId: number): void {
    for (const ref of this.tabs.get(tabId)?.keys() ?? []) this.remove(tabId, ref)
  }
}

export interface SnapshotOptions {
  filter: 'interactive' | 'all'
  depth: number
  maxChars: number
  compact?: boolean
  matchWords?: string[]
  maxMatches?: number
  // Node lines to skip, from a previous truncated read of the same scope.
  cursor?: number
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
// Sections a truncated read can be scoped to instead of re-read with a bigger budget.
const LANDMARKS = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'article', 'region', 'form'])

export function renderSnapshot(
  store: SnapshotStore,
  tabId: number,
  frames: FrameSnapshot[],
  options: SnapshotOptions,
): { text: string; truncated: boolean; unavailableFrames: number } {
  const refs = new Map<string, RefTarget>()
  const rendered = new Map<string, string>()
  // The footer lists unread landmarks/headings as scope refs within its own
  // budget, reserved from maxChars; its cursor is at most 10 digits.
  const outlineBudget = options.matchWords ? 0 : Math.min(600, Math.floor(options.maxChars / 10))
  const reserve =
    `\n[Truncated at ${options.maxChars} chars; continue with cursor=0000000000, or scope with refId to an unread section:]`.length +
    outlineBudget
  const outline: string[] = []
  let outlineChars = 0
  let outlineFull = outlineBudget === 0
  const cursor = options.cursor ?? 0
  let text = ''
  let truncated = false
  let lines = 0
  let shown = 0
  const append = (line: string): boolean => {
    if (text.length + line.length + reserve > options.maxChars) {
      truncated = true
      return false
    }
    text += line
    return true
  }
  // Frame headers always render so continued pages keep their frame context.
  const appendNode = (line: string): 'skipped' | 'shown' | 'full' => {
    if (lines < cursor) {
      lines++
      return 'skipped'
    }
    if (!append(line)) return 'full'
    lines++
    shown++
    return 'shown'
  }
  const unavailable = frames.filter((f) => f.error).length
  append(`Frames: ${frames.length}${unavailable ? `; unavailable: ${unavailable}` : ''}${cursor ? `; from cursor=${cursor}` : ''}\n`)
  const seenFrames = new Set<string>()
  // After truncation the walk continues only to collect the outline.
  const renderFrame = (frame: FrameSnapshot, frameDepth: number): void => {
    if (seenFrames.has(frame.id) || (truncated && outlineFull)) return
    seenFrames.add(frame.id)
    const prefix = '  '.repeat(frameDepth)
    if (!truncated)
      append(
        `${prefix}Frame ${quoted(frame.id)} ${quoted(frame.url)}${frame.error ? ` [unavailable: ${frame.error}]` : ''}\n`,
      )
    const nodes = new Map(frame.nodes.map((node) => [node.nodeId, node]))
    const seenNodes = new Set<string>()
    const walk = (node: AXNode, depth: number, inLandmark: boolean): void => {
      if (seenNodes.has(node.nodeId) || (truncated && outlineFull) || depth > options.depth) return
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
        (options.filter === 'all' || interactive || role === 'RootWebArea' || role === 'Iframe') &&
        (!options.matchWords || (node.backendDOMNodeId && options.matchWords.every((word) =>
          `${role} ${name}`.toLowerCase().includes(word)))) &&
        (options.maxMatches === undefined || refs.size < options.maxMatches)
      const landmark = LANDMARKS.has(role) && (name !== '' || !['region', 'form'].includes(role))
      const target = node.backendDOMNodeId && !['RootWebArea', 'StaticText', 'LineBreak'].includes(role)
        ? { frameId: frame.id, loaderId: frame.loaderId, backendNodeId: node.backendDOMNodeId }
        : undefined
      const identity = JSON.stringify(target)
      if (
        truncated &&
        !node.ignored &&
        target &&
        ((landmark && !inLandmark) || (role === 'heading' && Number(properties.get('level') ?? 1) <= 3))
      ) {
        const ref = rendered.get(identity) ?? store.handle(tabId, target)
        const entry = `  [${ref}] ${role} ${quoted(name.length > 60 ? name.slice(0, 60) + '…' : name)}`
        if (outlineChars + entry.length + 1 > outlineBudget) {
          outlineFull = true
          return
        }
        outline.push(entry)
        outlineChars += entry.length + 1
        refs.set(ref, target)
        rendered.set(identity, ref)
      }
      if (show && !truncated) {
        const ref = target ? rendered.get(identity) ?? store.handle(tabId, target) : undefined
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
        const placed = appendNode(line + '\n')
        // The node that did not fit is the first unread one: offer it as a section.
        if (placed === 'full') {
          seenNodes.delete(node.nodeId)
          return walk(node, depth, inLandmark)
        }
        if (placed === 'shown' && ref && target) {
          refs.set(ref, target)
          rendered.set(identity, ref)
        }
      }
      if (properties.get('protected')) return
      for (const child of node.childIds ?? []) {
        const next = nodes.get(child)
        if (next) walk(next, depth + (show ? 1 : 0), inLandmark || landmark)
      }
    }
    // AX node IDs are local to a document/target, not globally unique.
    const childIds = new Set(frame.nodes.flatMap((n) => n.childIds ?? []))
    for (const node of frame.nodes) if (!childIds.has(node.nodeId)) walk(node, 0, false)
    for (const child of frames) if (child.parentId === frame.id) renderFrame(child, frameDepth + 1)
  }
  for (const frame of frames)
    if (!frames.some((f) => f.id === frame.parentId)) renderFrame(frame, 0)
  // A page that shows no node line would hand back the same cursor forever.
  if (truncated && shown === 0)
    throw new Error(
      `maxChars ${options.maxChars} cannot fit the next node line; raise maxChars or scope with refId`,
    )
  if (truncated)
    text += outline.length
      ? `\n[Truncated at ${options.maxChars} chars; continue with cursor=${lines}, or scope with refId to an unread section:]\n${outline.join('\n')}`
      : `\n[Truncated at ${options.maxChars} chars; continue with cursor=${lines} or scope with refId.]`
  store.publish(tabId, refs)
  return {
    text: text.slice(0, options.maxChars),
    truncated,
    unavailableFrames: frames.filter((f) => f.error).length,
  }
}
