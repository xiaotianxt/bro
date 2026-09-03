import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInlineUserScript,
  listUserScripts,
  registerUserScripts,
  restoreUserScripts,
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
