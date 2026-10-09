import { beforeEach, describe, expect, it, vi } from 'vitest'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('chrome', {
    runtime: { lastError: undefined },
    tabs: { get: vi.fn(async () => ({ url: 'https://example.test' })) },
    debugger: {
      attach: vi.fn((_target, _version, done) => done()),
      detach: vi.fn((_target, done) => done()),
      sendCommand: vi.fn(async () => ({})),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
  })
})

describe('CDP attachment lifecycle', () => {
  it('invalidates frame state before idle detach and blocks the next attach until cleanup finishes', async () => {
    const { cdpSession } = await import('../cdp.js')
    await cdpSession.ensure(1)
    const started = deferred(), finish = deferred()
    vi.mocked(chrome.debugger.detach).mockImplementation((_target, done) => {
      started.resolve()
      void finish.promise.then(() => done!())
    })
    const invalidate = vi.fn()
    cdpSession.onDetach(invalidate)
    const cleanup = cdpSession.detachIfIdle(1)
    await started.promise
    expect(invalidate).toHaveBeenCalledWith(1)
    const next = cdpSession.send(1, 'Page.getFrameTree')
    await Promise.resolve()
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1)
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled()
    finish.resolve()
    await cleanup
    await next
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('notifies frame owners and never replays a command after attachment loss', async () => {
    const { cdpSession } = await import('../cdp.js')
    const invalidate = vi.fn()
    cdpSession.onDetach(invalidate)
    vi.mocked(chrome.debugger.sendCommand).mockRejectedValueOnce(new Error('Debugger is not attached'))
    await expect(cdpSession.send(2, 'Input.dispatchMouseEvent')).rejects.toThrow('Debugger is not attached')
    expect(invalidate).toHaveBeenCalledWith(2)
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1)
    expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(1)
    await cdpSession.ensure(2)
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2)
  })
})
