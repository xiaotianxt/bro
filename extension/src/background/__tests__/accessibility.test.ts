import { describe, expect, it } from 'vitest'
import { SnapshotStore, renderSnapshot, type FrameSnapshot } from '../accessibility.js'

const frames: FrameSnapshot[] = [
  {
    id: 'main',
    loaderId: 'doc-a',
    url: 'https://a.test',
    nodes: [
      {
        nodeId: '1',
        role: { value: 'RootWebArea' },
        name: { value: 'Parent' },
        childIds: ['2', '3'],
      },
      { nodeId: '2', role: { value: 'textbox' }, name: { value: 'Name' }, backendDOMNodeId: 11 },
      { nodeId: '3', role: { value: 'Iframe' }, name: { value: 'Editor' }, backendDOMNodeId: 12 },
    ],
  },
  {
    id: 'child',
    parentId: 'main',
    loaderId: 'doc-b',
    url: 'https://b.test',
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Editor' }, childIds: ['2'] },
      {
        nodeId: '2',
        role: { value: 'textbox' },
        name: { value: 'Name' },
        value: { value: 'Luna' },
        backendDOMNodeId: 11,
      },
    ],
  },
]

describe('document-bound accessibility snapshots', () => {
  it('renders both frame trees and issues distinct opaque refs even for identical local IDs', () => {
    const store = new SnapshotStore()
    const result = renderSnapshot(store, 42, frames, {
      filter: 'interactive',
      maxChars: 4000,
      depth: 10,
    })
    expect(result.text).toContain('Parent')
    expect(result.text).toContain('Editor')
    expect(result.text).toContain('value="Luna"')
    const names = [...result.text.matchAll(/\[([a-z]{3}\d+)\] textbox "Name"/g)]
    expect(names).toHaveLength(2)
    const first = store.resolve(42, names[0]![1]!)
    const second = store.resolve(42, names[1]![1]!)
    expect(first.frameId).toBe('main')
    expect(second.frameId).toBe('child')
    expect(first.loaderId).toBe('doc-a')
    expect(second.loaderId).toBe('doc-b')
  })

  it('rejects other tabs but preserves identical nodes across rereads', () => {
    const store = new SnapshotStore()
    const result = renderSnapshot(store, 42, frames, {
      filter: 'interactive',
      maxChars: 4000,
      depth: 10,
    })
    const ref = result.text.match(/\[([a-z]{3}\d+)\]/)![1]!
    expect(() => store.resolve(43, ref)).toThrow(/stale|unknown/i)
    renderSnapshot(store, 42, frames, { filter: 'interactive', maxChars: 4000, depth: 10 })
    expect(store.resolve(42, ref).backendNodeId).toBe(11)
  })

  it('preserves siblings across partial reads and reconciles only full frame inventories', () => {
    const store = new SnapshotStore()
    const options = { filter: 'all' as const, maxChars: 4000, depth: 10 }
    const full = renderSnapshot(store, 42, frames, options)
    const refs = [...full.text.matchAll(/\[([a-z]{3}\d+)\]/g)].map((match) => match[1]!)
    const scoped = renderSnapshot(store, 42, [{ ...frames[0]!, nodes: [frames[0]!.nodes[1]!] }], options)
    expect(scoped.text).toContain(refs[0])
    for (const ref of refs) expect(store.resolve(42, ref)).toBeDefined()
    store.reconcile(42, [{ id: 'main', loaderId: 'new-document' }])
    for (const ref of refs) expect(() => store.resolve(42, ref)).toThrow(/stale|unknown/i)
  })

  it('bounds retention and never reuses handles after eviction, clear or restart', () => {
    const store = new SnapshotStore(2, 'abc')
    const targets = [1, 2, 3].map((backendNodeId) => ({ frameId: 'main', loaderId: 'doc', backendNodeId }))
    const refs = targets.map((target) => {
      const ref = store.handle(42, target)
      store.publish(42, new Map([[ref, target]]))
      return ref
    })
    expect(() => store.resolve(42, refs[0]!)).toThrow(/stale|unknown/i)
    expect(store.handle(42, targets[0]!)).not.toBe(refs[0])
    expect(store.handle(42, targets[1]!)).toBe(refs[1])
    store.clear(42)
    expect(() => store.resolve(42, refs[1]!)).toThrow(/stale|unknown/i)
    expect(store.handle(42, targets[1]!)).not.toBe(refs[1])
    const restarted = new SnapshotStore(10000, 'xyz')
    expect(() => restarted.resolve(42, refs[2]!)).toThrow(/earlier page registry/)
    expect(restarted.handle(42, targets[2]!)).not.toBe(refs[2])
  })

  it('issues short epoch-prefixed refs and rejects refs from an earlier registry epoch', () => {
    const store = new SnapshotStore(20000, 'kqx')
    const target = (backendNodeId: number) => ({ frameId: 'main', loaderId: 'doc', backendNodeId })
    const refs = Array.from({ length: 12000 }, (_, i) => store.handle(42, target(i + 1)))
    expect(new Set(refs).size).toBe(refs.length)
    for (const ref of refs) {
      expect(ref).toMatch(/^kqx\d+$/)
      expect(ref.length).toBeLessThanOrEqual(10)
    }
    expect(refs[0]).toBe('kqx1')
    store.publish(42, new Map([[refs[0]!, target(1)]]))
    const restarted = new SnapshotStore(10000, 'mvb')
    restarted.publish(42, new Map([[restarted.handle(42, target(1)), target(1)]]))
    // Same sequence number, same node, different epoch: rejected, never re-resolved.
    expect(restarted.handle(42, target(1))).toBe('mvb1')
    expect(() => restarted.resolve(42, 'kqx1')).toThrow(/kqx1 is from an earlier page registry/)
    expect(() => store.resolve(42, 'kqx2')).toThrow(/Stale or unknown ref kqx2/)
    expect(() => store.resolve(42, 'ref_legacy_1')).toThrow(/Stale or unknown ref/)
    expect(() => new SnapshotStore(1, 'E1')).toThrow(/three lowercase letters/)
    expect(new SnapshotStore().epoch).toMatch(/^[a-z]{3}$/)
  })

  it('continues a truncated snapshot from its cursor without repeating lines', () => {
    const store = new SnapshotStore(10000, 'abc')
    const many: FrameSnapshot[] = [{
      id: 'main', loaderId: 'doc', url: 'https://a.test',
      nodes: [
        { nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: 'Root' }, childIds: Array.from({ length: 40 }, (_, i) => `b${i}`) },
        ...Array.from({ length: 40 }, (_, i) => ({ nodeId: `b${i}`, role: { value: 'button' }, name: { value: `Button ${i}` }, backendDOMNodeId: 100 + i })),
      ],
    }]
    const options = { filter: 'all' as const, depth: 10, maxChars: 600 }
    const first = renderSnapshot(store, 42, many, options)
    expect(first.truncated).toBe(true)
    expect(first.text.length).toBeLessThanOrEqual(600)
    const cursor = Number(/continue with cursor=(\d+)/.exec(first.text)![1])
    const second = renderSnapshot(store, 42, many, { ...options, cursor })
    expect(second.text).toContain(`from cursor=${cursor}`)
    const shown = (text: string) => [...text.matchAll(/"Button (\d+)"/g)].map((m) => Number(m[1]))
    const a = shown(first.text), b = shown(second.text)
    expect(b[0]).toBe(a[a.length - 1]! + 1)
    for (const ref of [...second.text.matchAll(/\[([a-z]{3}\d+)\]/g)].map((m) => m[1]!))
      expect(store.resolve(42, ref)).toBeDefined()
    expect(first.text).not.toContain('Accessibility snapshot')
  })

  it('lists unread top-level sections as scope refs when truncated', () => {
    const store = new SnapshotStore(10000, 'abc')
    const buttons = Array.from({ length: 120 }, (_, i) => ({ nodeId: `b${i}`, role: { value: 'button' }, name: { value: `Button ${i}` }, backendDOMNodeId: 100 + i }))
    const heading = (nodeId: string, name: string, level: number, backendDOMNodeId: number) =>
      ({ nodeId, role: { value: 'heading' }, name: { value: name }, properties: [{ name: 'level', value: { value: level } }], backendDOMNodeId })
    const page: FrameSnapshot[] = [{
      id: 'main', loaderId: 'doc', url: 'https://a.test',
      nodes: [
        { nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: 'Shop' }, childIds: ['top', 'main', 'foot'] },
        { nodeId: 'top', role: { value: 'banner' }, backendDOMNodeId: 1 },
        { nodeId: 'main', role: { value: 'main' }, backendDOMNodeId: 2, childIds: ['h1', ...buttons.map((b) => b.nodeId), 'h2', 'h4', 'specs'] },
        heading('h1', 'Overview', 1, 3),
        ...buttons,
        heading('h2', 'Reviews', 2, 4),
        heading('h4', 'Fine print', 4, 5),
        { nodeId: 'specs', role: { value: 'region' }, name: { value: 'Specs' }, backendDOMNodeId: 6 },
        { nodeId: 'foot', role: { value: 'contentinfo' }, backendDOMNodeId: 7 },
      ],
    }]
    const result = renderSnapshot(store, 42, page, { filter: 'all', depth: 10, maxChars: 3000 })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(3000)
    const [body, footer] = result.text.split('\n[Truncated at 3000 chars; continue with cursor=')
    expect(body).toContain('heading "Overview"')
    expect(footer).toMatch(/^\d+, or scope with refId to an unread section:\]\n/)
    const sections = footer!.split('\n').slice(1)
    // Unread level 1-3 headings and landmarks not nested in another landmark.
    expect(sections.map((line) => line.replace(/\[abc\d+\] /, ''))).toEqual(['  heading "Reviews"', '  contentinfo ""'])
    for (const line of sections) {
      const ref = /\[(abc\d+)\]/.exec(line)![1]!
      expect(body).not.toContain(`[${ref}]`)
      expect(store.resolve(42, ref)).toBeDefined()
    }
    // The cursor still continues from the first unread node line.
    const cursor = Number(/continue with cursor=(\d+)/.exec(result.text)![1])
    const next = renderSnapshot(store, 42, page, { filter: 'all', depth: 10, maxChars: 3000, cursor })
    const lastShown = Number([...body!.matchAll(/"Button (\d+)"/g)].pop()![1])
    expect(next.text).toContain(`"Button ${lastShown + 1}"`)
    expect(next.text).not.toContain(`"Button ${lastShown}"`)
  })

  it('keeps the plain footer when nothing unread is a section, and none at all for find', () => {
    const store = new SnapshotStore(10000, 'abc')
    const many: FrameSnapshot[] = [{
      id: 'main', loaderId: 'doc', url: 'https://a.test',
      nodes: [
        { nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: 'Root' }, childIds: Array.from({ length: 40 }, (_, i) => `b${i}`) },
        ...Array.from({ length: 40 }, (_, i) => ({ nodeId: `b${i}`, role: { value: 'button' }, name: { value: `Button ${i}` }, backendDOMNodeId: 100 + i })),
      ],
    }]
    const plain = renderSnapshot(store, 42, many, { filter: 'all', depth: 10, maxChars: 600 })
    expect(plain.text).toMatch(/\n\[Truncated at 600 chars; continue with cursor=\d+ or scope with refId\.\]$/)
  })

  it('cursor pages reconstruct exactly the node lines of one whole read, across frames', () => {
    const node = (nodeId: string, role: string, name: string, backendDOMNodeId: number, childIds?: string[]) =>
      ({ nodeId, role: { value: role }, name: { value: name }, backendDOMNodeId, ...(childIds ? { childIds } : {}) })
    const items = (prefix: string, count: number, base: number) =>
      Array.from({ length: count }, (_, i) => node(`${prefix}${i}`, i % 3 ? 'button' : 'link', `${prefix} item ${i} ${'x'.repeat((i * 37) % 90)}`, base + i))
    const mainItems = items('m', 90, 100), childItems = items('c', 40, 300), nestedItems = items('n', 25, 500)
    const page: FrameSnapshot[] = [
      { id: 'main', loaderId: 'doc', url: 'https://a.test', nodes: [
        { nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: 'Main' }, childIds: ['nav', 'main', 'frame'] },
        node('nav', 'navigation', 'Top', 1, ['h1']), node('h1', 'heading', 'Title', 2),
        node('main', 'main', '', 3, mainItems.map((n) => n.nodeId)), ...mainItems,
        node('frame', 'Iframe', 'Child', 4),
      ] },
      { id: 'child', parentId: 'main', loaderId: 'doc-c', url: 'https://c.test', nodes: [
        { nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: 'Child' }, childIds: [...childItems.map((n) => n.nodeId), 'frame'] },
        ...childItems, node('frame', 'Iframe', 'Nested', 5),
      ] },
      { id: 'nested', parentId: 'child', loaderId: 'doc-n', url: 'https://n.test', nodes: [
        { nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: 'Nested' }, childIds: nestedItems.map((n) => n.nodeId) },
        ...nestedItems,
      ] },
    ]
    // Node lines only: frame headers repeat on every page and the footer is not content.
    const nodeLines = (text: string) => text.split('\n[Truncated')[0]!.split('\n')
      .filter((line) => line && !line.startsWith('Frames: ') && !line.trimStart().startsWith('Frame "'))
    const store = new SnapshotStore(10000, 'abc')
    const whole = renderSnapshot(store, 42, page, { filter: 'all', depth: 20, maxChars: 60000 })
    expect(whole.truncated).toBe(false)
    const expected = nodeLines(whole.text)
    expect(expected.length).toBe((4 + 90 + 1) + (1 + 40 + 1) + (1 + 25))
    for (const maxChars of [400, 457, 600, 999, 1500, 3000, 4096, 12000]) {
      const paged: string[] = []
      let cursor = 0
      for (let page_ = 0; ; page_++) {
        expect(page_).toBeLessThan(200)
        const result = renderSnapshot(store, 42, page, { filter: 'all', depth: 20, maxChars, cursor })
        expect(result.text.length).toBeLessThanOrEqual(maxChars)
        paged.push(...nodeLines(result.text))
        const next = /continue with cursor=(\d+)/.exec(result.text)?.[1]
        if (!next) break
        expect(Number(next)).toBeGreaterThan(cursor)
        cursor = Number(next)
      }
      expect(paged).toEqual(expected)
    }
  })

  it('fails instead of returning a cursor that cannot advance', () => {
    const store = new SnapshotStore(10000, 'abc')
    expect(() => renderSnapshot(store, 42, frames, { filter: 'all', depth: 10, maxChars: 60 }))
      .toThrow('maxChars 60 cannot fit the next node line; raise maxChars or scope with refId')
  })

  it('does not evict a handle in the response currently being published', () => {
    const store = new SnapshotStore(2)
    const targets = [1, 2, 3].map((backendNodeId) => ({ frameId: 'main', loaderId: 'doc', backendNodeId }))
    const refs = targets.map((target) => store.handle(42, target))
    store.publish(42, new Map([[refs[0]!, targets[0]!], [refs[1]!, targets[1]!]]))
    store.publish(42, new Map([[refs[0]!, targets[0]!], [refs[2]!, targets[2]!]]))
    expect(store.resolve(42, refs[0]!)).toEqual(targets[0])
    expect(store.resolve(42, refs[2]!)).toEqual(targets[2])
    expect(() => store.resolve(42, refs[1]!)).toThrow(/stale|unknown/i)
  })

  it('publishes only handles visible in bounded and filtered output', () => {
    const store = new SnapshotStore()
    const published = new Map<string, unknown>()
    const publish = store.publish.bind(store)
    store.publish = (tab, refs) => {
      for (const [ref, target] of refs) published.set(ref, target)
      publish(tab, refs)
    }
    const result = renderSnapshot(store, 42, frames, { filter: 'all', depth: 10, maxChars: 200 })
    expect(result.truncated).toBe(true)
    for (const ref of published.keys()) expect(result.text).toContain(`[${ref}]`)
    published.clear()
    const found = renderSnapshot(store, 42, frames, { filter: 'all', depth: 10, maxChars: 4000, matchWords: ['name'], maxMatches: 1 })
    expect(published.size).toBe(1)
    for (const ref of published.keys()) expect(found.text).toContain(`[${ref}]`)
  })

  it('enforces a shared output budget and reports unavailable child frames', () => {
    const store = new SnapshotStore()
    const result = renderSnapshot(
      store,
      42,
      [
        ...frames,
        {
          id: 'blocked',
          parentId: 'main',
          loaderId: '',
          url: 'https://blocked.test',
          nodes: [],
          error: 'context unavailable',
        },
      ],
      { filter: 'interactive', maxChars: 500, depth: 10 },
    )
    expect(result.text.length).toBeLessThanOrEqual(500)
    expect(result.text).toContain('unavailable')
    expect(result.unavailableFrames).toBe(1)
  })

  it('does not expose a protected field value', () => {
    const store = new SnapshotStore()
    const result = renderSnapshot(
      store,
      42,
      [
        {
          ...frames[0]!,
          nodes: [
            {
              nodeId: '1',
              backendDOMNodeId: 11,
              role: { value: 'textbox' },
              name: { value: 'Password' },
              value: { value: 'private-value' },
              properties: [{ name: 'protected', value: { value: true } }],
            },
          ],
        },
      ],
      { filter: 'all', maxChars: 1000, depth: 10 },
    )
    expect(result.text).not.toContain('private-value')
  })
})
