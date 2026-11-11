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

const foreignRejection = 'Cannot access a chrome-extension:// URL of different extension'

function rejectAttach(times: number) {
  let remaining = times
  vi.mocked(chrome.debugger.attach).mockImplementation((_target, _version, done) => {
    if (remaining-- > 0) Object.assign(chrome.runtime, { lastError: { message: foreignRejection } })
    done!()
    Object.assign(chrome.runtime, { lastError: undefined })
  })
}

function removeFrames(perFrame: number[]) {
  Object.assign(chrome, { scripting: { executeScript: vi.fn(async () => perFrame.map((result) => ({ result }))) } })
}

describe('CDP attachment lifecycle', () => {
  it('removes a foreign extension iframe and attaches without reload or pause', async () => {
    const { cdpSession } = await import('../cdp.js')
    rejectAttach(1)
    removeFrames([1, 0])
    await cdpSession.send(42, 'Runtime.evaluate')
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 42, allFrames: true }, world: 'ISOLATED',
    }))
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2)
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 42 }, 'Runtime.evaluate', {})
  })

  it('guides cross-extension recovery when no frame could be removed, without sending or replaying input', async () => {
    const { cdpSession } = await import('../cdp.js')
    rejectAttach(Infinity)
    removeFrames([0])
    let message = ''
    try { await cdpSession.send(42, 'Input.dispatchMouseEvent') }
    catch (error) { message = (error as Error).message }
    expect(message).toContain(`CDP attach failed for tab 42: ${foreignRejection}`)
    expect(message).toContain('[CDP_FOREIGN_EXTENSION]')
    expect(message).toContain('already removed')
    expect(message).toContain('bro_search_tools')
    expect(message).toContain('extensions_status')
    expect(message).toContain('keep it enabled')
    expect(message).toContain('explicit user authorization')
    expect(message).toContain('extensions_resume')
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1)
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('treats focus cleanup on a session Chrome closed as done, since the closure cleared emulation', async () => {
    const { cdpSession } = await import('../cdp.js')
    await cdpSession.ensure(7)
    vi.mocked(chrome.debugger.sendCommand).mockRejectedValueOnce(new Error('Debugger is not attached to the tab with id: 7.'))
    await expect(cdpSession.resetInputFocus(7)).resolves.toBeUndefined()
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
  })

  it('keeps the attach rejection when removing frames fails', async () => {
    const { cdpSession } = await import('../cdp.js')
    rejectAttach(Infinity)
    Object.assign(chrome, { scripting: { executeScript: vi.fn(async () => { throw new Error('Cannot access contents of the page') }) } })
    await expect(cdpSession.ensure(42)).rejects.toThrow(
      /\[CDP_FOREIGN_EXTENSION\][\s\S]*Removing foreign extension frames failed: Error: Cannot access contents of the page/,
    )
  })

  it('invalidates frame state before idle detach and blocks the next attach until cleanup finishes', async () => {
    const { cdpSession } = await import('../cdp.js')
    await cdpSession.ensure(1)
    // Attachment enables page events and chooser interception, so native
    // dialogs and file choosers are answered instead of blocking.
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Page.enable', {})
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Page.setInterceptFileChooserDialog', { enabled: true })
    vi.mocked(chrome.debugger.sendCommand).mockClear()
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
