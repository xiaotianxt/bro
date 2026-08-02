import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({
  loadServerUrl: vi.fn<() => Promise<string>>(),
  loadToken: vi.fn<() => Promise<string>>(),
  restrictLocalStorageAccess: vi.fn<() => Promise<void>>(),
}))

vi.mock('../../settings.js', () => ({
  loadServerUrl: settings.loadServerUrl,
  loadToken: settings.loadToken,
  normalizeServerUrl: (value: string) => value,
  restrictLocalStorageAccess: settings.restrictLocalStorageAccess,
}))

import { ALARM_KEEPALIVE, BridgeClient } from '../bridge-client.js'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  closed = false
  onopen: (() => void | Promise<void>) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.closed = true
  }

  async open(): Promise<void> {
    await this.onopen?.()
  }

  message(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, reject, resolve }
}

describe('BridgeClient connection state', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    settings.loadServerUrl.mockReset().mockResolvedValue('ws://127.0.0.1:3500/ws')
    settings.loadToken.mockReset().mockResolvedValue('token')
    settings.restrictLocalStorageAccess.mockReset().mockResolvedValue()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('navigator', { userAgent: 'Chromium' })
    vi.stubGlobal('chrome', {
      alarms: { create: vi.fn(), clear: vi.fn() },
      tabs: { query: vi.fn().mockResolvedValue([{ url: 'https://example.test' }]) },
      runtime: {
        id: 'extension-id',
        lastError: undefined,
        getManifest: () => ({ version: '0.2.5' }),
        reload: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn((defaults: object, callback: (items: object) => void) => {
            callback({ ...defaults, instance_id: 'browser-id' })
          }),
          set: vi.fn((_items: object, callback: () => void) => callback()),
        },
      },
    })
  })

  it('becomes connected only after the authenticated acknowledgement', async () => {
    const client = new BridgeClient()
    await client.connect()
    const socket = FakeWebSocket.instances[0]!

    await socket.open()
    expect(client.isConnected).toBe(false)

    socket.message({ type: 'connected', sessionId: 'session' })
    expect(client.isConnected).toBe(true)
  })

  it('ignores a stale socket close after replacement', async () => {
    const client = new BridgeClient()
    await client.connect()
    const first = FakeWebSocket.instances[0]!
    await first.open()
    first.message({ type: 'connected', sessionId: 'first' })
    const staleClose = first.onclose!

    client.disconnect()
    await client.connect()
    const second = FakeWebSocket.instances[1]!
    await second.open()
    second.message({ type: 'connected', sessionId: 'second' })

    staleClose()
    expect(client.isConnected).toBe(true)
  })

  it('does not let an older async connect replace a newer attempt', async () => {
    const firstUrl = deferred<string>()
    settings.loadServerUrl
      .mockReset()
      .mockReturnValueOnce(firstUrl.promise)
      .mockResolvedValueOnce('ws://localhost:3500/ws')
    const client = new BridgeClient()

    const firstConnect = client.connect()
    await vi.waitFor(() => expect(settings.loadServerUrl).toHaveBeenCalledTimes(1))
    client.disconnect()
    await client.connect()
    firstUrl.resolve('ws://127.0.0.1:3500/ws')
    await firstConnect

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://localhost:3500/ws')
  })

  it('does not create a socket when local storage cannot be restricted', async () => {
    const restriction = deferred<void>()
    settings.restrictLocalStorageAccess.mockReturnValue(restriction.promise)
    const client = new BridgeClient()

    const connection = client.connect()
    await client.onAlarm(ALARM_KEEPALIVE)
    expect(FakeWebSocket.instances).toHaveLength(0)

    restriction.reject(new Error('unsupported'))
    await expect(connection).rejects.toThrow('unsupported')
    await client.onAlarm(ALARM_KEEPALIVE)

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(settings.loadServerUrl).not.toHaveBeenCalled()
  })

  it('keeps an existing socket current when connect is called again', async () => {
    const client = new BridgeClient()
    await client.connect()
    const socket = FakeWebSocket.instances[0]!

    await client.connect()
    await socket.open()
    socket.message({ type: 'connected', sessionId: 'session' })

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(client.isConnected).toBe(true)
  })
})
