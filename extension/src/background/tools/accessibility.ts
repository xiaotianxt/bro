import type { ToolResult } from '@bro/shared'
import {
  SnapshotStore,
  renderSnapshot,
  type AXNode,
  type FrameSnapshot,
  type SnapshotOptions,
} from '../accessibility.js'
import { cdpSession } from '../cdp.js'
import { getBrowserFrames, sendToFrame, type BrowserFrame } from '../frames.js'
import { prepareInput } from '../input.js'
import { scrollAndObserve } from '../scroll.js'

const snapshots = new SnapshotStore()
chrome.tabs.onRemoved.addListener((tabId) => snapshots.clear(tabId))
const textResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
interface RemoteResult<T> {
  result: { value?: T; objectId?: string }
  exceptionDetails?: { text: string; exception?: { description?: string } }
}

function unwrap<T>(response: RemoteResult<T>): T {
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
    )
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

async function callNode<T>(
  tabId: number,
  frame: BrowserFrame,
  backendNodeId: number,
  fn: (this: Element, ...args: any[]) => T,
  args: unknown[],
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
    const result = await sendToFrame<RemoteResult<T>>(tabId, frame, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(...args) { if (!this.isConnected) throw new Error('Stale ref: node is disconnected; read a fresh snapshot'); return (${fn.toString()}).apply(this, args); }`,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    })
    return unwrap(result)
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

export async function readAXPage(tabId: number, raw: unknown): Promise<ToolResult> {
  const args = argsObject(raw)
  const filter = args['filter'] ?? 'all'
  if (filter !== 'interactive' && filter !== 'all')
    throw new Error('filter must be interactive or all')
  const options: SnapshotOptions = {
    filter,
    depth: integerArg(args, 'depth', 20, 1, 100),
    maxChars: integerArg(args, 'maxChars', 16000, 1, 60000),
    compact: args['compact'] !== false,
  }
  const scope =
    args['refId'] === undefined ? undefined : snapshots.resolve(tabId, stringArg(args, 'refId'))
  if (scope)
    await withRef(tabId, stringArg(args, 'refId'), function () {
      return this.isConnected
    })
  const frames = await getBrowserFrames(tabId)
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
        { frameId: frame.id, depth: options.depth },
      )
      let nodes = result.nodes
      if (scope) {
        const root = nodes.find((n) => n.backendDOMNodeId === scope.backendNodeId)
        if (!root)
          throw new Error('Scoped ref no longer has an accessibility node; read a fresh snapshot')
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
  const result = renderSnapshot(snapshots, tabId, collected, options)
  return textResult(result.text)
}

export async function findAX(tabId: number, raw: unknown): Promise<ToolResult> {
  const args = argsObject(raw)
  const words = stringArg(args, 'description').toLowerCase().split(/\s+/)
  const snapshot = await readAXPage(tabId, {
    filter: 'all',
    maxChars: 60000,
    ...(args['refId'] === undefined ? {} : { refId: stringArg(args, 'refId') }),
  })
  const text = snapshot.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
  const matches = text
    .split('\n')
    .filter((line) => /\[ref_/.test(line) && words.every((w) => line.toLowerCase().includes(w)))
  return textResult(
    matches.length
      ? `Matching refs (new snapshot; earlier refs are stale):\n${matches.slice(0, 30).join('\n')}`
      : 'No matching accessible elements. Read the page to inspect its labels and frame availability.',
  )
}

interface Point {
  x: number
  y: number
}
// Serialized page code: exact target, no heuristic descendant selection and no
// page-global ref map. Hit testing descends through open shadow roots.
async function preparePoint(this: Element): Promise<Point> {
  if (!(this instanceof Element)) throw new Error('Ref is not an element')
  for (
    let node: Element | null = this;
    node;
    node =
      node.parentElement ??
      (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)
  ) {
    if (
      node.hasAttribute('inert') ||
      node.getAttribute('aria-disabled') === 'true' ||
      node.matches(':disabled')
    )
      throw new Error('Target is disabled or inert')
  }
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
  if (right <= left || bottom <= top || getComputedStyle(this).visibility !== 'visible')
    throw new Error('Target is not visible')
  const x = (left + right) / 2,
    y = (top + bottom) / 2
  let hit = document.elementFromPoint(x, y)
  while (hit?.shadowRoot) {
    const deeper = hit.shadowRoot.elementFromPoint(x, y)
    if (!deeper || deeper === hit) break
    hit = deeper
  }
  let node = hit
  while (node && node !== this)
    node =
      node.parentElement ??
      (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)
  if (!node)
    throw new Error(`Target is covered by ${hit?.tagName.toLowerCase() ?? 'another element'}`)
  return { x, y }
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
  snapshots.resolve(tabId, ref) // Reject guessed/stale refs before foregrounding.
  await prepareInput(tabId)
  const localPoint = await withRef(tabId, ref, preparePoint)
  let point = localPoint
  const target = snapshots.resolve(tabId, ref)
  const frames = await getBrowserFrames(tabId)
  let frame = frames.find((f) => f.id === target.frameId)
  if (!frame || frame.loaderId !== target.loaderId)
    throw new Error('Stale ref: frame changed while preparing input')
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
  await withRef(
    tabId,
    ref,
    function (p: Point) {
      if (this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true')
        throw new Error('Target became disabled before input')
      let hit = document.elementFromPoint(p.x, p.y)
      while (hit?.shadowRoot) {
        const next = hit.shadowRoot.elementFromPoint(p.x, p.y)
        if (!next || next === hit) break
        hit = next
      }
      for (
        let node: Element | null = hit;
        node;
        node =
          node.parentElement ??
          (node.getRootNode() instanceof ShadowRoot
            ? (node.getRootNode() as ShadowRoot).host
            : null)
      )
        if (node === this) return true
      throw new Error(
        'Target moved or became covered during input preparation; no click dispatched',
      )
    },
    [localPoint],
  )
  return point
}

async function clickRef(tabId: number, ref: string): Promise<ToolResult> {
  const point = await prepareRefInput(tabId, ref)
  for (const event of [
    { type: 'mouseMoved', buttons: 0 },
    { type: 'mousePressed', buttons: 1, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', buttons: 0, button: 'left', clickCount: 1 },
  ])
    await cdpSession.send(tabId, 'Input.dispatchMouseEvent', { ...event, ...point })
  return textResult(
    `Dispatched click to ${ref}. Observe the resulting page state; dispatch alone does not establish the application's postcondition.`,
  )
}

function setValue(this: Element, value: string): void {
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
  const rect = this.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(this).visibility !== 'visible')
    throw new Error('Target is not visible')
  if (this.hasAttribute('readonly') || this.getAttribute('aria-readonly') === 'true')
    throw new Error('Target is read-only')
  const win = this.ownerDocument.defaultView!
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
  if (name === 'form_input' || name === 'fill_element') {
    if (
      !['string', 'boolean', 'number'].includes(typeof args['value']) &&
      typeof args['text'] !== 'string'
    )
      throw new Error('value/text is required')
    const value = String(args['value'] ?? args['text'])
    await withRef(tabId, ref, setValue, [value])
    return textResult(
      `Set ${ref}; control accepted the value. Observe application state after input.`,
    )
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
    await prepareRefInput(tabId, ref)
    const observation = await withRef(tabId, ref, scrollAndObserve, [direction, amount])
    return textResult(JSON.stringify({ refId: ref, ...observation }))
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
