import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ send: vi.fn(), events: new Map<string, (value: unknown) => void>(), detached: new Set<(id: number) => void>() }))
vi.mock('../cdp.js', () => ({ cdpSession: {
  send: mock.send,
  onEvent: (_tab: number, event: string, callback: (value: unknown) => void) => {
    mock.events.set(event, callback)
    return () => mock.events.delete(event)
  },
  onDetach: (callback: (id: number) => void) => {
    mock.detached.add(callback)
    return () => mock.detached.delete(callback)
  },
} }))
import { navigateDocument } from '../navigation.js'
const milestone = (loaderId = 'intended', frameId = 'main') => mock.events.get('Page.lifecycleEvent')?.({ name: 'DOMContentLoaded', frameId, loaderId })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

beforeEach(() => {
  vi.stubGlobal('chrome', { tabs: { get: vi.fn().mockResolvedValue({ url: 'https://page.test' }) }, runtime: { id: 'bro' } })
  vi.useFakeTimers()
  mock.events.clear()
  mock.detached.clear()
  mock.send.mockReset().mockImplementation(async (_tab, method) => {
    if (method === 'Page.navigate') return { frameId: 'main', loaderId: 'intended' }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'intended', url: 'https://redirect.test/final' } } }
    return {}
  })
})
afterEach(() => vi.useRealTimers())

function expectClean(): void {
  expect(mock.events.size).toBe(0)
  expect(mock.detached.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
}

describe('document readiness at navigation dispatch', () => {
  it('ignores initial about:blank and child milestones, then preserves the redirected URL', async () => {
    let done = false
    const pending = navigateDocument(42, 'https://start.test').then((url) => { done = true; return url })
    await flush()
    milestone('initial-blank')
    milestone('intended', 'child')
    await flush()
    expect(done).toBe(false)
    milestone()
    await expect(pending).resolves.toBe('https://redirect.test/final')
    expectClean()
  })

  it('captures a cached document milestone arriving before the navigate reply', async () => {
    mock.send.mockImplementation(async (_tab, method) => {
      if (method === 'Page.navigate') {
        expect(mock.events.has('Page.lifecycleEvent')).toBe(true)
        milestone()
        return { frameId: 'main', loaderId: 'intended' }
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'intended', url: 'https://fast.test' } } }
      return {}
    })
    await expect(navigateDocument(42, 'https://fast.test')).resolves.toBe('https://fast.test')
    expectClean()
  })

  it('bounds unmet readiness and removes listeners on timeout', async () => {
    const pending = navigateDocument(42, 'https://slow.test')
    const assertion = expect(pending).rejects.toThrow(/DOMContentLoaded/)
    await flush()
    await vi.advanceTimersByTimeAsync(10000)
    await assertion
    expectClean()
  })

  it('cleans up dispatch failures without an orphan rejected wait', async () => {
    mock.send.mockImplementation(async (_tab, method) => {
      if (method === 'Page.navigate') throw new Error('navigation denied')
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'existing', url: 'https://page.test' } } }
      return {}
    })
    await expect(navigateDocument(42, 'https://bad.test')).rejects.toThrow('navigation denied')
    expectClean()
  })

  it('rejects a superseded document and interruption instead of reporting ready', async () => {
    const pending = navigateDocument(42, 'https://start.test')
    await flush()
    mock.send.mockResolvedValue({ frameTree: { frame: { id: 'main', loaderId: 'other', url: 'https://other.test' } } })
    milestone()
    await expect(pending).rejects.toThrow(/superseded/)
    expectClean()
    mock.send.mockImplementation(async (_tab, method) => method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'main', loaderId: 'existing', url: 'https://page.test' } } }
      : { frameId: 'main', loaderId: 'intended' })
    const interrupted = navigateDocument(42, 'https://start.test')
    await flush()
    for (const callback of mock.detached) callback(42)
    await expect(interrupted).rejects.toThrow(/interrupted/)
    expectClean()
  })

  it.each([false, true])('waits for an existing loading document and rejects its replacement=%s', async (replace) => {
    let loader = 'existing'
    mock.send.mockImplementation(async (_tab, method) => {
      if (method === 'Page.navigate') return { frameId: 'main' }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: loader, url: 'https://page.test/', urlFragment: '#section' } } }
      if (method === 'Runtime.evaluate') return { result: { value: false } }
      return {}
    })
    let done = false
    const pending = navigateDocument(42, 'https://page.test/#section').then((url) => { done = true; return url })
    await flush()
    expect(done).toBe(false)
    if (replace) loader = 'replacement'
    milestone('existing')
    if (replace) await expect(pending).rejects.toThrow(/superseded/)
    else await expect(pending).resolves.toBe('https://page.test/#section')
    expectClean()
  })

  it('accepts a committed same-document navigation without inventing a new DOM milestone', async () => {
    mock.send.mockImplementation(async (_tab, method) => {
      if (method === 'Page.navigate') return { frameId: 'main' }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'existing', url: 'https://page.test/', urlFragment: '#section' } } }
      if (method === 'Runtime.evaluate') return { result: { value: true } }
      return {}
    })
    await expect(navigateDocument(42, 'https://page.test/#section')).resolves.toBe('https://page.test/#section')
    expectClean()
  })
})
