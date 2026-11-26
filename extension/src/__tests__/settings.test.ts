import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NATIVE_HOST,
  loadToken,
  normalizeServerUrl,
  pairToken,
  reloadIfUpdatedOnDisk,
  saveSettings,
} from '../settings.js'

function storageArea(values: Record<string, unknown>) {
  return {
    get: vi.fn(async (defaults: Record<string, unknown>) => ({ ...defaults, ...values })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, items)
    }),
    remove: vi.fn(async (key: string) => {
      delete values[key]
    }),
    setAccessLevel: vi.fn(async () => {}),
  }
}

describe('extension settings', () => {
  let localValues: Record<string, unknown>
  let syncValues: Record<string, unknown>

  beforeEach(() => {
    localValues = {}
    syncValues = {}
    vi.stubGlobal('chrome', {
      storage: {
        local: storageArea(localValues),
        sync: storageArea(syncValues),
      },
    })
  })

  it('accepts only loopback ws URLs', () => {
    expect(normalizeServerUrl('ws://localhost:3500/ws')).toBe('ws://localhost:3500/ws')
    expect(normalizeServerUrl('ws://127.0.0.1:3500/ws')).toBe('ws://127.0.0.1:3500/ws')
    expect(normalizeServerUrl('ws://[::1]:3500/ws')).toBe('ws://[::1]:3500/ws')
    expect(() => normalizeServerUrl('wss://localhost/ws')).toThrow('must use ws://')
    expect(() => normalizeServerUrl('ws://example.com/ws')).toThrow('must use ws://')
  })

  it('moves a legacy synced token to local storage', async () => {
    syncValues['token'] = 'legacy-token'

    await expect(loadToken()).resolves.toBe('legacy-token')

    expect(localValues['token']).toBe('legacy-token')
    expect(syncValues).not.toHaveProperty('token')
  })

  it('validates before saving and keeps the token out of sync storage', async () => {
    await expect(
      saveSettings('ws://example.com/ws', 'secret'),
    ).rejects.toThrow('must use ws://')
    expect(localValues).not.toHaveProperty('token')

    await saveSettings('ws://localhost:3500/ws', 'secret')

    expect(localValues['token']).toBe('secret')
    expect(syncValues).toEqual({ serverUrl: 'ws://localhost:3500/ws' })
  })

  it('pairs with the token bro\'s native host returns', async () => {
    const sendNativeMessage = vi.fn().mockResolvedValue({ version: '2.3.0', token: 'paired' })
    vi.stubGlobal('chrome', { runtime: { sendNativeMessage } })

    await expect(pairToken()).resolves.toBe('paired')
    expect(sendNativeMessage).toHaveBeenCalledWith(NATIVE_HOST, { type: 'pair' })
  })

  it('falls back to a typed token when pairing is unavailable', async () => {
    for (const sendNativeMessage of [
      vi.fn().mockRejectedValue(new Error('Specified native messaging host not found.')),
      vi.fn().mockResolvedValue({ version: '2.3.0', error: 'settings file is malformed' }),
    ]) {
      vi.stubGlobal('chrome', { runtime: { sendNativeMessage } })
      await expect(pairToken()).resolves.toBe('')
    }
  })

  describe('reloading into updated files', () => {
    function stub(onDisk: Promise<Response>) {
      const reload = vi.fn()
      vi.stubGlobal('fetch', vi.fn(() => onDisk))
      vi.stubGlobal('chrome', {
        runtime: { getURL: (path: string) => `chrome-extension://id/${path}`, getManifest: () => ({ version: '2.2.0' }), reload },
      })
      return reload
    }

    it('reloads when the folder holds another version', async () => {
      const reload = stub(Promise.resolve(new Response('{"version":"2.3.0"}')))
      await expect(reloadIfUpdatedOnDisk()).resolves.toBe(true)
      expect(reload).toHaveBeenCalledTimes(1)
    })

    it('stays when the version matches or the folder is gone', async () => {
      for (const onDisk of [
        Promise.resolve(new Response('{"version":"2.2.0"}')),
        Promise.reject(new TypeError('Failed to fetch')),
      ]) {
        const reload = stub(onDisk)
        await expect(reloadIfUpdatedOnDisk()).resolves.toBe(false)
        expect(reload).not.toHaveBeenCalled()
      }
    })
  })
})
