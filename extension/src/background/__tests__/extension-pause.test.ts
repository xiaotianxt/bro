import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extensionStatus, pauseExtension, recoverPause, resumeExtension } from '../extension-pause.js'

const target = 'a'.repeat(32)
let stored: Record<string, unknown>
let enabled: boolean
let setEnabled: ReturnType<typeof vi.fn>
let createAlarm: ReturnType<typeof vi.fn>
let getAll: ReturnType<typeof vi.fn>

beforeEach(() => {
  stored = {}
  enabled = true
  setEnabled = vi.fn(async (_id: string, value: boolean) => { enabled = value })
  createAlarm = vi.fn(async () => undefined)
  getAll = vi.fn(async () => [{ id: target, name: 'Test extension', type: 'extension', enabled, mayDisable: true }])
  vi.stubGlobal('chrome', {
    runtime: { id: 'b'.repeat(32) },
    storage: { local: {
      get: vi.fn(async () => ({ ...stored })),
      set: vi.fn(async (value) => { Object.assign(stored, value) }),
      remove: vi.fn(async (key: string) => { delete stored[key] }),
    } },
    management: {
      get: vi.fn(async () => ({ id: target, name: 'Test extension', type: 'extension', enabled, mayDisable: true })),
      getAll,
      setEnabled,
    },
    alarms: { create: createAlarm, clear: vi.fn(async () => true) },
    action: { setBadgeText: vi.fn(async () => undefined), setTitle: vi.fn(async () => undefined) },
  })
})

describe('explicit extension pause', () => {
  it('journals and schedules recovery before disabling, then verifies restoration', async () => {
    setEnabled.mockImplementation(async (_id: string, value: boolean) => {
      expect(stored['extensionPause']).toBeDefined()
      expect(createAlarm).toHaveBeenCalled()
      enabled = value
    })
    const pause = await pauseExtension(target, 60)
    expect(enabled).toBe(false)
    await resumeExtension(pause.resumeToken)
    expect(enabled).toBe(true)
    expect(stored['extensionPause']).toBeUndefined()
  })

  it('rejects overlapping owners and wrong ownership tokens', async () => {
    const pause = await pauseExtension(target, 60)
    await expect(pauseExtension(target, 60)).rejects.toThrow('outstanding')
    await expect(resumeExtension('wrong')).rejects.toThrow('ownership')
    expect(enabled).toBe(false)
    await resumeExtension(pause.resumeToken)
  })

  it('never enables an extension that was disabled before the request', async () => {
    enabled = false
    await expect(pauseExtension(target, 60)).rejects.toThrow('enabled')
    expect(setEnabled).not.toHaveBeenCalled()
    expect(stored['extensionPause']).toBeUndefined()
  })

  it('restores on wake after an expired deadline without extending it', async () => {
    const pause = await pauseExtension(target, 60)
    stored['extensionPause'] = { ...pause, restoreAt: Date.now() - 1 }
    await recoverPause()
    expect(enabled).toBe(true)
    expect(stored['extensionPause']).toBeUndefined()
  })

  it('retains recovery state when the browser rejects re-enable', async () => {
    const pause = await pauseExtension(target, 60)
    setEnabled.mockRejectedValue(new Error('User gesture required'))
    await expect(resumeExtension(pause.resumeToken)).rejects.toThrow('chrome://extensions')
    expect(stored['extensionPause']).toMatchObject({ error: 'User gesture required' })
    expect(await extensionStatus()).toMatchObject({ pause: { resumeToken: pause.resumeToken } })
    enabled = true // user restores through the browser UI
    await resumeExtension(pause.resumeToken)
    expect(stored['extensionPause']).toBeUndefined()
  })

  it('does not disable when the recovery alarm cannot be created', async () => {
    createAlarm.mockRejectedValue(new Error('Alarm unavailable'))
    await expect(pauseExtension(target, 60)).rejects.toThrow('Alarm unavailable')
    expect(setEnabled).not.toHaveBeenCalled()
    expect(enabled).toBe(true)
  })

  it('rolls back even if disable mutated state before returning an error', async () => {
    setEnabled.mockImplementation(async (_id: string, value: boolean) => {
      enabled = value
      if (!value) throw new Error('Interrupted')
    })
    await expect(pauseExtension(target, 60)).rejects.toThrow('Interrupted')
    expect(enabled).toBe(true)
    expect(stored['extensionPause']).toBeUndefined()
  })

  it('clears a confirmed uninstalled target without reporting it enabled', async () => {
    const pause = await pauseExtension(target, 60)
    getAll.mockResolvedValue([])
    expect(await resumeExtension(pause.resumeToken)).toBe('uninstalled')
    expect(stored['extensionPause']).toBeUndefined()
  })

  it('rejects self-pause and out-of-range deadlines', async () => {
    await expect(pauseExtension('b'.repeat(32), 60)).rejects.toThrow('itself')
    await expect(pauseExtension(target, 901)).rejects.toThrow('900')
    expect(setEnabled).not.toHaveBeenCalled()
  })
})
