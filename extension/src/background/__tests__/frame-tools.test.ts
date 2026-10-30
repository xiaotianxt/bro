import { beforeEach, describe, expect, it, vi } from 'vitest'

let commands: Array<{ method: string; params: Record<string, unknown> }>

function installChromeMock(): void {
  commands = []
  vi.stubGlobal('chrome', {
    runtime: { id: 'bro-extension', lastError: undefined, getURL: (path: string) => path },
    debugger: {
      attach: vi.fn((_target, _version, callback) => callback()),
      detach: vi.fn((_target, callback) => callback()),
      sendCommand: vi.fn(
        (
          _target: chrome.debugger.Debuggee,
          method: string,
          params: Record<string, unknown>,
        ) => {
          commands.push({ method, params })
          if (method === 'Page.getFrameTree') {
            return Promise.resolve({
              frameTree: {
                frame: { id: 'root', url: 'https://example.test', name: '' },
                childFrames: [
                  { frame: { id: 'child-1', parentId: 'root', url: 'https://example.test/frame', name: 'editor' } },
                ],
              },
            })
          }
          if (method === 'Page.createIsolatedWorld') {
            return Promise.resolve({ executionContextId: 99 })
          }
          if (method === 'Runtime.evaluate') {
            return Promise.resolve({ result: { value: { result: '"LUNA_IFRAME_OK"', isError: false } } })
          }
          return Promise.resolve({})
        },
      ),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    tabs: { get: vi.fn(async () => ({ id: 42, url: 'https://example.test' })), onRemoved: { addListener: vi.fn() } },
  })
}

describe('frame-aware DOM tools', () => {
  beforeEach(() => {
    vi.resetModules()
    installChromeMock()
  })

  it('lists the frame tree with stable frame IDs', async () => {
    await import('../tools/dom.js')
    const { dispatchTool } = await import('../tool-registry.js')

    const result = await dispatchTool('frames_list', 42, {})
    const content = result.content[0]
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') return
    expect(JSON.parse(content.text)).toEqual([
      { frameId: 'root', parentFrameId: null, name: '', url: 'https://example.test' },
      { frameId: 'child-1', parentFrameId: 'root', name: 'editor', url: 'https://example.test/frame' },
    ])
  })

  it('explains an evaluation timeout and points to a wait step, leaving other timeouts generic', async () => {
    vi.useFakeTimers()
    try {
      type Send = (target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) => Promise<unknown>
      const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn<Send>>
      const original = send.getMockImplementation()!
      send.mockImplementation((target: chrome.debugger.Debuggee, method: string, params: Record<string, unknown>) =>
        method === 'Runtime.evaluate' || method === 'Page.getFrameTree' ? new Promise(() => {}) : original(target, method, params))
      await import('../tools/dom.js')
      const { dispatchTool } = await import('../tool-registry.js')
      const evaluating = dispatchTool('javascript_tool', 42, { code: 'new Promise(r => setTimeout(r, 10000))', awaitPromise: true })
      const outcome = expect(evaluating).rejects.toThrow(
        "evaluate got no result within 5000ms: the expression awaited too long or the page's main thread was busy. Instead of a timer, use a wait step for the text or ref state you expect, then evaluate a shorter expression.",
      )
      await vi.advanceTimersByTimeAsync(5000)
      await outcome
      const listing = expect(dispatchTool('frames_list', 42, {})).rejects.toThrow(/CDP command "Page.getFrameTree" timed out for tab 42 after 5000ms/)
      await vi.advanceTimersByTimeAsync(5000)
      await listing
    } finally {
      vi.useRealTimers()
    }
  })

  it('evaluates JavaScript in the requested frame context', async () => {
    await import('../tools/dom.js')
    const { dispatchTool } = await import('../tool-registry.js')

    await dispatchTool('javascript_tool', 42, {
      code: 'document.body.innerText',
      frameId: 'child-1',
      awaitPromise: true,
    })

    expect(commands).toContainEqual({
      method: 'Page.createIsolatedWorld',
      params: {
        frameId: 'child-1',
        worldName: 'bro',
        grantUniveralAccess: false,
      },
    })
    expect(commands).toContainEqual({
      method: 'Runtime.evaluate',
      params: expect.objectContaining({ contextId: 99, awaitPromise: true }),
    })
  })
})
