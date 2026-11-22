import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Rendering state is render-state.ts's contract, tested there.
vi.mock('../render-state.js', () => ({ renderState: vi.fn(async () => 'hidden') }))

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
  // Regression: an active tab in an occluded window was skipped as if shown,
  // so it drew no frame and input into its cross-site frames missed.
  it('pumps by render state: an active hidden tab, never a painting one', async () => {
    const { renderState } = await import('../render-state.js')
    const { keepRendering } = await import('../render-pump.js')
    vi.mocked(chrome.tabs.get).mockResolvedValue({ active: true, url: 'https://example.test' } as never)
    const captures = () =>
      vi.mocked(chrome.debugger.sendCommand).mock.calls.filter(([, method]) => method === 'Page.captureScreenshot')
    keepRendering(4)
    await vi.advanceTimersByTimeAsync(300)
    expect(captures()).toHaveLength(1)
    vi.mocked(renderState).mockResolvedValue('painting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(captures()).toHaveLength(1)
    vi.mocked(renderState).mockResolvedValue('hidden')
  })

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
