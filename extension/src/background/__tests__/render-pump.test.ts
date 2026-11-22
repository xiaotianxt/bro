import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('chrome', {
    runtime: { lastError: undefined },
    storage: { session: { set: vi.fn(async () => {}) } },
    tabs: {
      get: vi.fn(async () => ({ active: false, url: 'https://example.test' })),
      onRemoved: { addListener: vi.fn() },
    },
    debugger: {
      attach: vi.fn((_target, _version, done) => done()),
      detach: vi.fn((_target, done) => done()),
      sendCommand: vi.fn(async () => ({})),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('render pump', () => {
  // Regression: a capture queued behind a multi-second AX tree read timed out,
  // and the session timeout detached the tab under the observe.
  it('keeps the tab attached while a capture waits on a busy renderer', async () => {
    const { cdpSession, CDP_COMMAND_TIMEOUT_MS } = await import('../cdp.js')
    const { keepRendering } = await import('../render-pump.js')
    const detached = vi.fn()
    cdpSession.onDetach(detached)
    vi.mocked(chrome.debugger.sendCommand).mockImplementation(async (_target, method) =>
      method === 'Page.captureScreenshot' ? new Promise(() => {}) : {})

    keepRendering(9)
    await vi.advanceTimersByTimeAsync(CDP_COMMAND_TIMEOUT_MS * 4)

    expect(detached).not.toHaveBeenCalled()
    expect(chrome.debugger.detach).not.toHaveBeenCalled()
    const captures = vi.mocked(chrome.debugger.sendCommand).mock.calls
      .filter(([, method]) => method === 'Page.captureScreenshot')
    expect(captures).toHaveLength(1)
  })
})
