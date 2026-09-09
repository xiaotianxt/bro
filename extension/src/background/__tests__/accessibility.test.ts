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
    const names = [...result.text.matchAll(/\[(ref_[\w]+)\] textbox "Name"/g)]
    expect(names).toHaveLength(2)
    const first = store.resolve(42, names[0]![1]!)
    const second = store.resolve(42, names[1]![1]!)
    expect(first.frameId).toBe('main')
    expect(second.frameId).toBe('child')
    expect(first.loaderId).toBe('doc-a')
    expect(second.loaderId).toBe('doc-b')
  })

  it('rejects refs from other tabs and previous snapshots rather than retargeting', () => {
    const store = new SnapshotStore()
    const result = renderSnapshot(store, 42, frames, {
      filter: 'interactive',
      maxChars: 4000,
      depth: 10,
    })
    const ref = result.text.match(/\[(ref_[\w]+)\]/)![1]!
    expect(() => store.resolve(43, ref)).toThrow(/stale|unknown/i)
    renderSnapshot(store, 42, frames, { filter: 'interactive', maxChars: 4000, depth: 10 })
    expect(() => store.resolve(42, ref)).toThrow(/stale|unknown/i)
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
