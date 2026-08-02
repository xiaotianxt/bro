import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  loadToken,
  normalizeServerUrl,
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
})
