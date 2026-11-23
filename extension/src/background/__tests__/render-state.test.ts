import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// Chrome freezes background tabs past a few; a frozen page answers no injected
// script until it unfreezes, a minute later. Regression: an act on such a tab
// hung until the bridge's 30 s timeout.
describe('keeping an acted-on tab live', () => {
  type Listener = (id: number, change: chrome.tabs.OnUpdatedInfo) => void
  let listeners: Set<Listener>
  let resumes: boolean
  const change = (info: chrome.tabs.OnUpdatedInfo) => {
    Object.assign(tab, info)
    for (const listener of [...listeners]) listener(5, info)
  }
  let script: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    listeners = new Set()
    resumes = true
    script = vi.fn(async () => [{ frameId: 0, result: 'ran' }])
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(async () => ({ ...tab })),
        onUpdated: { addListener: (l: Listener) => listeners.add(l), removeListener: (l: Listener) => listeners.delete(l) },
      },
      scripting: { executeScript: script },
    })
    cdp.send.mockReset().mockImplementation(async (_tab: number, method: string, params: { state?: string }) => {
      if (method !== 'Page.setWebLifecycleState') throw new Error(`unexpected ${method}`)
      expect(params.state).toBe('active')
      // Chrome reports the resumed tab on a later task.
      if (resumes) queueMicrotask(() => change({ frozen: false }))
    })
  })
  afterEach(() => vi.useRealTimers())

  const inject = { target: { tabId: 5, frameIds: [0] }, world: 'ISOLATED' as const, func: () => 'ran' }
  const lifecycleCalls = () => cdp.send.mock.calls.filter(([, method]) => method === 'Page.setWebLifecycleState')

  it('leaves a live tab alone', async () => {
    const { keepLive, inLivePage } = await import('../render-state.js')
    await keepLive(5)
    expect(await inLivePage(inject)).toEqual([{ frameId: 0, result: 'ran' }])
    expect(cdp.send).not.toHaveBeenCalled()
  })

  it('resumes a tab frozen before the act', async () => {
    const { inLivePage } = await import('../render-state.js')
    tab = { ...tab, frozen: true }
    expect(await inLivePage(inject)).toEqual([{ frameId: 0, result: 'ran' }])
    expect(lifecycleCalls()).toHaveLength(1)
  })

  it('resumes a tab Chrome freezes while the script waits', async () => {
    const { inLivePage } = await import('../render-state.js')
    let run!: () => void
    script.mockImplementation(() => new Promise((resolve) => (run = () => resolve([{ frameId: 0, result: 'ran' }]))))
    const pending = inLivePage(inject)
    await vi.advanceTimersByTimeAsync(0)
    change({ frozen: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(lifecycleCalls()).toHaveLength(1)
    run()
    expect(await pending).toEqual([{ frameId: 0, result: 'ran' }])
  })

  // Regression: Chrome delivered a freeze ahead of the reply to the tab read
  // made just before it. The read said live, the listener was not armed yet,
  // and the script waited 8 s for Chrome to unfreeze the tab by itself.
  it('resumes a tab whose freeze arrives ahead of the tab read made before it', async () => {
    const { inLivePage } = await import('../render-state.js')
    vi.mocked(chrome.tabs.get).mockImplementationOnce(async () => {
      const before = { ...tab } as chrome.tabs.Tab
      change({ frozen: true })
      return before
    })
    expect(await inLivePage(inject)).toEqual([{ frameId: 0, result: 'ran' }])
    expect(lifecycleCalls()).toHaveLength(1)
  })

  it('fails a discarded tab at once, naming why', async () => {
    const { inLivePage } = await import('../render-state.js')
    tab = { ...tab, discarded: true }
    await expect(inLivePage(inject)).rejects.toThrow(/tab 5 is discarded/)
    expect(script).not.toHaveBeenCalled()
  })

  it('fails a tab that does not resume within RESUME_MS, not at the bridge timeout', async () => {
    const { inLivePage, RESUME_MS } = await import('../render-state.js')
    resumes = false
    tab = { ...tab, frozen: true }
    const pending = inLivePage(inject)
    const failed = expect(pending).rejects.toThrow(/tab 5 is frozen by Chrome and did not resume/)
    await vi.advanceTimersByTimeAsync(RESUME_MS)
    await failed
    expect(script).not.toHaveBeenCalled()
  })

  it('fails a script frozen mid-call that does not resume, naming the freeze', async () => {
    const { inLivePage, RESUME_MS } = await import('../render-state.js')
    script.mockImplementation(() => new Promise(() => {}))
    const pending = inLivePage(inject)
    const failed = expect(pending).rejects.toThrow(/tab 5 is frozen by Chrome and did not resume/)
    await vi.advanceTimersByTimeAsync(0)
    resumes = false
    change({ frozen: true })
    await vi.advanceTimersByTimeAsync(RESUME_MS)
    await failed
  })

  it('bounds a script on a live page whose main thread never answers', async () => {
    const { inLivePage, IN_PAGE_TIMEOUT_MS } = await import('../render-state.js')
    script.mockImplementation(() => new Promise(() => {}))
    const pending = inLivePage(inject)
    const failed = expect(pending).rejects.toThrow(new RegExp(`did not run bro's page script within ${IN_PAGE_TIMEOUT_MS} ms`))
    await vi.advanceTimersByTimeAsync(IN_PAGE_TIMEOUT_MS)
    await failed
    expect(listeners.size).toBe(0)
  })
})
