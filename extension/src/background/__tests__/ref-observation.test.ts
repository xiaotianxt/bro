import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ frames: vi.fn(), send: vi.fn() }))
vi.mock('../frames.js', () => ({ getBrowserFrames: mocks.frames, sendToFrame: mocks.send }))
vi.mock('../cdp.js', () => ({ cdpSession: {} }))
vi.mock('../input.js', () => ({ withInput: vi.fn() }))
vi.mock('../scroll.js', () => ({ scrollAndObserve: vi.fn() }))
const main = { id: 'main', loaderId: 'doc', url: 'https://example.test' }
const child = { id: 'child', parentId: 'main', loaderId: 'child-doc', url: 'https://frame.test' }
const nodes = [1, 2].map((id) => ({ nodeId: String(id), backendDOMNodeId: id, role: { value: 'button' }, name: { value: `Button ${id}` } }))
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((c) => c.text ?? '').join('\n')
const refs = (value: string) => [...value.matchAll(/\[([a-z]{3}\d+)\]/g)].map((m) => m[1]!)

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('chrome', { tabs: { onRemoved: { addListener: vi.fn() } } })
  mocks.frames.mockReset().mockResolvedValue([main, child])
  mocks.send.mockReset().mockImplementation(async (_tab, _frame, method) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
    return {}
  })
})

describe('observation identity at the browser boundary', () => {
  it('allows same-node actions after scope/find without invalidating siblings or frames', async () => {
    const { readAXPage, findAX, withRef } = await import('../tools/accessibility.js')
    const initial = refs(text(await readAXPage(42, {})))
    expect(initial).toHaveLength(4)
    expect(refs(text(await readAXPage(42, { refId: initial[0] })))).toEqual([initial[0]])
    await findAX(42, { description: 'Button 1' })
    for (const ref of initial) await expect(withRef(42, ref, function () { return true })).resolves.toBe(true)
    await expect(withRef(43, initial[0]!, function () { return true })).rejects.toThrow(/Stale/)
  })

  it('find returns matching handles even when accessible names need JSON escaping', async () => {
    mocks.frames.mockResolvedValue([main])
    mocks.send.mockImplementation(async (_tab, _frame, method) => method === 'Accessibility.getFullAXTree'
      ? { nodes: [{ ...nodes[0], name: { value: 'Say "hello"' } }] } : {})
    const { findAX } = await import('../tools/accessibility.js')
    expect(refs(text(await findAX(42, { description: '"hello"' })))).toHaveLength(1)
  })

  it('applies scoped depth relative to the ref, not the document root', async () => {
    const original = mocks.send.getMockImplementation()!
    mocks.frames.mockResolvedValue([main])
    mocks.send.mockImplementation(async (tab, frame, method, params) => {
      if (method === 'Accessibility.getFullAXTree') {
        const root = { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['1'] }
        return { nodes: params.depth === 1 ? [root] : [root, ...nodes] }
      }
      return original(tab, frame, method, params)
    })
    const { readAXPage } = await import('../tools/accessibility.js')
    const [ref] = refs(text(await readAXPage(42, {})))
    expect(text(await readAXPage(42, { refId: ref, depth: 1 }))).toContain(ref)
  })

  it('rereads once when the document changes during collection, publishing only the new document', async () => {
    const { readAXPage, withRef } = await import('../tools/accessibility.js')
    const next = { ...main, loaderId: 'new' }
    mocks.frames.mockResolvedValueOnce([main]).mockResolvedValueOnce([next]).mockResolvedValue([next])
    const value = text(await readAXPage(42, { maxChars: 4000 }))
    expect(value.split('\n')[0]).toBe('document changed during observe; reread')
    expect(value.split('\n')[1]).toBe('Frames: 1')
    const found = refs(value)
    expect(found).toHaveLength(2)
    for (const ref of found) await expect(withRef(42, ref, function () { return true })).resolves.toBe(true)
  })

  it('fails when the document changes again during the reread', async () => {
    const { readAXPage } = await import('../tools/accessibility.js')
    const at = (loaderId: string) => [{ ...main, loaderId }]
    mocks.frames
      .mockResolvedValueOnce(at('a')).mockResolvedValueOnce(at('b'))
      .mockResolvedValueOnce(at('b')).mockResolvedValueOnce(at('c'))
    await expect(readAXPage(42, {})).rejects.toThrow(/again during its reread; wait, then observe again/)
  })

  it('rejects scoped-frame disappearance between liveness and collection', async () => {
    const { readAXPage } = await import('../tools/accessibility.js')
    const initial = refs(text(await readAXPage(42, {})))
    mocks.frames.mockResolvedValueOnce([main, child]).mockResolvedValueOnce([main])
    await expect(readAXPage(42, { refId: initial[2] })).rejects.toThrow(/Scoped ref \S+ is gone/)
  })

  it('rejects navigated frames and disconnected/replaced backend nodes, without fallback', async () => {
    const { readAXPage, withRef } = await import('../tools/accessibility.js')
    const [ref] = refs(text(await readAXPage(42, {})))
    mocks.frames.mockResolvedValueOnce([{ ...main, loaderId: 'new' }])
    await expect(withRef(42, ref!, function () { return true })).rejects.toThrow(/navigated/)
    mocks.send.mockImplementation(async (_tab, _frame, method) => {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'old-node' } }
      if (method === 'Runtime.callFunctionOn') return { result: {}, exceptionDetails: { text: 'Stale ref: node is disconnected' } }
      return {}
    })
    await expect(withRef(42, ref!, function () { return true })).rejects.toThrow(/disconnected/)
  })

  it('names the covering element and its overlay as fresh refs instead of clicking', async () => {
    mocks.frames.mockResolvedValue([main])
    const input = await import('../input.js')
    vi.mocked(input.withInput).mockImplementation(async (_tab, run) => run())
    const original = mocks.send.getMockImplementation()!
    const { readAXPage, refTool } = await import('../tools/accessibility.js')
    const [ref] = refs(text(await readAXPage(42, {})))
    const dispatched: string[] = []
    mocks.send.mockImplementation(async (tab, frame, method, params) => {
      if (method === 'Runtime.callFunctionOn' && params.returnByValue === false)
        return { result: { objectId: params.arguments[1].value } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: { x: 5, y: 5, covered: true } } }
      if (method === 'DOM.describeNode')
        return params.objectId === 'hit'
          ? { node: { backendNodeId: 77, localName: 'input', attributes: ['type', 'email', 'placeholder', 'Enter your email'] } }
          : { node: { backendNodeId: 78, localName: 'div', attributes: ['role', 'dialog', 'aria-label', 'Newsletter'] } }
      if (method.startsWith('Input.')) dispatched.push(method)
      return original(tab, frame, method, params)
    })
    const error = await refTool('click_element', 42, { refId: ref }).catch((e: Error) => e.message)
    expect(error).toMatch(new RegExp(`^Target ${ref} is covered by [a-z]{3}\\d+ <input placeholder="Enter your email">`))
    expect(error).toMatch(/inside overlay ([a-z]{3}\d+) <div role="dialog" aria-label="Newsletter">/)
    expect(error).toContain(`check step on ${ref}`)
    expect(dispatched).toEqual([])
    const overlay = /observe refId ([a-z]{3}\d+)/.exec(error as string)![1]!
    mocks.send.mockImplementation(original)
    // The named overlay is an ordinary registered ref: it can scope an observation.
    await expect(readAXPage(42, { refId: overlay })).rejects.toThrow(/no longer has an accessibility node/)
  })

  it('check sets a native control by ref through the explicit checkable path', async () => {
    mocks.frames.mockResolvedValue([main])
    const original = mocks.send.getMockImplementation()!
    const { readAXPage, refTool } = await import('../tools/accessibility.js')
    const [ref] = refs(text(await readAXPage(42, {})))
    const calls: unknown[] = []
    mocks.send.mockImplementation(async (tab, frame, method, params) => {
      if (method === 'Runtime.callFunctionOn') {
        calls.push(params.arguments)
        return { result: { value: null } }
      }
      return original(tab, frame, method, params)
    })
    expect(text(await refTool('form_input', 42, { refId: ref, checked: true }))).toBe(`Checked ${ref}.`)
    expect(text(await refTool('form_input', 42, { refId: ref, checked: false }))).toBe(`Unchecked ${ref}.`)
    expect(calls).toEqual([[{ value: 'true' }, { value: true }], [{ value: 'false' }, { value: true }]])
  })
})
