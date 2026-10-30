import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.hoisted(() => vi.fn())
vi.mock('../cdp.js', () => ({ cdpSession: { send } }))
import { navigateDocument } from '../navigation.js'

interface Event { tabId: number; frameId: number; documentId: string; url: string; error?: string }
function eventSource<T>() {
  const listeners = new Set<(event: T) => void>()
  return {
    addListener: (listener: (event: T) => void) => listeners.add(listener),
    removeListener: (listener: (event: T) => void) => listeners.delete(listener),
    emit: (event: T) => { for (const listener of listeners) listener(event) },
    listeners,
  }
}
const before = eventSource<Event>()
const committed = eventSource<Event>()
const ready = eventSource<Event>()
const error = eventSource<Event>()
const removed = eventSource<number>()
const update = vi.fn()
const getFrame = vi.fn()
const event = (documentId: string, url = 'https://destination.test/') => ({ tabId: 42, frameId: 0, documentId, url })

beforeEach(() => {
  vi.useFakeTimers()
  send.mockReset()
  update.mockReset().mockResolvedValue({})
  getFrame.mockReset().mockResolvedValue({ documentId: 'destination', url: 'https://redirect.test/' })
  vi.stubGlobal('chrome', {
    runtime: { id: 'bro' },
    tabs: { get: vi.fn().mockResolvedValue({ url: 'chrome://newtab/' }), update, onRemoved: removed },
    webNavigation: { onBeforeNavigate: before, onCommitted: committed, onDOMContentLoaded: ready, onErrorOccurred: error, getFrame },
  })
})
afterEach(() => {
  expect([before, committed, ready, error, removed].every((source) => source.listeners.size === 0)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

describe('navigation out of browser-internal pages', () => {
  it('ignores source/child readiness and establishes the redirected destination document', async () => {
    let done = false
    const pending = navigateDocument(42, 'https://destination.test').then((url) => { done = true; return url })
    await flush()
    expect(update).toHaveBeenCalledWith(42, { url: 'https://destination.test/' })
    committed.emit(event('old', 'chrome://newtab/'))
    ready.emit(event('old', 'chrome://newtab/'))
    before.emit(event('destination'))
    committed.emit(event('destination'))
    ready.emit({ ...event('destination'), frameId: 1 })
    await flush()
    expect(done).toBe(false)
    ready.emit(event('destination'))
    await expect(pending).resolves.toBe('https://redirect.test/')
    expect(send).not.toHaveBeenCalled()
  })

  it('captures destination events before tabs.update resolves', async () => {
    update.mockImplementation(async () => {
      before.emit(event('destination'))
      committed.emit(event('destination'))
      ready.emit(event('destination'))
      return {}
    })
    await expect(navigateDocument(42, 'https://destination.test/')).resolves.toBe('https://redirect.test/')
  })

  it.each(['dispatch', 'removed', 'timeout', 'navigation', 'replacement'])('cleans listeners on %s failure', async (failure) => {
    if (failure === 'dispatch') update.mockRejectedValue(new Error('dispatch failed'))
    const pending = navigateDocument(42, 'https://destination.test/')
    const assertion = expect(pending).rejects.toThrow()
    await flush()
    before.emit(event('destination'))
    if (failure === 'removed') removed.emit(42)
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10000)
    if (failure === 'navigation') error.emit({ ...event('destination'), error: 'net::ERR_FAILED' })
    if (failure === 'replacement') {
      committed.emit(event('destination'))
      getFrame.mockResolvedValue({ documentId: 'replacement', url: 'https://other.test/' })
      ready.emit(event('destination'))
    }
    await assertion
  })
})
