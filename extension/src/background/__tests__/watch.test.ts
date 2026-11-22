import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../frames.js', () => ({
  getBrowserFrames: vi.fn(async () => [
    { id: 'MAIN', loaderId: 'l0', url: 'https://a.test/' },
    { id: 'CHAT', parentId: 'MAIN', loaderId: 'l1', url: 'https://chat.test/' },
  ]),
  sendToFrame: vi.fn(async (_tab: number, _frame: unknown, method: string) =>
    method === 'Page.createIsolatedWorld' ? { executionContextId: 3 } : {}),
}))

const sent = vi.hoisted(() => [] as unknown[])
vi.mock('../bridge-client.js', () => ({
  bridgeClient: { isConnected: true, send: (msg: unknown) => sent.push(msg) },
}))

vi.mock('../tools/accessibility.js', () => ({
  refNode: vi.fn(async () => ({ frame: { id: 'main' }, backendNodeId: 5 })),
  withRef: vi.fn(async () => undefined),
  resolveNamed: vi.fn(async () => 'r9'),
  describeNode: vi.fn(async () => ({ role: 'status', name: 'Job 1' })),
}))

const page = (overrides: object = {}) => [
  { result: { installed: false, url: 'https://a.test', records: [], dropped: 0, targetLost: false, ...overrides } },
]

beforeEach(() => {
  vi.resetModules()
  sent.length = 0
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async () => ({ url: 'https://a.test' })), onRemoved: { addListener: vi.fn() } },
    scripting: { executeScript: vi.fn(async () => page()) },
    debugger: { onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() } },
    runtime: { id: 'bro', lastError: undefined, onMessage: { addListener: vi.fn() } },
    webNavigation: { onDOMContentLoaded: { addListener: vi.fn() } },
  })
})

// The listener the module registered on a chrome event.
const listener = <T extends (...args: never[]) => unknown>(event: { addListener: unknown }) =>
  vi.mocked(event.addListener as (cb: T) => void).mock.calls[0]![0]

const cmd = (target: object = { kind: 'page' }, resolve = false) => ({
  watchId: 'w1',
  op: 'probe' as const,
  target: target as never,
  condition: { kind: 'text' as const, text: 'Done' },
  resolve,
})

describe('watch probe', () => {
  // A frozen page runs no script: executeScript would wait until it thaws
  // and the watch would sit silent. The tab record answers instead.
  it.each([
    ['frozen', { frozen: true }],
    ['discarded', { discarded: true }],
  ])('reports a %s tab without sending the page a script', async (state, tab) => {
    vi.mocked(chrome.tabs.get).mockResolvedValue({ url: 'https://a.test', ...tab } as never)
    const { probe } = await import('../watch.js')
    await expect(probe(1, cmd())).resolves.toEqual({ tab: state })
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('reports a closed tab as a state, not an error', async () => {
    vi.mocked(chrome.tabs.get).mockRejectedValue(new Error('No tab with id: 1.'))
    const { probe } = await import('../watch.js')
    await expect(probe(1, cmd())).resolves.toEqual({ tab: 'closed' })
  })

  it('evaluates in the main frame of the extension world', async () => {
    const { probe } = await import('../watch.js')
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue(
      page({ installed: true, records: [{ at: 1, met: false }] }) as never,
    )
    const result = await probe(1, cmd())
    expect(result).toEqual({ tab: 'live', url: 'https://a.test', installed: true, records: [{ at: 1, met: false }] })
    const call = vi.mocked(chrome.scripting.executeScript).mock.calls[0]![0] as unknown as {
      target: unknown
      world: string
    }
    expect(call.target).toEqual({ tabId: 1, frameIds: [0] })
    expect(call.world).toBe('ISOLATED')
  })

  // A re-render replaced the pinned node: the probe re-pins the element with
  // the same role and name and evaluates again in the same call.
  it('re-pins a replaced node target by role and name', async () => {
    const a11y = await import('../tools/accessibility.js')
    const { probe } = await import('../watch.js')
    vi.mocked(chrome.scripting.executeScript)
      .mockResolvedValueOnce(page({ targetLost: true, records: [{ at: 1, met: false }] }) as never)
      .mockResolvedValueOnce(page({ records: [{ at: 2, met: true, snippet: 'Done' }] }) as never)
    const result = await probe(1, cmd({ kind: 'node', role: 'status', name: 'Job 1' }, true))
    expect(a11y.resolveNamed).toHaveBeenCalledWith(1, 'status', 'Job 1', undefined)
    expect(a11y.withRef).toHaveBeenCalledWith(1, 'r9', expect.any(Function), ['__bro_watch_pin_w1'])
    expect(result.targetLost).toBe(false)
    expect(result.resolved).toEqual({ role: 'status', name: 'Job 1' })
    expect(result.records).toEqual([{ at: 1, met: false }, { at: 2, met: true, snippet: 'Done' }])
  })

  it('reports a node it could not re-resolve as lost, with the reason', async () => {
    const a11y = await import('../tools/accessibility.js')
    vi.mocked(a11y.resolveNamed).mockRejectedValueOnce(new Error('No visible status named "Job 1"'))
    const { probe } = await import('../watch.js')
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue(page({ targetLost: true }) as never)
    const result = await probe(1, cmd({ kind: 'node', role: 'status', name: 'Job 1' }, true))
    expect(result.targetLost).toBe(true)
    expect(result.resolveError).toBe('No visible status named "Job 1"')
  })

  // Observe names frames by CDP id; chrome.scripting needs its own id. The
  // frame that hears the event fired over CDP is the one, even when a sibling
  // frame shows the same URL.
  it('runs the latch in the frame a frameId names, located exactly', async () => {
    const frames = await import('../frames.js')
    const { probe } = await import('../watch.js')
    const script = vi.mocked(chrome.scripting.executeScript)
    script.mockImplementation((async (injection: { target: { allFrames?: boolean; frameIds?: number[] } }) => {
      if (!injection.target.allFrames) return page({ installed: true, url: 'https://chat.test/' })
      // The second sweep asks which frame heard the event.
      return script.mock.calls.filter(([i]) => (i as { target: { allFrames?: boolean } }).target.allFrames).length === 1
        ? []
        : [{ frameId: 0, result: false }, { frameId: 4, result: false }, { frameId: 7, result: true }]
    }) as never)
    const result = await probe(1, cmd({ kind: 'page', frameId: 'CHAT' }))
    expect(result.frame).toEqual({ frameId: 'CHAT', scriptFrame: 7 })
    const dispatched = vi.mocked(frames.sendToFrame).mock.calls.find(([, , method]) => method === 'Runtime.evaluate')!
    expect(dispatched[1]).toMatchObject({ id: 'CHAT' })
    expect(dispatched[3]).toMatchObject({ contextId: 3, expression: expect.stringMatching(/^document\.dispatchEvent/) })
    const latchCall = script.mock.calls.at(-1)![0] as unknown as { target: unknown }
    expect(latchCall.target).toEqual({ tabId: 1, frameIds: [7] })
  })

  it('reuses a located frame without locating it again', async () => {
    const { probe } = await import('../watch.js')
    await probe(1, cmd({ kind: 'page', frameId: 'CHAT', scriptFrame: 7 }))
    const calls = vi.mocked(chrome.scripting.executeScript).mock.calls
    expect(calls).toHaveLength(1)
    expect((calls[0]![0] as unknown as { target: unknown }).target).toEqual({ tabId: 1, frameIds: [7] })
  })

  it('fails rather than guess when no single frame heard the event', async () => {
    const { probe } = await import('../watch.js')
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([{ frameId: 0, result: false }] as never)
    await expect(probe(1, cmd({ kind: 'page', frameId: 'CHAT' }))).rejects.toThrow(/cannot script frame CHAT .*0 frames answered/)
  })

  it('says the watched frame is gone when its page removed it', async () => {
    const { probe } = await import('../watch.js')
    vi.mocked(chrome.scripting.executeScript).mockRejectedValue(new Error('No frame with id 7 in tab 1.'))
    await expect(probe(1, cmd({ kind: 'page', frameId: 'CHAT', scriptFrame: 7 }))).rejects.toThrow(/the watched frame is gone/)
  })

  it('pins a ref in a child frame from inside that frame', async () => {
    const a11y = await import('../tools/accessibility.js')
    vi.mocked(a11y.refNode).mockResolvedValue({ frame: { id: 'CHAT', parentId: 'MAIN', loaderId: 'l1', url: 'https://chat.test/' }, backendNodeId: 5 } as never)
    const { probe } = await import('../watch.js')
    const script = vi.mocked(chrome.scripting.executeScript)
    let sweeps = 0
    script.mockImplementation((async (injection: { target: { allFrames?: boolean } }) => {
      if (injection.target.allFrames) return ++sweeps === 1 ? [] : [{ frameId: 7, result: true }]
      return page({ targetLost: script.mock.calls.filter(([i]) => !(i as { target: { allFrames?: boolean } }).target.allFrames).length === 1 })
    }) as never)
    const result = await probe(1, cmd({ kind: 'node', refId: 'r3' }, true))
    expect(result.frame).toEqual({ frameId: 'CHAT', scriptFrame: 7 })
    expect(a11y.withRef).toHaveBeenCalledWith(1, 'r3', expect.any(Function), ['__bro_watch_pin_w1'])
    expect(result.targetLost).toBe(false)
    for (const [injection] of script.mock.calls.filter(([i]) => !(i as { target: { allFrames?: boolean } }).target.allFrames))
      expect((injection as unknown as { target: unknown }).target).toEqual({ tabId: 1, frameIds: [7] })
  })
})

describe('watch push', () => {
  type OnMessage = (message: unknown, sender: chrome.runtime.MessageSender, reply: (r: unknown) => void) => boolean
  const push = async (sender: Partial<chrome.runtime.MessageSender>, watchId = 'w1') => {
    const reply = vi.fn()
    listener<OnMessage>(chrome.runtime.onMessage)(
      { type: 'BRO_WATCH_PUSH', watchId, result: { tab: 'live', url: 'https://a.test', records: [{ at: 3, met: true }] } },
      { id: 'bro', ...sender } as chrome.runtime.MessageSender,
      reply,
    )
    return reply.mock.calls[0]![0]
  }

  it("forwards a probed watch's push from its own tab and frame", async () => {
    const { probe } = await import('../watch.js')
    await probe(1, cmd())
    expect(await push({ tab: { id: 1 } as chrome.tabs.Tab, frameId: 0 })).toEqual({ delivered: true })
    expect(sent).toEqual([
      { type: 'watch_event', watchId: 'w1', tabId: 1, result: { tab: 'live', url: 'https://a.test', records: [{ at: 3, met: true }] } },
    ])
  })

  // The latch keeps what was not delivered for the next probe.
  it.each([
    ['another tab', { tab: { id: 2 } as chrome.tabs.Tab, frameId: 0 }, 'w1'],
    ['another frame', { tab: { id: 1 } as chrome.tabs.Tab, frameId: 4 }, 'w1'],
    ['an unknown watch', { tab: { id: 1 } as chrome.tabs.Tab, frameId: 0 }, 'w2'],
    ['another extension', { id: 'other', tab: { id: 1 } as chrome.tabs.Tab, frameId: 0 }, 'w1'],
  ])('refuses a push from %s', async (_, sender, watchId) => {
    const { probe } = await import('../watch.js')
    await probe(1, cmd())
    expect(await push(sender, watchId)).toEqual({ delivered: false })
    expect(sent).toEqual([])
  })

  it('forgets a stopped watch', async () => {
    const { probe } = await import('../watch.js')
    await probe(1, cmd())
    await probe(1, { ...cmd(), op: 'stop' })
    expect(await push({ tab: { id: 1 } as chrome.tabs.Tab, frameId: 0 })).toEqual({ delivered: false })
  })

  // A navigation replaced the document: the latch is reinstalled in the
  // watched frame only, and the new page's value is sent at once.
  it('reinstalls the latch when its frame loads a new document', async () => {
    const { probe } = await import('../watch.js')
    await probe(1, cmd({ kind: 'page', frameId: 'CHAT', scriptFrame: 7 }))
    const script = vi.mocked(chrome.scripting.executeScript)
    script.mockClear()
    script.mockResolvedValue(page({ installed: true, url: 'https://chat.test/next', records: [{ at: 5, met: false }] }) as never)
    const loaded = listener<(d: { tabId: number; frameId: number }) => void>(chrome.webNavigation.onDOMContentLoaded)
    loaded({ tabId: 1, frameId: 0 })
    loaded({ tabId: 2, frameId: 7 })
    expect(script).not.toHaveBeenCalled()
    loaded({ tabId: 1, frameId: 7 })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect((script.mock.calls[0]![0] as unknown as { target: unknown }).target).toEqual({ tabId: 1, frameIds: [7] })
    expect(sent[0]).toMatchObject({ type: 'watch_event', watchId: 'w1', tabId: 1, result: { tab: 'live', url: 'https://chat.test/next', installed: true } })
  })

  it('pushes a closed tab once', async () => {
    const { probe } = await import('../watch.js')
    await probe(1, cmd())
    const removed = listener<(tabId: number) => void>(chrome.tabs.onRemoved)
    removed(2)
    removed(1)
    removed(1)
    expect(sent).toEqual([{ type: 'watch_event', watchId: 'w1', tabId: 1, result: { tab: 'closed' } }])
  })
})
