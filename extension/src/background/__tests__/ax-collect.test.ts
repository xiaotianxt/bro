import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SnapshotStore, renderSnapshot, type AXNode } from '../accessibility.js'

const mocks = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../frames.js', () => ({ sendToFrame: mocks.send }))
vi.mock('../cdp.js', () => ({ CdpSessionClosed: class extends Error {} }))

const frame = { id: 'main', loaderId: 'doc-1', url: 'https://big.test' }

beforeEach(() => {
  vi.resetModules()
  mocks.send.mockReset()
})

describe('incremental large-frame AX collector', () => {
  it('returns undefined for small frames so the caller uses getFullAXTree', async () => {
    mocks.send.mockResolvedValue({ result: { value: 200 } })
    const { collectLargeFrameAX } = await import('../ax-collect.js')
    const nodes = await collectLargeFrameAX(1, frame, undefined, undefined, {
      filter: 'all',
      depth: 20,
      maxChars: 2000,
    })
    expect(nodes).toBeUndefined()
  })

  it('slices a verified 1-to-1 large flat container in small chunks without fetching all children', async () => {
    const rowCount = 400
    const childIds = Array.from({ length: rowCount }, (_, i) => `li-${i}`)
    const root: AXNode = { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Big' }, childIds: ['ul'] }
    const ul: AXNode = { nodeId: 'ul', role: { value: 'list' }, backendDOMNodeId: 10, childIds }
    const makeLi = (i: number): AXNode => ({
      nodeId: `li-${i}`,
      role: { value: 'listitem' },
      backendDOMNodeId: 1000 + i,
      childIds: [`btn-${i}`],
    })
    const makeBtn = (i: number): AXNode => ({
      nodeId: `btn-${i}`,
      role: { value: 'button' },
      name: { value: `Row ${i}` },
      backendDOMNodeId: 2000 + i,
    })

    const slicedOffsets: number[] = []
    mocks.send.mockImplementation(async (_tab, _frame, method, params: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate' && String(params.expression).includes('getElementsByTagName')) {
        return { result: { value: 5000 } }
      }
      if (method === 'Runtime.evaluate' && params.expression === 'document.documentElement') {
        return { result: { objectId: 'doc-el' } }
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method === 'Accessibility.getRootAXNode') return { node: root }
      if (method === 'Accessibility.getChildAXNodes') {
        if (params.id === 'root') return { nodes: [ul] }
        const match = /^li-(\d+)$/.exec(String(params.id))
        if (match) return { nodes: [makeBtn(Number(match[1]))] }
        throw new Error(`unexpected getChildAXNodes for ${String(params.id)}`)
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: `obj-${String(params.backendNodeId)}` } }
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration)
        if (fn.includes('aria-owns')) return { result: { value: true } }
        if (fn.includes('Array.prototype.slice')) {
          const args = params.arguments as Array<{ value: number }>
          const start = args[0]!.value
          const count = args[1]!.value
          slicedOffsets.push(start)
          return { result: { objectId: `slice-${start}-${count}` } }
        }
        if (fn.includes('stack.pop')) return { result: { objectId: 'outline-list' } }
        if (fn.includes('this.length')) return { result: { value: 1 } }
        if (fn.includes('this.slice')) return { result: { objectId: 'outline-slice-0' } }
      }
      if (method === 'Runtime.getProperties') {
        const oid = String(params.objectId)
        const sm = /^slice-(\d+)-(\d+)$/.exec(oid)
        if (sm) {
          const start = Number(sm[1])
          const count = Number(sm[2])
          const end = Math.min(rowCount, start + count)
          return {
            result: Array.from({ length: end - start }, (_, idx) => ({
              name: String(idx),
              value: { objectId: `li-obj-${start + idx}` },
            })),
          }
        }
        if (oid === 'outline-slice-0') {
          return { result: [{ name: '0', value: { objectId: 'footer-obj' } }] }
        }
      }
      if (method === 'Accessibility.getPartialAXTree') {
        const oid = String(params.objectId)
        const lm = /^li-obj-(\d+)$/.exec(oid)
        if (lm) return { nodes: [makeLi(Number(lm[1]))] }
        if (oid === 'footer-obj') {
          return {
            nodes: params.fetchRelatives
              ? [root, { nodeId: 'foot', role: { value: 'contentinfo' }, backendDOMNodeId: 9999 }]
              : [{ nodeId: 'foot', role: { value: 'contentinfo' }, backendDOMNodeId: 9999 }],
          }
        }
      }
      if (method === 'Runtime.releaseObjectGroup') return {}
      return {}
    })

    const { collectLargeFrameAX } = await import('../ax-collect.js')
    const options = { filter: 'all' as const, depth: 20, maxChars: 1200 }
    const collected = await collectLargeFrameAX(1, frame, undefined, undefined, options)
    expect(collected).toBeDefined()
    // Stopped after only 1 chunk of 32 instead of fetching all 400 rows.
    expect(slicedOffsets).toEqual([0])

    const store = new SnapshotStore(10000, 'abc')
    const rendered = renderSnapshot(store, 1, [{ ...frame, nodes: collected! }], options)
    expect(rendered.truncated).toBe(true)
    expect(rendered.text).toContain('button "Row 0"')
    // Trailing footer after the 400 rows still appears in the unread outline.
    expect(rendered.text).toContain('contentinfo ""')
    const footerRef = /\[(abc\d+)\] contentinfo ""/.exec(rendered.text)?.[1]
    expect(footerRef).toBeDefined()
    expect(store.resolve(1, footerRef!).backendNodeId).toBe(9999)
  })

  it('falls back to getChildAXNodes when a large container is not 1-to-1 with DOM children', async () => {
    const childIds = Array.from({ length: 300 }, (_, i) => `li-${i}`)
    const root: AXNode = { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Shadow' }, childIds: ['ul'] }
    const ul: AXNode = { nodeId: 'ul', role: { value: 'list' }, backendDOMNodeId: 10, childIds }
    const children = childIds.map((id, i): AXNode => ({
      nodeId: id,
      role: { value: 'button' },
      name: { value: `Item ${i}` },
      backendDOMNodeId: 500 + i,
    }))

    let usedGetChildForUl = false
    mocks.send.mockImplementation(async (_tab, _frame, method, params: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate' && String(params.expression).includes('getElementsByTagName')) {
        return { result: { value: 5000 } }
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method === 'Accessibility.getRootAXNode') return { node: root }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'ul-obj' } }
      if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('aria-owns')) {
        return { result: { value: false } }
      }
      if (method === 'Accessibility.getChildAXNodes') {
        if (params.id === 'root') return { nodes: [ul] }
        if (params.id === 'ul') {
          usedGetChildForUl = true
          return { nodes: children }
        }
      }
      if (method === 'Runtime.releaseObjectGroup') return {}
      return {}
    })

    const { collectLargeFrameAX } = await import('../ax-collect.js')
    const options = { filter: 'all' as const, depth: 20, maxChars: 800 }
    const collected = await collectLargeFrameAX(1, frame, undefined, undefined, options)
    expect(usedGetChildForUl).toBe(true)
    expect(collected).toBeDefined()
    const store = new SnapshotStore(10000, 'abc')
    const rendered = renderSnapshot(store, 1, [{ ...frame, nodes: collected! }], options)
    expect(rendered.truncated).toBe(true)
    expect(rendered.text).toContain('button "Item 0"')
  })

  it('collects only the scoped subtree on a large frame without fetching the full tree', async () => {
    const section: AXNode = {
      nodeId: 'sec',
      role: { value: 'region' },
      name: { value: 'Trailing' },
      backendDOMNodeId: 9000,
      childIds: ['p1'],
    }
    const para: AXNode = { nodeId: 'p1', role: { value: 'StaticText' }, name: { value: 'TRAILING_OK' } }

    mocks.send.mockImplementation(async (_tab, _frame, method, params: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate' && String(params.expression).includes('getElementsByTagName')) {
        return { result: { value: 5000 } }
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method === 'Accessibility.getPartialAXTree' && params.backendNodeId === 9000) {
        return { nodes: [section] }
      }
      if (method === 'Accessibility.getChildAXNodes' && params.id === 'sec') {
        return { nodes: [para] }
      }
      if (method === 'Runtime.releaseObjectGroup') return {}
      return {}
    })

    const { collectLargeFrameAX } = await import('../ax-collect.js')
    const collected = await collectLargeFrameAX(
      1,
      frame,
      { frameId: 'main', loaderId: 'doc-1', backendNodeId: 9000 },
      'abc1',
      { filter: 'all', depth: 20, maxChars: 2000 },
    )
    expect(collected?.map((n) => n.nodeId)).toEqual(['sec', 'p1'])
    expect(mocks.send).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'Accessibility.getFullAXTree', expect.anything())
  })
})
