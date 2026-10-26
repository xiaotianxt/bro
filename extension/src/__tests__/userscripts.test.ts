import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInlineUserScript,
  listUserScripts,
  registerUserScripts,
  restoreUserScripts,
  setUserScriptEnabled,
  unregisterUserScripts,
  updateUserScripts,
} from '../userscripts.js'

const api = {
  getScripts: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  update: vi.fn(),
}

let localStorage: Record<string, unknown>
const storage = {
  get: vi.fn(async (defaults: Record<string, unknown>) => ({
    ...defaults,
    ...localStorage,
  })),
  set: vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(localStorage, values)
  }),
  setAccessLevel: vi.fn(async () => {}),
}

describe('user scripts', () => {
  beforeEach(() => {
    localStorage = {}
    vi.stubGlobal('chrome', { userScripts: api, storage: { local: storage } })
    api.getScripts.mockReset().mockResolvedValue([])
    api.register.mockReset().mockResolvedValue(undefined)
    api.unregister.mockReset().mockResolvedValue(undefined)
    api.update.mockReset().mockResolvedValue(undefined)
    storage.get.mockClear()
    storage.set.mockClear()
    storage.setAccessLevel.mockClear()
  })

  it('does not require user-script permission when there is nothing to restore', async () => {
    vi.stubGlobal('chrome', { storage: { local: storage } })
    await expect(restoreUserScripts()).resolves.toBeUndefined()
    localStorage = { registeredUserScripts: [{ id: 'saved' }] }
    await expect(restoreUserScripts()).rejects.toThrow('Allow User Scripts')
  })

  it('keeps disabled definitions visible without restoring or injecting them', async () => {
    const script = { id: 'paused', enabled: false, js: [{ code: 'void 0' }] }
    localStorage = { registeredUserScripts: [script] }
    await restoreUserScripts()
    expect(api.register).not.toHaveBeenCalled()
    await expect(listUserScripts()).resolves.toEqual([script])
    await expect(listUserScripts(['other'])).resolves.toEqual([])
    await updateUserScripts([{ id: 'paused', js: [{ code: 'void 1' }] }])
    expect(api.update).not.toHaveBeenCalled()
    expect(localStorage['registeredUserScripts']).toEqual([
      { ...script, js: [{ code: 'void 1' }] },
    ])
    await expect(registerUserScripts([{ id: 'paused' }])).rejects.toThrow('already exists')
    await unregisterUserScripts(['paused'])
    expect(localStorage['registeredUserScripts']).toEqual([])
  })

  it('toggles registration while preserving source and excluding management metadata', async () => {
    const script = { id: 'toggle', description: 'test', js: [{ code: 'void 0' }] }
    localStorage = { registeredUserScripts: [script] }
    api.getScripts.mockResolvedValue([{ id: script.id, js: script.js }])
    await setUserScriptEnabled(script.id, false)
    expect(api.unregister).toHaveBeenCalledWith({ ids: [script.id] })
    expect(localStorage['registeredUserScripts']).toEqual([{ ...script, enabled: false }])
    api.getScripts.mockResolvedValue([])
    await setUserScriptEnabled(script.id, true)
    expect(api.register).toHaveBeenCalledWith([{ id: script.id, js: script.js }])
    expect(localStorage['registeredUserScripts']).toEqual([{ ...script, enabled: true }])
  })

  it('reconciles a disabled script left registered and preserves state on toggle failure', async () => {
    const script = { id: 'paused', enabled: false, js: [{ code: 'void 0' }] }
    localStorage = { registeredUserScripts: [script] }
    api.getScripts.mockResolvedValue([{ id: script.id, js: script.js }])
    await restoreUserScripts()
    expect(api.unregister).toHaveBeenCalledWith({ ids: [script.id] })
    api.getScripts.mockResolvedValue([])
    api.register.mockRejectedValue(new Error('Permission denied'))
    await expect(setUserScriptEnabled(script.id, true)).rejects.toThrow('Permission denied')
    expect(localStorage['registeredUserScripts']).toEqual([script])
  })

  it('builds a validated inline script from form values', () => {
    expect(createInlineUserScript({
      id: '  dismiss-cookie-banner  ',
      description: '  关闭示例站点的 Cookie 弹窗  ',
      matches: [' https://example.com/* ', ''],
      excludeMatches: [' https://example.com/account/* '],
      code: '  document.querySelector("dialog")?.remove()  ',
      runAt: 'document_idle',
      world: 'USER_SCRIPT',
      allFrames: false,
    })).toEqual({
      id: 'dismiss-cookie-banner',
      description: '关闭示例站点的 Cookie 弹窗',
      matches: ['https://example.com/*'],
      excludeMatches: ['https://example.com/account/*'],
      js: [{ code: 'document.querySelector("dialog")?.remove()' }],
      runAt: 'document_idle',
      world: 'USER_SCRIPT',
      allFrames: false,
    })
    expect(() => createInlineUserScript({
      id: 'empty',
      description: '空脚本',
      matches: ['https://example.com/*'],
      excludeMatches: [],
      code: '',
      runAt: 'document_idle',
      world: 'USER_SCRIPT',
      allFrames: false,
    })).toThrow('JavaScript code is required')
  })

  it('delegates lifecycle operations to chrome.userScripts', async () => {
    const script = createInlineUserScript({
      id: 'probe',
      description: '验证脚本生命周期',
      matches: ['https://example.com/*'],
      excludeMatches: [],
      code: 'void 0',
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    })
    const { description, ...registered } = script
    void description
    api.getScripts.mockResolvedValue([registered])

    await expect(listUserScripts(['probe'])).resolves.toEqual([registered])
    await registerUserScripts([script])
    await updateUserScripts([script])
    await unregisterUserScripts(['probe'])

    expect(api.getScripts).toHaveBeenCalledWith({ ids: ['probe'] })
    expect(api.register).toHaveBeenCalledWith([registered])
    expect(api.update).toHaveBeenCalledWith([registered])
    expect(api.unregister).toHaveBeenCalledWith({ ids: ['probe'] })
  })

  it('persists scripts and restores them after an extension update', async () => {
    const script = createInlineUserScript({
      id: 'persistent-probe',
      description: '扩展更新后仍需恢复的脚本',
      matches: ['https://example.com/*'],
      excludeMatches: [],
      code: 'void 0',
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false,
    })
    api.getScripts.mockResolvedValue([])

    await registerUserScripts([script])
    expect(localStorage['registeredUserScripts']).toEqual([script])

    const { description, ...registered } = script
    void description
    await updateUserScripts([{ ...registered, runAt: 'document_end' }])
    expect(localStorage['registeredUserScripts']).toEqual([
      { ...registered, description: script.description, runAt: 'document_end' },
    ])

    api.getScripts.mockResolvedValue([{ ...registered, runAt: 'document_end' }])
    await expect(listUserScripts(['persistent-probe'])).resolves.toEqual([
      { ...registered, description: script.description, runAt: 'document_end' },
    ])

    api.getScripts.mockResolvedValue([])
    api.register.mockClear()
    await restoreUserScripts()

    expect(storage.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_CONTEXTS',
    })
    expect(api.register).toHaveBeenCalledWith([
      { ...registered, runAt: 'document_end' },
    ])
  })
})
