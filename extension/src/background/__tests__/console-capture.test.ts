import { beforeEach, describe, expect, it, vi } from 'vitest'

let emitDebuggerEvent: (
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
) => void

function installChromeMock(): void {
  vi.stubGlobal('chrome', {
    runtime: { id: 'bro-extension', lastError: undefined },
    debugger: {
      attach: vi.fn((_target, _version, callback) => callback()),
      detach: vi.fn((_target, callback) => callback()),
      sendCommand: vi.fn(
        (
          _target: chrome.debugger.Debuggee,
          method: string,
          _params: Record<string, unknown>,
        ) => {
          if (method === 'Runtime.evaluate') {
            emitDebuggerEvent(
              { tabId: 42 },
              'Runtime.consoleAPICalled',
              {
                type: 'error',
                args: [{ type: 'string', value: 'LUNA_ASYNC_CONSOLE' }],
                timestamp: 1,
              },
            )
            return Promise.resolve({ result: { value: { result: 'true', isError: false } } })
          }
          return Promise.resolve({})
        },
      ),
      onEvent: {
        addListener: vi.fn((listener) => {
          emitDebuggerEvent = listener
        }),
      },
      onDetach: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async () => ({ id: 42, url: 'https://example.test' })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  })
}

describe('capture_console', () => {
  beforeEach(() => {
    vi.resetModules()
    installChromeMock()
  })

  it('owns monitoring, trigger execution, collection, and cleanup in one call', async () => {
    await import('../tools/monitoring.js')
    const { dispatchTool } = await import('../tool-registry.js')

    const result = await dispatchTool('capture_console', 42, {
      code: "document.querySelector('#trigger').click()",
      timeoutMs: 2_000,
    })
    const content = result.content[0]
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') return

    expect(JSON.parse(content.text)).toEqual({
      triggerResult: 'true',
      matchedMessages: 1,
      timedOut: false,
      messages: [{ level: 'error', text: 'LUNA_ASYNC_CONSOLE', timestamp: 1 }],
    })
  })
})
