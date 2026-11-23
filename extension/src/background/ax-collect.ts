// Incremental AX tree collector for large frames.
//
// Chrome's Accessibility.getFullAXTree serializes the entire frame's AX tree
// (120k+ nodes on a 20k-row page) into one chrome.debugger IPC reply. Decoding
// that single payload into V8 objects freezes the MV3 service worker for 3-4 s,
// stalling every other tab's tool calls.
//
// For frames above LARGE_DOM_THRESHOLD elements, this collector walks the real
// Chrome AX tree top-down in small chunks until the snapshot's maxChars budget
// is met, then scans unread landmarks and h1-h3 headings across the whole frame
// so the truncation outline never omits trailing sections, forms, or dialogs.
import {
  LANDMARKS,
  NATIVE_COMPOSITES,
  axProp,
  formatAXLine,
  isLandmarkNode,
  isOutlineHeading,
  outlineBudgetFor,
  shouldShowNode,
  type AXNode,
  type RefTarget,
  type SnapshotOptions,
} from './accessibility.js'
import { CdpSessionClosed } from './cdp.js'
import { sendToFrame, type BrowserFrame } from './frames.js'

export const LARGE_DOM_THRESHOLD = 3_000
const FLAT_CHILD_THRESHOLD = 256
const SLICE_CHUNK = 32
const SLICE_CHUNK_SKIP = 64
const OUTLINE_CHUNK = 16

const OUTLINE_SELECTOR = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'main', 'nav', 'header', 'footer', 'aside', 'search', 'article', 'section', 'form',
  '[role="heading"]', '[role="main"]', '[role="navigation"]', '[role="banner"]',
  '[role="contentinfo"]', '[role="complementary"]', '[role="search"]',
  '[role="article"]', '[role="region"]', '[role="form"]',
].join(',')

let groupSeq = 0

interface RemoteObject {
  objectId?: string
  value?: unknown
}

interface PropertyDescriptor {
  name: string
  value?: RemoteObject
}

async function releaseGroup(tabId: number, frame: BrowserFrame, objectGroup: string): Promise<void> {
  await sendToFrame(tabId, frame, 'Runtime.releaseObjectGroup', { objectGroup }).catch((error: unknown) => {
    if (error instanceof CdpSessionClosed) return
    if (/Cannot find context|Session.*not found/.test(String(error))) return
  })
}

async function createIsolatedContext(tabId: number, frame: BrowserFrame): Promise<number> {
  const world = await sendToFrame<{ executionContextId: number }>(
    tabId,
    frame,
    'Page.createIsolatedWorld',
    { frameId: frame.id, worldName: 'bro-ax', grantUniveralAccess: false },
  )
  return world.executionContextId
}

/**
 * Returns the frame's DOM element count, or undefined if unavailable (e.g.
 * sandboxed/uninitialized frame or unit-test mocks).
 */
async function probeDomCount(tabId: number, frame: BrowserFrame): Promise<number | undefined> {
  try {
    const contextId = frame.parentId ? await createIsolatedContext(tabId, frame) : undefined
    const res = await sendToFrame<{ result?: { value?: unknown } }>(
      tabId,
      frame,
      'Runtime.evaluate',
      {
        expression: "document.getElementsByTagName('*').length",
        returnByValue: true,
        ...(contextId === undefined ? {} : { contextId }),
      },
    )
    const count = res?.result?.value
    return typeof count === 'number' ? count : undefined
  } catch {
    return undefined
  }
}

/**
 * Verifies a 1-to-1 correspondence between a container's DOM `.children` and
 * its AX `childIds`: no shadow root, no aria-owns, no ::before/::after content,
 * no non-whitespace direct text nodes, and identical length. Only when this
 * holds do we slice `.children` in small chunks instead of fetching all child
 * AX nodes in one large IPC.
 */
async function resolveSliceableContainer(
  tabId: number,
  frame: BrowserFrame,
  contextId: number,
  objectGroup: string,
  backendNodeId: number,
  expectedChildCount: number,
): Promise<string | undefined> {
  const resolved = await sendToFrame<{ object?: { objectId?: string } }>(
    tabId,
    frame,
    'DOM.resolveNode',
    { backendNodeId, executionContextId: contextId, objectGroup },
  )
  const objectId = resolved.object?.objectId
  if (!objectId) return undefined
  const check = await sendToFrame<{ result?: { value?: unknown } }>(
    tabId,
    frame,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: `function(expected) {
        if (!(this instanceof Element)) return false;
        if (this.shadowRoot || this.hasAttribute('aria-owns')) return false;
        var b = getComputedStyle(this, '::before').content;
        var a = getComputedStyle(this, '::after').content;
        if ((b && b !== 'none' && b !== 'normal') || (a && a !== 'none' && a !== 'normal')) return false;
        if (this.children.length !== expected) return false;
        for (var n = this.firstChild; n; n = n.nextSibling) {
          if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim() !== '') return false;
        }
        return true;
      }`,
      arguments: [{ value: expectedChildCount }],
      returnByValue: true,
    },
  )
  return check.result?.value === true ? objectId : undefined
}

async function fetchElementSliceAX(
  tabId: number,
  frame: BrowserFrame,
  arrayOrContainerId: string,
  fnDeclaration: string,
  args: Array<{ value: unknown }>,
  chunkGroup: string,
): Promise<AXNode[]> {
  try {
    const arr = await sendToFrame<{ result?: { objectId?: string } }>(
      tabId,
      frame,
      'Runtime.callFunctionOn',
      {
        objectId: arrayOrContainerId,
        functionDeclaration: fnDeclaration,
        arguments: args,
        returnByValue: false,
        objectGroup: chunkGroup,
      },
    )
    const arrId = arr.result?.objectId
    if (!arrId) return []
    const props = await sendToFrame<{ result?: PropertyDescriptor[] }>(
      tabId,
      frame,
      'Runtime.getProperties',
      { objectId: arrId, ownProperties: true },
    )
    const indexed = (props.result ?? [])
      .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
      .sort((a, b) => Number(a.name) - Number(b.name))
    const partials = await Promise.all(
      indexed.map((entry) =>
        sendToFrame<{ nodes?: AXNode[] }>(tabId, frame, 'Accessibility.getPartialAXTree', {
          objectId: entry.value!.objectId,
          fetchRelatives: false,
        }).catch(() => ({ nodes: [] as AXNode[] })),
      ),
    )
    const nodes: AXNode[] = []
    for (const partial of partials) {
      const node = partial.nodes?.[0]
      if (node) nodes.push(node)
    }
    return nodes
  } finally {
    await releaseGroup(tabId, frame, chunkGroup)
  }
}

/**
 * Collects AX nodes incrementally for a large frame. Returns `undefined` when
 * the frame is small (or uses `match` filtering) so the caller uses
 * `Accessibility.getFullAXTree` directly.
 */
export async function collectLargeFrameAX(
  tabId: number,
  frame: BrowserFrame,
  scope: RefTarget | undefined,
  scopeRef: string | undefined,
  options: SnapshotOptions,
  frameDepth = 0,
): Promise<AXNode[] | undefined> {
  if (options.match) return undefined
  const domCount = await probeDomCount(tabId, frame)
  if (domCount === undefined || domCount <= LARGE_DOM_THRESHOLD) return undefined

  let root: AXNode | undefined
  if (scope) {
    const partial = await sendToFrame<{ nodes?: AXNode[] }>(
      tabId,
      frame,
      'Accessibility.getPartialAXTree',
      { backendNodeId: scope.backendNodeId, fetchRelatives: false },
    )
    root = partial.nodes?.find((n) => n.backendDOMNodeId === scope.backendNodeId) ?? partial.nodes?.[0]
    if (!root)
      throw new Error(`Scoped ref ${scopeRef} no longer has an accessibility node; read a fresh snapshot`)
  } else {
    const res = await sendToFrame<{ node?: AXNode }>(
      tabId,
      frame,
      'Accessibility.getRootAXNode',
      { frameId: frame.id },
    )
    root = res?.node
    if (!root) return undefined
  }

  const contextId = await createIsolatedContext(tabId, frame)
  const objectGroup = `bro-ax-${++groupSeq}`
  const { outlineBudget, reserve } = outlineBudgetFor(options)
  // Small safety margin above renderSnapshot's body budget so renderSnapshot
  // always fills maxChars completely and hits truncation on a real node.
  const bodyBudget = Math.max(0, options.maxChars - reserve) + 200
  const prefix = '  '.repeat(frameDepth)
  const cursor = options.cursor ?? 0

  const collected: AXNode[] = []
  const seenNodeIds = new Set<string>()
  const seenBackendIds = new Set<number>()
  let lines = 0
  let chars = 0
  let truncated = false
  let lastBackendNodeId: number | undefined
  let truncationBackendNodeId: number | undefined
  let rootCopy: AXNode | undefined

  const walk = async (node: AXNode, depth: number, echo: string): Promise<void> => {
    if (seenNodeIds.has(node.nodeId) || truncated || depth > options.depth) return
    seenNodeIds.add(node.nodeId)
    const role = String(node.role?.value ?? '')
    const isElementNode =
      node.backendDOMNodeId !== undefined &&
      role !== 'ListMarker' &&
      role !== 'StaticText' &&
      role !== 'InlineTextBox' &&
      role !== 'LineBreak'
    if (node.backendDOMNodeId !== undefined) {
      seenBackendIds.add(node.backendDOMNodeId)
      if (isElementNode) lastBackendNodeId = node.backendDOMNodeId
    }

    const copy: AXNode = { ...node, childIds: [] }
    if (!rootCopy) rootCopy = copy
    collected.push(copy)

    let show = false
    let name = ''
    if (!node.ignored) {
      const rawName = String(node.name?.value ?? '').trim()
      name = rawName.length > 300 ? rawName.slice(0, 300) + '…' : rawName
      show = shouldShowNode(node, role, rawName, name, echo, options, 0)
      if (show) {
        if (lines < cursor) {
          lines++
        } else {
          // Minimum possible ref width (`[aaa1] `) ensures we never stop short.
          const hasRef = Boolean(node.backendDOMNodeId && role !== 'RootWebArea' && role !== 'StaticText' && role !== 'LineBreak')
          const lineLen = formatAXLine(node, prefix, depth, hasRef ? 'aaa1' : undefined, role, name).length + 1
          chars += lineLen
          lines++
          if (chars > bodyBudget) {
            truncated = true
            truncationBackendNodeId = isElementNode ? node.backendDOMNodeId : lastBackendNodeId
            return
          }
        }
      }
    }

    if (!node.childIds?.length) return
    if (axProp(node, 'protected') || NATIVE_COMPOSITES.has(role) || role === 'StaticText') return
    const nextDepth = depth + (show ? 1 : 0)
    if (nextDepth > options.depth) return
    const nextEcho = show ? name : echo

    if (node.childIds.length > FLAT_CHILD_THRESHOLD && node.backendDOMNodeId !== undefined) {
      const containerId = await resolveSliceableContainer(
        tabId,
        frame,
        contextId,
        objectGroup,
        node.backendDOMNodeId,
        node.childIds.length,
      ).catch(() => undefined)
      if (containerId) {
        for (let offset = 0; offset < node.childIds.length && !truncated; ) {
          const count = lines < cursor ? SLICE_CHUNK_SKIP : SLICE_CHUNK
          const chunkNodes = await fetchElementSliceAX(
            tabId,
            frame,
            containerId,
            'function(start, count) { return Array.prototype.slice.call(this.children, start, start + count); }',
            [{ value: offset }, { value: count }],
            `${objectGroup}-s${offset}`,
          )
          offset += count
          for (const child of chunkNodes) {
            copy.childIds!.push(child.nodeId)
            await walk(child, nextDepth, nextEcho)
            if (truncated) break
          }
        }
        return
      }
    }

    const res = await sendToFrame<{ nodes?: AXNode[] }>(
      tabId,
      frame,
      'Accessibility.getChildAXNodes',
      { id: node.nodeId, frameId: frame.id },
    )
    const byId = new Map<string, AXNode>()
    for (const child of res.nodes ?? []) byId.set(child.nodeId, child)
    for (const childId of node.childIds) {
      const child = byId.get(childId)
      if (!child) continue
      copy.childIds!.push(child.nodeId)
      await walk(child, nextDepth, nextEcho)
      if (truncated) break
    }
  }

  try {
    await walk(root, 0, '')

    // When truncated, collect unread top-level landmarks and h1-h3 headings
    // across the rest of the frame (or scope) so trailing sections, forms, and
    // dialogs always appear in the truncation footer.
    if (truncated && outlineBudget > 0 && rootCopy) {
      await appendUnreadOutline(
        tabId,
        frame,
        contextId,
        objectGroup,
        scope?.backendNodeId,
        truncationBackendNodeId,
        outlineBudget,
        seenNodeIds,
        seenBackendIds,
        collected,
        rootCopy,
      )
    }

    return collected
  } finally {
    await releaseGroup(tabId, frame, objectGroup)
  }
}

async function appendUnreadOutline(
  tabId: number,
  frame: BrowserFrame,
  contextId: number,
  objectGroup: string,
  scopeBackendNodeId: number | undefined,
  truncationBackendNodeId: number | undefined,
  outlineBudget: number,
  seenNodeIds: Set<string>,
  seenBackendIds: Set<number>,
  collected: AXNode[],
  rootCopy: AXNode,
): Promise<void> {
  const resolveEl = async (backendNodeId: number | undefined): Promise<string | undefined> => {
    if (backendNodeId === undefined) return undefined
    const res = await sendToFrame<{ object?: { objectId?: string } }>(
      tabId,
      frame,
      'DOM.resolveNode',
      { backendNodeId, executionContextId: contextId, objectGroup },
    ).catch(() => undefined)
    return res?.object?.objectId
  }

  const scopeElId = await resolveEl(scopeBackendNodeId)
  const truncElId = await resolveEl(truncationBackendNodeId)

  // Collect candidate landmark/heading elements in exact pre-order (descending
  // into open shadow roots) at or after the truncation element. Pre-order
  // `passed` tracking stays accurate even across shadow root boundaries where
  // compareDocumentPosition reports disconnected.
  const collectFn = `function(truncEl, selector) {
    var root = this instanceof Element ? this : document.documentElement;
    if (!root) return [];
    if (truncEl && !(truncEl instanceof Element)) truncEl = truncEl.parentElement;
    var scan = function(startPassed) {
      var out = [];
      var passed = startPassed;
      var stack = [root];
      while (stack.length) {
        var el = stack.pop();
        if (el === truncEl) passed = true;
        if (passed && (el !== root || this instanceof Element)) {
          if (el.matches && el.matches(selector)) out.push(el);
        }
        if (el.shadowRoot) {
          var srKids = el.shadowRoot.children;
          for (var s = srKids.length - 1; s >= 0; s--) stack.push(srKids[s]);
        }
        var kids = el.children;
        for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
      return { out: out, passed: passed };
    }.bind(this);
    var first = scan(!truncEl);
    return first.passed ? first.out : scan(true).out;
  }`

  let listId: string | undefined
  if (scopeElId) {
    const res = await sendToFrame<{ result?: { objectId?: string } }>(
      tabId,
      frame,
      'Runtime.callFunctionOn',
      {
        objectId: scopeElId,
        functionDeclaration: collectFn,
        arguments: [truncElId ? { objectId: truncElId } : { value: null }, { value: OUTLINE_SELECTOR }],
        returnByValue: false,
        objectGroup,
      },
    ).catch(() => undefined)
    listId = res?.result?.objectId
  } else {
    const docEl = await sendToFrame<{ result?: { objectId?: string } }>(
      tabId,
      frame,
      'Runtime.evaluate',
      { expression: 'document.documentElement', contextId, returnByValue: false, objectGroup },
    ).catch(() => undefined)
    if (docEl?.result?.objectId) {
      const res = await sendToFrame<{ result?: { objectId?: string } }>(
        tabId,
        frame,
        'Runtime.callFunctionOn',
        {
          objectId: docEl.result.objectId,
          functionDeclaration: collectFn,
          arguments: [truncElId ? { objectId: truncElId } : { value: null }, { value: OUTLINE_SELECTOR }],
          returnByValue: false,
          objectGroup,
        },
      ).catch(() => undefined)
      listId = res?.result?.objectId
    }
  }
  if (!listId) return

  const lenRes = await sendToFrame<{ result?: { value?: unknown } }>(
    tabId,
    frame,
    'Runtime.callFunctionOn',
    { objectId: listId, functionDeclaration: 'function() { return this.length; }', returnByValue: true },
  ).catch(() => undefined)
  const total = typeof lenRes?.result?.value === 'number' ? lenRes.result.value : 0
  if (total === 0) return

  let approxOutlineChars = 0
  for (let offset = 0; offset < total && approxOutlineChars < outlineBudget; offset += OUTLINE_CHUNK) {
    const chunkGroup = `${objectGroup}-o${offset}`
    try {
      const slice = await sendToFrame<{ result?: { objectId?: string } }>(
        tabId,
        frame,
        'Runtime.callFunctionOn',
        {
          objectId: listId,
          functionDeclaration: 'function(s, n) { return this.slice(s, s + n); }',
          arguments: [{ value: offset }, { value: OUTLINE_CHUNK }],
          returnByValue: false,
          objectGroup: chunkGroup,
        },
      )
      const sliceId = slice.result?.objectId
      if (!sliceId) break
      const props = await sendToFrame<{ result?: PropertyDescriptor[] }>(
        tabId,
        frame,
        'Runtime.getProperties',
        { objectId: sliceId, ownProperties: true },
      )
      const indexed = (props.result ?? [])
        .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
        .sort((a, b) => Number(a.name) - Number(b.name))
      const partials = await Promise.all(
        indexed.map((entry) =>
          sendToFrame<{ nodes?: AXNode[] }>(tabId, frame, 'Accessibility.getPartialAXTree', {
            objectId: entry.value!.objectId,
            fetchRelatives: false,
          })
            .then((res) => ({ objectId: entry.value!.objectId!, node: res.nodes?.[0] }))
            .catch(() => ({ objectId: entry.value!.objectId!, node: undefined })),
        ),
      )
      for (const { objectId, node: targetNode } of partials) {
        if (!targetNode || targetNode.ignored || !targetNode.backendDOMNodeId) continue
        if (seenNodeIds.has(targetNode.nodeId) || seenBackendIds.has(targetNode.backendDOMNodeId)) continue
        const role = String(targetNode.role?.value ?? '')
        const rawName = String(targetNode.name?.value ?? '').trim()
        const name = rawName.length > 300 ? rawName.slice(0, 300) + '…' : rawName
        const heading = isOutlineHeading(targetNode, role)
        const landmark = isLandmarkNode(role, name)
        if (!heading && !landmark) continue
        if (landmark && !heading) {
          // Exclude landmarks nested inside another landmark, matching renderSnapshot.
          const rel = await sendToFrame<{ nodes?: AXNode[] }>(tabId, frame, 'Accessibility.getPartialAXTree', {
            objectId,
            fetchRelatives: true,
          }).catch(() => ({ nodes: [] as AXNode[] }))
          const relNodes = rel.nodes ?? []
          const byId = new Map<string, AXNode>()
          for (const n of relNodes) byId.set(n.nodeId, n)
          const hasLandmarkAncestor = relNodes.some((n) => {
            if (n.nodeId === targetNode.nodeId || n.ignored) return false
            const visited = new Set<string>()
            const q = [...(n.childIds ?? [])]
            let isAnc = false
            while (q.length) {
              const cur = q.pop()!
              if (cur === targetNode.nodeId) { isAnc = true; break }
              if (visited.has(cur)) continue
              visited.add(cur)
              const next = byId.get(cur)
              if (next?.childIds) q.push(...next.childIds)
            }
            if (!isAnc) return false
            const r = String(n.role?.value ?? '')
            const nm = String(n.name?.value ?? '').trim()
            return isLandmarkNode(r, nm)
          })
          if (hasLandmarkAncestor) continue
        }
        seenNodeIds.add(targetNode.nodeId)
        seenBackendIds.add(targetNode.backendDOMNodeId)
        collected.push({ ...targetNode, childIds: [] })
        rootCopy.childIds!.push(targetNode.nodeId)
        approxOutlineChars += role.length + Math.min(name.length, 60) + 16
        if (approxOutlineChars >= outlineBudget) break
      }
    } finally {
      await releaseGroup(tabId, frame, chunkGroup)
    }
  }
}
