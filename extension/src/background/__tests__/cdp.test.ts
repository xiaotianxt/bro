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
  it('removes foreign frames before input even in a tab that never showed one', async () => {
    const { cdpSession } = await import('../cdp.js')
    removeFrames([1])
    await cdpSession.removeForeignFramesBeforeInput(8)
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 8, allFrames: true } }))
    // Seen once, the tab's frames are removed before every attach as well.
    removeFrames([0])
    await cdpSession.ensure(8)
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1)
  })

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

  it('attaches to a frozen tab without waiting on scripts the frozen page cannot run', async () => {
    const { cdpSession } = await import('../cdp.js')
    // An earlier foreign frame makes every later attach try to remove frames first.
    rejectAttach(1)
    removeFrames([1])
    await cdpSession.ensure(42)
    await cdpSession.detach(42)
    Object.assign(chrome.tabs, { get: vi.fn(async () => ({ url: 'https://example.test', frozen: true })) })
    Object.assign(chrome, { scripting: { executeScript: vi.fn(() => new Promise(() => {})) } })
    await cdpSession.send(42, 'Page.navigate', { url: 'https://example.test/next' })
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 42 }, 'Page.navigate', { url: 'https://example.test/next' })

    // A frame that does block attach cannot be removed until the tab unfreezes: say so at once.
    rejectAttach(Infinity)
    await cdpSession.detach(42)
    await expect(cdpSession.ensure(42)).rejects.toThrow(/Removing foreign extension frames failed: Error: tab 42 is frozen/)
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
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
    expect(invalidate).toHaveBeenCalledWith(1, 'bro detached the idle debugger')
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

  it('never detaches on a slow command, and bounds only commands that pass timeoutMs', async () => {
    vi.useFakeTimers()
    try {
      const { cdpSession, CDP_COMMAND_TIMEOUT_MS } = await import('../cdp.js')
      const detached = vi.fn()
      cdpSession.onDetach(detached)
      vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) =>
        method === 'Page.navigate' || method === 'Runtime.evaluate' ? new Promise(() => {}) : {})
      const navigate = cdpSession.send(3, 'Page.navigate', { url: 'https://slow.test' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(detached).not.toHaveBeenCalled()
      expect(chrome.debugger.detach).not.toHaveBeenCalled()
      const evaluate = expect(cdpSession.send(3, 'Runtime.evaluate', undefined, CDP_COMMAND_TIMEOUT_MS)).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(CDP_COMMAND_TIMEOUT_MS)
      await evaluate
      expect(detached).not.toHaveBeenCalled()
      expect(chrome.debugger.detach).not.toHaveBeenCalled()
      void navigate
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression: a pump capture that began during a scaled screenshot left the
  // page at half its viewport, and at a quarter after the next one.
  it('sends one capture per tab at a time, in order, whoever asks', async () => {
    const { cdpSession } = await import('../cdp.js')
    const replies: (() => void)[] = []
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) =>
      method === 'Page.captureScreenshot' ? new Promise<object>((resolve) => replies.push(() => resolve({}))) : {})
    const sent = () =>
      vi.mocked(chrome.debugger.sendCommand).mock.calls
        .filter(([, method]) => method === 'Page.captureScreenshot')
        .map(([target, , params]) => `${target.tabId}:${(params as { quality: number }).quality}`)
    const settle = () => new Promise((resolve) => setTimeout(resolve))

    const first = cdpSession.send(7, 'Page.captureScreenshot', { quality: 1 })
    const second = cdpSession.send(7, 'Page.captureScreenshot', { quality: 2 })
    const other = cdpSession.send(8, 'Page.captureScreenshot', { quality: 3 })
    await settle()
    expect(sent()).toEqual(['7:1', '8:3'])
    replies[0]!()
    await first
    await settle()
    expect(sent()).toEqual(['7:1', '8:3', '7:2'])
    replies[1]!()
    replies[2]!()
    await Promise.all([second, other])
  })

  it('sends the next capture after one that failed', async () => {
    const { cdpSession } = await import('../cdp.js')
    let captures = 0
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) => {
      if (method === 'Page.captureScreenshot' && ++captures === 1) throw new Error('Unable to capture screenshot')
      return { data: 'ok' }
    })
    const failed = cdpSession.send(7, 'Page.captureScreenshot')
    const next = cdpSession.send(7, 'Page.captureScreenshot')
    await expect(failed).rejects.toThrow(/Unable to capture screenshot/)
    await expect(next).resolves.toEqual({ data: 'ok' })
  })

  it('notifies frame owners and never replays a command after attachment loss', async () => {
    const { cdpSession } = await import('../cdp.js')
    const invalidate = vi.fn()
    cdpSession.onDetach(invalidate)
    vi.mocked(chrome.debugger.sendCommand).mockRejectedValueOnce(new Error('Debugger is not attached'))
    await expect(cdpSession.send(2, 'Input.dispatchMouseEvent')).rejects.toThrow('Debugger is not attached')
    expect(invalidate).toHaveBeenCalledWith(2, expect.stringContaining('Debugger is not attached'))
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1)
    expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(1)
    await cdpSession.ensure(2)
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2)
  })
  // Regression (live, password manager): while another extension's frame is
  // in the page Chrome rejects every debugger call from bro, detach included,
  // and keeps the session. Treating that detach as done made every later
  // attach fail with "Another debugger is already attached".
  it('removes a foreign frame that blocks detach, so the next attach finds the tab free', async () => {
    const { cdpSession } = await import('../cdp.js')
    let chromeAttached = false
    let foreignFrame = false
    const settle = (message: string | undefined, done: () => void) => {
      if (message) Object.assign(chrome.runtime, { lastError: { message } })
      done()
      Object.assign(chrome.runtime, { lastError: undefined })
    }
    vi.mocked(chrome.debugger.attach).mockImplementation((_target, _version, done) => {
      if (foreignFrame) return settle(foreignRejection, done!)
      if (chromeAttached) return settle('Another debugger is already attached to the tab with id: 3.', done!)
      chromeAttached = true
      settle(undefined, done!)
    })
    vi.mocked(chrome.debugger.detach).mockImplementation((_target, done) => {
      if (foreignFrame) return settle(foreignRejection, done!)
      chromeAttached = false
      settle(undefined, done!)
    })
    Object.assign(chrome, { scripting: { executeScript: vi.fn(async () => {
      const removed = foreignFrame ? 1 : 0
      foreignFrame = false
      return [{ result: removed }]
    }) } })
    await cdpSession.ensure(3)
    foreignFrame = true
    vi.mocked(chrome.debugger.sendCommand).mockRejectedValueOnce(new Error(foreignRejection))
    await expect(cdpSession.send(3, 'Runtime.releaseObject')).rejects.toThrow('Chrome closed the debugger session')
    await cdpSession.send(3, 'Runtime.evaluate')
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2)
    expect(chrome.debugger.sendCommand).toHaveBeenLastCalledWith({ tabId: 3 }, 'Runtime.evaluate', {})
  })
})
