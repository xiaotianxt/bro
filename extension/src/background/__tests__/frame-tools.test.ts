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
    tabs: { get: vi.fn(async () => ({ id: 42, url: 'https://example.test' })) },
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
