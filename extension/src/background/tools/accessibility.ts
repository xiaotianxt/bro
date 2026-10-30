import type { ToolResult } from '@bro/shared'
import {
  REF_PATTERN,
  SnapshotStore,
  renderSnapshot,
  type AXNode,
  type FrameSnapshot,
  type RefTarget,
  type SnapshotOptions,
} from '../accessibility.js'
import { cdpSession } from '../cdp.js'
import { getBrowserFrames, sendToFrame, type BrowserFrame } from '../frames.js'
import { withInput } from '../input.js'
import { scrollAndObserve, scrollerFor } from '../scroll.js'
import { watchChanges } from '../changes.js'

const snapshots = new SnapshotStore()
chrome.tabs.onRemoved.addListener((tabId) => snapshots.clear(tabId))
const textResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
interface RemoteResult<T> {
  result: { value?: T; objectId?: string }
  exceptionDetails?: { text: string; exception?: { description?: string } }
}

function unwrap<T>(response: RemoteResult<T>): T {
  if (response.exceptionDetails) {
    const detail =
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
    // Page stack frames point into serialized bro code; they never help the caller.
    throw new Error(detail.split('\n    at ')[0]!.replace(/^Error: /, ''))
  }
  return response.result.value as T
}

function argsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected tool arguments object')
  return value as Record<string, unknown>
}
function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} must be a nonempty string`)
  return value
}
function integerArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[name] ?? fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

async function withNodeObject<T>(
  tabId: number,
  frame: BrowserFrame,
  backendNodeId: number,
  use: (objectId: string) => Promise<T>,
): Promise<T> {
  const world = await sendToFrame<{ executionContextId: number }>(
    tabId,
    frame,
    'Page.createIsolatedWorld',
    { frameId: frame.id, worldName: 'bro-refs', grantUniveralAccess: false },
  )
  const remote = await sendToFrame<{ object: { objectId?: string } }>(
    tabId,
    frame,
    'DOM.resolveNode',
    { backendNodeId, executionContextId: world.executionContextId },
  )
  const objectId = remote.object.objectId
  if (!objectId) throw new Error('Stale ref: node no longer resolves. Read a fresh snapshot.')
  try {
    return await use(objectId)
  } finally {
    await sendToFrame(tabId, frame, 'Runtime.releaseObject', { objectId }).catch(
      (error: unknown) => {
        // A successful action may navigate and destroy its own isolated world.
        if (
          !/Cannot find context|Cannot find object|Invalid remote object|Session.*not found/.test(
            String(error),
          )
        )
          throw error
      },
    )
  }
}

function callNode<T>(
  tabId: number,
  frame: BrowserFrame,
  backendNodeId: number,
  fn: (this: Element, ...args: any[]) => T,
  args: unknown[],
): Promise<T> {
  return withNodeObject(tabId, frame, backendNodeId, async (objectId) =>
    unwrap(
      await sendToFrame<RemoteResult<T>>(tabId, frame, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(...args) { if (!this.isConnected) throw new Error('Stale ref: node is disconnected; read a fresh snapshot'); return (${fn.toString()}).apply(this, args); }`,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      }),
    ),
  )
}

export async function withRef<T>(
  tabId: number,
  ref: string,
  fn: (this: Element, ...args: any[]) => T,
  args: unknown[] = [],
): Promise<T> {
  const target = snapshots.resolve(tabId, ref)
  const frames = await getBrowserFrames(tabId)
  const frame = frames.find((f) => f.id === target.frameId)
  if (!frame || !frame.loaderId || frame.loaderId !== target.loaderId)
    throw new Error(`Stale ref ${ref}: its frame navigated or disappeared. Read a fresh snapshot.`)
  try {
    return await callNode(tabId, frame, target.backendNodeId, fn, args)
  } catch (error) {
    if (
      /No node with given id|Could not find node|Cannot find context|Could not find object/.test(
        String(error),
      )
    )
      throw new Error(`Stale ref ${ref}: its node or document disappeared. Read a fresh snapshot.`)
    throw error
  }
}

export async function readAXPage(
  tabId: number,
  raw: unknown,
  matches?: { matchWords: string[]; maxMatches: number },
): Promise<ToolResult> {
  const args = argsObject(raw)
  const filter = args['filter'] ?? 'all'
  if (filter !== 'interactive' && filter !== 'all')
    throw new Error('filter must be interactive or all')
  const options: SnapshotOptions = {
    filter,
    depth: integerArg(args, 'depth', 20, 1, 100),
    maxChars: integerArg(args, 'maxChars', 8000, 1, 60000),
    compact: args['compact'] !== false,
    cursor: integerArg(args, 'cursor', 0, 0, 1_000_000),
    ...matches,
  }
  // Every scope failure starts "Scoped ref <ref>": act falls back to a page
  // observation on exactly these, because the scope itself was replaced.
  const scopeRef = args['refId'] === undefined ? undefined : stringArg(args, 'refId')
  let scope: RefTarget | undefined
  if (scopeRef) {
    try {
      scope = snapshots.resolve(tabId, scopeRef)
      await withRef(tabId, scopeRef, function () {
        return this.isConnected
      })
    } catch (error) {
      throw new Error(`Scoped ref ${scopeRef} is gone: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let collected: FrameSnapshot[]
  let note = ''
  try {
    collected = await readFrames(tabId, scope, scopeRef, options.depth)
  } catch (error) {
    if (!(error instanceof DocumentChanged)) throw error
    // Observation is read-only and publishes no refs before this point, so one
    // reread of the new document is safe; a second change is reported.
    note = 'document changed during observe; reread\n'
    collected = await readFrames(tabId, scope, scopeRef, options.depth).catch((again: unknown) => {
      throw again instanceof DocumentChanged
        ? new Error('Document changed during observation and again during its reread; wait, then observe again.')
        : again
    })
  }
  const result = renderSnapshot(snapshots, tabId, collected, {
    ...options,
    maxChars: Math.max(1, options.maxChars - note.length),
  })
  return textResult(note + result.text)
}

class DocumentChanged extends Error {}

async function readFrames(
  tabId: number,
  scope: RefTarget | undefined,
  scopeRef: string | undefined,
  depth: number,
): Promise<FrameSnapshot[]> {
  const frames = await getBrowserFrames(tabId)
  snapshots.reconcile(tabId, frames)
  if (scope && !frames.some((frame) => frame.id === scope.frameId && frame.loaderId === scope.loaderId))
    throw new Error(`Scoped ref ${scopeRef} is gone: its frame navigated or disappeared. Read a fresh snapshot.`)
  const collected: FrameSnapshot[] = []
  for (const frame of frames) {
    if (scope && scope.frameId !== frame.id) continue
    try {
      if (!frame.loaderId || !frame.url)
        throw new Error(
          'Frame has no committed document yet; observe again after navigation completes',
        )
      await sendToFrame(tabId, frame, 'Accessibility.enable', {})
      const result = await sendToFrame<{ nodes: AXNode[] }>(
        tabId,
        frame,
        'Accessibility.getFullAXTree',
        { frameId: frame.id, ...(scope ? {} : { depth }) },
      )
      let nodes = result.nodes
      if (scope) {
        const root = nodes.find((n) => n.backendDOMNodeId === scope.backendNodeId)
        if (!root)
          throw new Error(`Scoped ref ${scopeRef} no longer has an accessibility node; read a fresh snapshot`)
        const descendants = new Set<string>()
        const byId = new Map(nodes.map((n) => [n.nodeId, n]))
        const visit = (n: AXNode): void => {
          if (descendants.has(n.nodeId)) return
          descendants.add(n.nodeId)
          for (const id of n.childIds ?? []) {
            const child = byId.get(id)
            if (child) visit(child)
          }
        }
        visit(root)
        nodes = nodes.filter((n) => descendants.has(n.nodeId))
      }
      collected.push({ ...frame, nodes })
    } catch (error) {
      if (!frame.parentId || scope) throw error
      collected.push({ ...frame, nodes: [], error: String(error).slice(0, 240) })
    }
  }
  const currentFrames = await getBrowserFrames(tabId)
  snapshots.reconcile(tabId, currentFrames)
  for (const frame of collected) {
    if (!currentFrames.some((current) => current.id === frame.id && current.loaderId === frame.loaderId))
      throw new DocumentChanged('Document navigated or frame disappeared during observation; read a fresh snapshot.')
  }
  return collected
}

export async function findAX(tabId: number, raw: unknown): Promise<ToolResult> {
  const args = argsObject(raw)
  const words = stringArg(args, 'description').toLowerCase().split(/\s+/)
  const snapshot = await readAXPage(tabId, {
    filter: 'all',
    maxChars: 60000,
    ...(args['refId'] === undefined ? {} : { refId: stringArg(args, 'refId') }),
  }, { matchWords: words, maxMatches: 30 })
  const text = snapshot.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
  const matches = text
    .split('\n')
    .filter((line) => REF_PATTERN.test(/\[([^\]]+)\]/.exec(line)?.[1] ?? ''))
  return textResult(
    matches.length
      ? `Matching refs (same-node refs survive rereads):\n${matches.join('\n')}`
      : 'No matching accessible elements. Read the page to inspect its labels and frame availability.',
  )
}

interface Point {
  x: number
  y: number
  // Set by preparePoint when another element receives the hit test.
  covered?: boolean
}
// Serialized page code: exact target, no heuristic descendant selection and no
// page-global ref map. Hit testing descends through open shadow roots. A hit
// delivers input to the target when it is the target, a flat-tree descendant
// (slotted content included), a composed ancestor, or one of its labels. A hit
// on <html>/<body> or nothing means the point shows no content (offscreen,
// clipped or zero-size), which is not occlusion. With `recheck`, only the
// prepared point is retested: no scrolling, no new point.
async function preparePoint(this: Element, recheck?: Point): Promise<Point> {
  if (!(this instanceof Element)) throw new Error('Ref is not an element')
  const doc = this.ownerDocument
  const up = (n: Element): Element | null =>
    n.assignedSlot ??
    n.parentElement ??
    (n.getRootNode() instanceof ShadowRoot ? (n.getRootNode() as ShadowRoot).host : null)
  const hitAt = (x: number, y: number): 'ok' | 'covered' | 'empty' => {
    let hit = doc.elementFromPoint(x, y)
    while (hit?.shadowRoot) {
      const deeper = hit.shadowRoot.elementFromPoint(x, y)
      if (!deeper || deeper === hit) break
      hit = deeper
    }
    if (!hit || hit === doc.documentElement || hit === doc.body) return 'empty'
    for (let n: Element | null = hit; n; n = up(n))
      if (n === this || (n.localName === 'label' && (n as HTMLLabelElement).control === this))
        return 'ok'
    for (let n: Element | null = up(this); n; n = up(n)) if (n === hit) return 'ok'
    return 'covered'
  }
  if (recheck) {
    if (this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true')
      throw new Error('Target became disabled before input')
    if (hitAt(recheck.x, recheck.y) !== 'ok')
      throw new Error(
        'Target moved or became covered during input preparation; no click dispatched',
      )
    return recheck
  }
  for (let node: Element | null = this; node; node = up(node)) {
    if (
      node.hasAttribute('inert') ||
      node.getAttribute('aria-disabled') === 'true' ||
      node.matches(':disabled')
    )
      throw new Error('Target is disabled or inert')
  }
  let point: Point = { x: 0, y: 0 }
  let verdict: 'ok' | 'covered' | 'empty' | 'hidden' = 'hidden'
  // One re-measure after rendering: the first hit test can race scrolling, lazy
  // layout or a fading control bar. Never more, and never a guessed coordinate.
  for (let attempt = 0; attempt < 2 && verdict !== 'ok'; attempt++) {
    this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    // OOPIF hit-test surfaces update asynchronously after scrolling. Synchronize
    // with rendering, not an arbitrary sleep or a replay of the user's click.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const r = this.getBoundingClientRect()
    const left = Math.max(0, r.left),
      right = Math.min(innerWidth, r.right)
    const top = Math.max(0, r.top),
      bottom = Math.min(innerHeight, r.bottom)
    if (right <= left || bottom <= top || getComputedStyle(this).visibility !== 'visible') {
      verdict = 'hidden'
      continue
    }
    point = { x: (left + right) / 2, y: (top + bottom) / 2 }
    verdict = hitAt(point.x, point.y)
  }
  if (verdict === 'hidden') throw new Error('Target is not visible')
  if (verdict === 'empty')
    throw new Error(
      'Target is not visible at its click point (offscreen or clipped); no click dispatched. Observe again',
    )
  return verdict === 'ok' ? point : { ...point, covered: true }
}

// Serialized page code: the hit element, or the outermost fixed/sticky/dialog
// ancestor of it (the overlay a caller would dismiss), at a prepared point.
function coverAt(this: Element, p: Point, which: 'hit' | 'overlay'): Element | null {
  const parent = (n: Element): Element | null =>
    n.parentElement ??
    (n.getRootNode() instanceof ShadowRoot ? (n.getRootNode() as ShadowRoot).host : null)
  let hit = this.ownerDocument.elementFromPoint(p.x, p.y)
  while (hit?.shadowRoot) {
    const deeper = hit.shadowRoot.elementFromPoint(p.x, p.y)
    if (!deeper || deeper === hit) break
    hit = deeper
  }
  if (!hit || which === 'hit') return hit
  let overlay: Element | null = null
  for (let n: Element | null = hit; n; n = parent(n)) {
    const position = getComputedStyle(n).position
    if (position === 'fixed' || position === 'sticky' || n.matches('dialog,[role=dialog],[aria-modal=true]'))
      overlay = n
  }
  return overlay === hit ? null : overlay
}

const LABEL_ATTRIBUTES = ['role', 'aria-label', 'placeholder', 'title', 'name', 'id']

// Runs serialized `pick` on the target and registers the element it returns
// as an ordinary ref, described as `<ref> <tag attrs>`.
async function elementRef(
  tabId: number,
  frame: BrowserFrame,
  target: RefTarget,
  pick: (this: Element, ...args: any[]) => Element | null,
  args: unknown[],
): Promise<{ ref: string; text: string } | undefined> {
  const described = await withNodeObject(tabId, frame, target.backendNodeId, async (objectId) => {
    const element = await sendToFrame<RemoteResult<unknown>>(
      tabId,
      frame,
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function(...args) { return (${pick.toString()}).apply(this, args); }`,
        arguments: args.map((value) => ({ value })),
        returnByValue: false,
      },
    )
    unwrap(element)
    const pickedId = element.result.objectId
    if (!pickedId) return undefined
    try {
      return await sendToFrame<{
        node: { backendNodeId: number; localName: string; attributes?: string[] }
      }>(tabId, frame, 'DOM.describeNode', { objectId: pickedId })
    } finally {
      await sendToFrame(tabId, frame, 'Runtime.releaseObject', { objectId: pickedId })
    }
  })
  if (!described) return undefined
  const { backendNodeId, localName, attributes = [] } = described.node
  const picked = { frameId: target.frameId, loaderId: target.loaderId, backendNodeId }
  const ref = snapshots.handle(tabId, picked)
  snapshots.publish(tabId, new Map([[ref, picked]]))
  const attrs = new Map<string, string>()
  for (let i = 0; i + 1 < attributes.length; i += 2) attrs.set(attributes[i]!, attributes[i + 1]!)
  const label = LABEL_ATTRIBUTES.filter((name) => attrs.get(name))
    .slice(0, 2)
    .map((name) => ` ${name}=${JSON.stringify(attrs.get(name)!.slice(0, 60))}`)
    .join('')
  return { ref, text: `${ref} <${localName}${label}>` }
}

// Explicit diagnosis only: no click is dispatched and nothing is retried.
async function coveredError(
  tabId: number,
  ref: string,
  frame: BrowserFrame,
  point: Point,
): Promise<Error> {
  const target = snapshots.resolve(tabId, ref)
  let hit: string | undefined
  let overlay: string | undefined
  try {
    hit = (await elementRef(tabId, frame, target, coverAt, [point, 'hit']))?.text
    overlay = (await elementRef(tabId, frame, target, coverAt, [point, 'overlay']))?.text
  } catch (error) {
    hit ??= `another element (not describable: ${String(error).slice(0, 120)})`
  }
  // The control re-rendered between the two hit tests; it was never occluded.
  if (hit?.startsWith(`${ref} `))
    return new Error(`Target ${ref} moved during hit testing; no click dispatched. Retry the click`)
  const dismiss = overlay ? overlay.split(' ')[0] : hit?.split(' ')[0]
  return new Error(
    `Target ${ref} is covered by ${hit ?? 'another element'}${overlay ? ` inside overlay ${overlay}` : ''}; no click dispatched. ` +
      `Dismiss the overlay${dismiss && REF_PATTERN.test(dismiss) ? ` (observe refId ${dismiss} for its close control)` : ''}, ` +
      `or set a radio/checkbox directly with a check step on ${ref}.`,
  )
}

async function parentPoint(this: Element, point: Point): Promise<Point> {
  this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  for (
    let node: Element | null = this;
    node;
    node =
      node.parentElement ??
      (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)
  ) {
    const style = getComputedStyle(node)
    if (node.hasAttribute('inert') || style.visibility !== 'visible')
      throw new Error('Iframe is hidden or inert')
    if (style.transform !== 'none') {
      const matrix = new DOMMatrix(style.transform)
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0)
        throw new Error('Rotated/perspective iframe input is unsupported; no click dispatched')
    }
  }
  const el = this as HTMLElement
  const rect = el.getBoundingClientRect()
  if (!el.offsetWidth || !el.offsetHeight) throw new Error('Iframe is not visible')
  const sx = rect.width / el.offsetWidth,
    sy = rect.height / el.offsetHeight
  const style = getComputedStyle(el)
  // Child viewport coordinates start at the iframe's content box, not its
  // padding box. Missing padding can hit a different control beside a tiny target.
  const x = rect.left + (el.clientLeft + parseFloat(style.paddingLeft) + point.x) * sx,
    y = rect.top + (el.clientTop + parseFloat(style.paddingTop) + point.y) * sy
  let hit = document.elementFromPoint(x, y)
  while (hit?.shadowRoot) {
    const next = hit.shadowRoot.elementFromPoint(x, y)
    if (!next || next === hit) break
    hit = next
  }
  if (hit !== this) throw new Error('Iframe is covered or clipped; no click dispatched')
  return { x, y }
}

async function prepareRefInput(tabId: number, ref: string): Promise<Point> {
  snapshots.resolve(tabId, ref)
  const localPoint = await withRef(tabId, ref, preparePoint)
  let point = localPoint
  const target = snapshots.resolve(tabId, ref)
  const frames = await getBrowserFrames(tabId)
  let frame = frames.find((f) => f.id === target.frameId)
  if (!frame || frame.loaderId !== target.loaderId)
    throw new Error('Stale ref: frame changed while preparing input')
  if (localPoint.covered) throw await coveredError(tabId, ref, frame, localPoint)
  const visited = new Set<string>()
  while (frame.parentId) {
    if (visited.has(frame.id)) throw new Error('Invalid cyclic frame ancestry')
    visited.add(frame.id)
    const parent = frames.find((f) => f.id === frame!.parentId)
    if (!parent) throw new Error('Iframe parent disappeared; no click dispatched')
    const owner = await sendToFrame<{ backendNodeId: number }>(tabId, parent, 'DOM.getFrameOwner', {
      frameId: frame.id,
    })
    point = await callNode(tabId, parent, owner.backendNodeId, parentPoint, [point])
    frame = parent
  }
  // Ancestor scrolling/rendering must not turn a ref into a coordinate fallback
  // on a replacement node. Recheck the original node at the prepared local point.
  await withRef(tabId, ref, preparePoint, [localPoint])
  return point
}

async function clickRef(tabId: number, ref: string): Promise<ToolResult> {
  snapshots.resolve(tabId, ref)
  return withInput(tabId, () => dispatchRefClick(tabId, ref))
}

async function dispatchRefClick(tabId: number, ref: string): Promise<ToolResult> {
  const point = await prepareRefInput(tabId, ref)
  for (const event of [
    { type: 'mouseMoved', buttons: 0 },
    { type: 'mousePressed', buttons: 1, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', buttons: 0, button: 'left', clickCount: 1 },
  ])
    await cdpSession.send(tabId, 'Input.dispatchMouseEvent', { ...event, ...point })
  return textResult(`Clicked ${ref}.`)
}

// `checkable` is the explicit check step: native checkbox/radio only, and a
// visually hidden input counts as visible when one of its labels is. It uses the
// element's activation behavior (click/input/change, as frameworks expect), not
// a pointer event, so covering overlays do not block it.
function setValue(this: Element, value: string, checkable = false): void {
  for (
    let node: Element | null = this;
    node;
    node =
      node.parentElement ??
      (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)
  ) {
    if (
      node.matches(':disabled') ||
      node.getAttribute('aria-disabled') === 'true' ||
      node.hasAttribute('inert')
    )
      throw new Error('Target is disabled or inert')
  }
  const win = this.ownerDocument.defaultView!
  const shown = (element: Element): boolean => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility === 'visible'
  }
  const native =
    this instanceof win.HTMLInputElement && (this.type === 'checkbox' || this.type === 'radio')
  if (checkable && !native)
    throw new Error('check requires a native checkbox or radio; click custom controls instead')
  if (!shown(this) && !(checkable && [...(this as HTMLInputElement).labels!].some(shown)))
    throw new Error('Target is not visible')
  if (this.hasAttribute('readonly') || this.getAttribute('aria-readonly') === 'true')
    throw new Error('Target is read-only')
  if (checkable) {
    const input = this as HTMLInputElement
    const checked = value === 'true'
    if (input.type === 'radio' && !checked && input.checked)
      throw new Error('A radio cannot be unchecked directly; check another option in its group')
    if (input.checked !== checked) input.click()
    if (input.checked !== checked)
      throw new Error('Control did not retain the requested state; observe the page')
    return
  }
  let property = 'value'
  let desired: string | boolean = value
  let prototype: object
  if (this instanceof win.HTMLInputElement) {
    if (this.type === 'file') throw new Error('Use file_upload for file inputs')
    if (this.type === 'checkbox' || this.type === 'radio') {
      if (!['true', 'false', '1', '0', 'on', 'off'].includes(value))
        throw new Error('Checkbox/radio value must be true or false')
      property = 'checked'
      desired = ['true', '1', 'on'].includes(value)
    }
    prototype = win.HTMLInputElement.prototype
  } else if (this instanceof win.HTMLTextAreaElement) prototype = win.HTMLTextAreaElement.prototype
  else if (this instanceof win.HTMLSelectElement) {
    const enabled = [...this.options].filter(
      (o) =>
        !o.disabled &&
        !(o.parentElement instanceof win.HTMLOptGroupElement && o.parentElement.disabled),
    )
    const exact = enabled.find((o) => o.value === value)
    const labels = enabled.filter((o) => o.label.trim() === value)
    if (!exact && labels.length !== 1)
      throw new Error(
        'No unique enabled option matches the requested value or label; inspect the options',
      )
    desired = (exact ?? labels[0]!).value
    prototype = win.HTMLSelectElement.prototype
  } else if ((this as HTMLElement).isContentEditable) {
    this.textContent = value
    this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    return
  } else throw new Error('Ref is not an editable form control')
  const setter = Object.getOwnPropertyDescriptor(prototype, property)?.set
  if (!setter) throw new Error('Native form setter unavailable')
  setter.call(this, desired)
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  this.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  const actual = (this as unknown as Record<string, unknown>)[property]
  if (actual !== desired)
    throw new Error(
      'Control did not retain the requested value; observe and retry with a fresh ref',
    )
}

export async function refTool(name: string, tabId: number, raw: unknown): Promise<ToolResult> {
  const args = argsObject(raw)
  const ref = stringArg(args, 'refId')
  if (name === 'click_element') return clickRef(tabId, ref)
  if (name === 'form_input' && typeof args['checked'] === 'boolean') {
    await withRef(tabId, ref, setValue, [String(args['checked']), true])
    return textResult(`${args['checked'] ? 'Checked' : 'Unchecked'} ${ref}.`)
  }
  if (name === 'form_input' || name === 'fill_element') {
    if (
      !['string', 'boolean', 'number'].includes(typeof args['value']) &&
      typeof args['text'] !== 'string'
    )
      throw new Error('value/text is required')
    const value = String(args['value'] ?? args['text'])
    await withRef(tabId, ref, setValue, [value])
    return textResult(`Set ${ref}.`)
  }
  if (name === 'get_element_info') {
    const result = await withRef(tabId, ref, function () {
      const r = this.getBoundingClientRect()
      const value =
        this instanceof HTMLInputElement && this.type === 'password'
          ? '[redacted]'
          : 'value' in this
            ? String((this as HTMLInputElement).value)
            : null
      return {
        tag: this.tagName.toLowerCase(),
        text: this.textContent?.slice(0, 1000),
        value: value?.slice(0, 2000) ?? null,
        valueTruncated: (value?.length ?? 0) > 2000,
        checked:
          this instanceof HTMLInputElement && ['checkbox', 'radio'].includes(this.type)
            ? this.checked
            : null,
        options:
          this instanceof HTMLSelectElement
            ? [...this.options].slice(0, 100).map((o) => ({
                value: o.value.slice(0, 200),
                label: o.label.slice(0, 200),
                disabled: o.disabled,
              }))
            : undefined,
        optionsTruncated: this instanceof HTMLSelectElement && this.options.length > 100,
        connected: this.isConnected,
        // Rendered with a box; checkVisibility also covers hidden ancestors.
        visible:
          r.width > 0 &&
          r.height > 0 &&
          getComputedStyle(this).visibility === 'visible' &&
          (typeof this.checkVisibility !== 'function' || this.checkVisibility()),
        disabled: this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true',
        scroll: {
          top: this.scrollTop,
          left: this.scrollLeft,
          height: this.scrollHeight,
          width: this.scrollWidth,
          clientHeight: this.clientHeight,
          clientWidth: this.clientWidth,
        },
        coordinateSpace: 'owning frame CSS pixels, not top-level input coordinates',
        boundingBox: { x: r.x, y: r.y, width: r.width, height: r.height },
      }
    })
    return textResult(JSON.stringify(result))
  }
  if (name === 'scroll_element') {
    const direction = String(args['direction'] ?? 'down')
    if (!['up', 'down', 'left', 'right'].includes(direction))
      throw new Error('Unknown scroll direction')
    const amount = integerArg(args, 'amount', 400, 1, 10000)
    const target = snapshots.resolve(tabId, ref)
    return withInput(tabId, async () => {
      await prepareRefInput(tabId, ref)
      const frame = (await getBrowserFrames(tabId)).find((f) => f.id === target.frameId)
      if (!frame || frame.loaderId !== target.loaderId)
        throw new Error(`Stale ref ${ref}: its frame navigated or disappeared. Read a fresh snapshot.`)
      const scroller = await elementRef(tabId, frame, target, scrollerFor, [direction])
      if (!scroller)
        throw new Error(
          `Nothing scrolls ${direction} from ${ref}: neither it, its ancestors nor the document overflow on that axis`,
        )
      const observation = await withRef(tabId, scroller.ref, scrollAndObserve, [direction, amount])
      const scrolled = observation.document ? 'document' : scroller.ref === ref ? ref : scroller.text
      return textResult(JSON.stringify({ refId: ref, scrolled, ...observation }))
    })
  }
  throw new Error(`Unsupported ref operation ${name}`)
}

export async function waitAX(tabId: number, raw: unknown): Promise<ToolResult> {
  const args = argsObject(raw)
  const timeout = integerArg(args, 'timeout', 10000, 1, 20000)
  const deadline = Date.now() + timeout
  do {
    if (args['refId'] !== undefined) {
      const visible = await withRef(tabId, stringArg(args, 'refId'), function () {
        const r = this.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(this).visibility === 'visible'
      })
      if (visible) return textResult(`Element ${args['refId']} is visible.`)
    } else {
      const result = await findAX(tabId, args)
      if (result.content.some((c) => c.type === 'text' && c.text.startsWith('Matching refs')))
        return result
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)))
  } while (Date.now() < deadline)
  return { ...textResult('Element did not become visible before the deadline.'), isError: true }
}

// Resolved at execution, not from an earlier observation, so a target that
// re-rendered between observe and act still resolves. Main frame only. Roles
// and names come from the same AX tree observe prints. An exact accessible
// name wins; otherwise a unique substring match. Ambiguity fails instead of
// guessing.
async function resolveNamed(tabId: number, role: string, name: string): Promise<string> {
  const main = (await getBrowserFrames(tabId)).find((frame) => !frame.parentId)
  if (!main) throw new Error('Main frame unavailable')
  await sendToFrame(tabId, main, 'Accessibility.enable', {})
  const { nodes } = await sendToFrame<{ nodes: AXNode[] }>(
    tabId,
    main,
    'Accessibility.getFullAXTree',
    { frameId: main.id },
  )
  const normalize = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  const wanted = normalize(name)
  const named = nodes.filter(
    (node) =>
      !node.ignored && node.backendDOMNodeId !== undefined && normalize(node.role?.value) === normalize(role),
  )
  const exact = named.filter((node) => normalize(node.name?.value) === wanted)
  const candidates = exact.length ? exact : named.filter((node) => normalize(node.name?.value).includes(wanted))
  const visible: AXNode[] = []
  for (const node of candidates) {
    const shown = await callNode(tabId, main, node.backendDOMNodeId!, function (this: Element) {
      const r = this.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(this).visibility === 'visible'
    }, [])
    if (shown) visible.push(node)
  }
  if (!visible.length)
    throw new Error(`No visible ${role} named "${name}"; observe to read current names`)
  if (visible.length > 1)
    throw new Error(
      `${visible.length} visible ${role} elements match "${name}" (${visible
        .slice(0, 5)
        .map((node) => JSON.stringify(String(node.name?.value ?? '')))
        .join(', ')}); use the exact name or a ref`,
    )
  const target = { frameId: main.id, loaderId: main.loaderId, backendNodeId: visible[0]!.backendDOMNodeId! }
  const ref = snapshots.handle(tabId, target)
  snapshots.publish(tabId, new Map([[ref, target]]))
  return ref
}

// One act step: resolve the target, act with the same ref tools, and report
// what visibly changed once the page settles.
export async function actElement(tabId: number, raw: unknown): Promise<ToolResult> {
  const args = argsObject(raw)
  const action = stringArg(args, 'action')
  const ref =
    args['refId'] !== undefined
      ? stringArg(args, 'refId')
      : await resolveNamed(tabId, stringArg(args, 'role'), stringArg(args, 'name'))
  const [tool, toolArgs] =
    action === 'click'
      ? ['click_element', { refId: ref }]
      : action === 'check'
        ? ['form_input', { refId: ref, checked: args['checked'] }]
        : action === 'fill' || action === 'select'
          ? ['form_input', { refId: ref, value: args['value'] }]
          : [undefined, undefined]
  if (!tool) throw new Error(`Unsupported act_element action ${action}`)
  const { changes } = await watchChanges(tabId, () => refTool(tool, tabId, toolArgs))
  return textResult(JSON.stringify({ refId: ref, changes }))
}
