import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdp = vi.hoisted(() => ({ send: vi.fn(), onDetach: vi.fn() }))
vi.mock('../cdp.js', () => ({ cdpSession: cdp }))

let tab: Partial<chrome.tabs.Tab>
let visibility: string
let liveContext: number
let nextContext: number

beforeEach(() => {
  vi.resetModules()
  tab = { id: 5, active: true, url: 'https://example.test' }
  visibility = 'visible'
  nextContext = 1
  liveContext = 0
  vi.stubGlobal('chrome', { tabs: { get: vi.fn(async () => tab) } })
  cdp.send.mockReset().mockImplementation(async (_tab: number, method: string, params: { contextId?: number }) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: (liveContext = nextContext++) }
    if (method === 'Runtime.evaluate') {
      if (params.contextId !== liveContext) throw new Error('Cannot find context with specified id')
      return { result: { value: visibility } }
    }
    throw new Error(`unexpected ${method}`)
  })
})

describe('render state', () => {
  it('judges a live tab by what its document was rendered for, not by tab.active', async () => {
    const { renderState } = await import('../render-state.js')
    expect(await renderState(5, 'session')).toBe('painting')
    // An active tab in an occluded window: Chrome hides it and draws nothing.
    visibility = 'hidden'
    expect(await renderState(5, 'session')).toBe('hidden')
    tab = { ...tab, active: false }
    expect(await renderState(5, 'session')).toBe('hidden')
    visibility = 'visible'
    expect(await renderState(5, 'session')).toBe('painting')
  })

  it('names frozen and discarded tabs without asking the page', async () => {
    const { renderState } = await import('../render-state.js')
    tab = { ...tab, frozen: true }
    expect(await renderState(5, 'session')).toBe('frozen')
    tab = { ...tab, frozen: false, discarded: true }
    expect(await renderState(5, 'session')).toBe('discarded')
    expect(cdp.send).not.toHaveBeenCalled()
  })

  // Regression: the pump asks every tick; a session-bound read timed out behind
  // a multi-second AX tree read and detached the tab under the observe.
  it('bounds every page read as its caller asks', async () => {
    const { renderState } = await import('../render-state.js')
    await renderState(5, 'caller')
    expect(cdp.send.mock.calls.map((call) => call[3])).toEqual(['caller', 'caller', 'caller'])
    cdp.send.mockClear()
    liveContext = -1
    await renderState(5, 'session')
    expect(cdp.send.mock.calls.map((call) => call[3])).toEqual(['session', 'session', 'session', 'session'])
  })

  it('reads in an isolated world it replaces when navigation destroys it', async () => {
    const { renderState } = await import('../render-state.js')
    expect(await renderState(5, 'session')).toBe('painting')
    expect(await renderState(5, 'session')).toBe('painting')
    expect(cdp.send.mock.calls.filter(([, method]) => method === 'Page.createIsolatedWorld')).toHaveLength(1)
    liveContext = -1 // the document navigated
    visibility = 'hidden'
    expect(await renderState(5, 'session')).toBe('hidden')
    expect(cdp.send.mock.calls.filter(([, method]) => method === 'Page.createIsolatedWorld')).toHaveLength(2)
  })
})
