import { beforeEach, describe, expect, it, vi } from 'vitest'

let emitDebuggerEvent: (
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
) => void
let triggerFails = false

function installChromeMock(): void {
  const sendCommand = vi.fn(
    (
      _target: chrome.debugger.Debuggee,
      method: string,
      _params: object,
    ) => {
      if (method === 'Runtime.evaluate') {
        if (triggerFails) {
          return Promise.resolve({
            result: { value: { result: 'trigger failed', isError: true } },
          })
        }
        emitDebuggerEvent(
          { tabId: 42 },
          'Network.requestWillBeSent',
          {
            requestId: 'request-1',
            timestamp: 1,
            request: {
              method: 'GET',
              url: 'https://httpbin.org/anything?bro=benchmark',
              headers: {},
            },
          },
        )
        emitDebuggerEvent(
          { tabId: 42 },
          'Network.responseReceived',
          {
            requestId: 'request-1',
            response: {
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': 'application/json' },
              mimeType: 'application/json',
              protocol: 'h2',
              remoteIPAddress: '127.0.0.1',
              remotePort: 443,
              fromDiskCache: false,
              fromServiceWorker: false,
              encodedDataLength: 0,
              timing: {},
            },
          },
        )
        emitDebuggerEvent(
          { tabId: 42 },
          'Network.loadingFinished',
          { requestId: 'request-1', encodedDataLength: 41 },
        )
        return Promise.resolve({ result: { value: { result: '"done"', isError: false } } })
      }
      if (method === 'Network.getResponseBody') {
        return Promise.resolve({
          body: '{"args":{"bro":"benchmark"}}',
          base64Encoded: false,
        })
      }
      return Promise.resolve({})
    },
  )

  vi.stubGlobal('chrome', {
    runtime: { id: 'bro-extension', lastError: undefined },
    debugger: {
      attach: vi.fn((_target, _version, callback) => callback()),
      detach: vi.fn((_target, callback) => callback()),
      sendCommand,
      onEvent: {
        addListener: vi.fn((listener) => {
          emitDebuggerEvent = listener
        }),
      },
      onDetach: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async () => ({ id: 42, url: 'https://httpbin.org/html' })),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  })
}

describe('capture_network', () => {
  beforeEach(() => {
    vi.resetModules()
    triggerFails = false
    installChromeMock()
  })

  it('captures a triggered request and its response body in one tool call', async () => {
    await import('../tools/monitoring.js')
    const { dispatchTool } = await import('../tool-registry.js')

    const result = await dispatchTool('capture_network', 42, {
      code: "fetch('/anything?bro=benchmark')",
      urlIncludes: '/anything?bro=benchmark',
      includeResponseBodies: true,
    })
    const content = result.content[0]
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') return

    expect(JSON.parse(content.text)).toEqual({
      triggerResult: '"done"',
      matchedRequests: 1,
      timedOut: false,
      requests: [
        {
          requestId: 'request-1',
          method: 'GET',
          url: 'https://httpbin.org/anything?bro=benchmark',
          status: 200,
          mimeType: 'application/json',
          encodedDataLength: 41,
          body: '{"args":{"bro":"benchmark"}}',
          base64Encoded: false,
          truncated: false,
        },
      ],
    })
  })

  it('fails the tool when the trigger expression fails', async () => {
    triggerFails = true
    await import('../tools/monitoring.js')
    const { dispatchTool } = await import('../tool-registry.js')

    await expect(
      dispatchTool('capture_network', 42, { code: 'missingFunction()' }),
    ).rejects.toThrow('trigger failed')
  })
})
