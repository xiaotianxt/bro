import { beforeEach, describe, expect, it, vi } from 'vitest'

const { navigation, ReadinessTimeout, keepRendering } = vi.hoisted(() => ({
  navigation: vi.fn(),
  ReadinessTimeout: class ReadinessTimeout extends Error {},
  keepRendering: vi.fn(),
}))
vi.mock('../navigation.js', () => ({ navigateDocument: navigation, ReadinessTimeout }))
vi.mock('../render-pump.js', () => ({ keepRendering }))

const openTabs = vi.fn()

beforeEach(() => {
  vi.resetModules()
  openTabs.mockReset().mockResolvedValue([{ id: 1, windowId: 7 }, { id: 42, windowId: 7 }])
  navigation.mockReset()
  keepRendering.mockReset()
  vi.stubGlobal('chrome', { tabs: {
    create: vi.fn(async () => ({ id: 42, windowId: 7, url: 'about:blank' })),
    remove: vi.fn(async () => {}),
    query: openTabs,
    update: vi.fn(async () => ({ id: 42 })),
    get: vi.fn(async (id: number) => ({ id, windowId: 7, url: 'https://closing.test' })),
  } })
})

describe('new tab readiness', () => {
  it('does not acknowledge a created tab until intended navigation is ready', async () => {
    let ready!: (url: string) => void
    navigation.mockImplementation(() => new Promise<string>((resolve) => { ready = resolve }))
    await import('../tools/tabs.js')
    const { dispatchTool } = await import('../tool-registry.js')
    let acknowledged = false
    const pending = dispatchTool('tabs_create', 0, { url: 'https://intended.test' }).then((result) => { acknowledged = true; return result })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'about:blank', active: false })
    expect(navigation).toHaveBeenCalledWith(42, 'https://intended.test')
    expect(keepRendering).toHaveBeenCalledWith(42)
    expect(acknowledged).toBe(false)
    ready('https://redirect.test')
    expect((await pending).content).toEqual([{ type: 'text', text: 'Created tab: 42 (window 7)' }])
  })

  it('closes the acquired tab when readiness fails, before returning failure', async () => {
    navigation.mockRejectedValue(new Error('readiness unmet'))
    await import('../tools/tabs.js')
    const { dispatchTool } = await import('../tool-registry.js')
    await expect(dispatchTool('tabs_create', 0, { url: 'https://slow.test' })).rejects.toThrow('readiness unmet')
    expect(chrome.tabs.remove).toHaveBeenCalledWith(42)
  })

  it('keeps an opted-in tab whose navigation only timed out and says it is not ready', async () => {
    navigation.mockRejectedValue(new ReadinessTimeout('Navigation did not reach DOMContentLoaded within 10000ms'))
    await import('../tools/tabs.js')
    const { dispatchTool } = await import('../tool-registry.js')
    const result = await dispatchTool('tabs_create', 0, { url: 'https://slow.test', allowNotReady: true })
    expect(result.content).toEqual([{ type: 'text', text: 'Created tab: 42 (window 7)\nNot ready: Navigation did not reach DOMContentLoaded within 10000ms' }])
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })

  it('still closes the tab for timeouts without opt-in and for other failures with it', async () => {
    await import('../tools/tabs.js')
    const { dispatchTool } = await import('../tool-registry.js')
    navigation.mockRejectedValueOnce(new ReadinessTimeout('timed out'))
    await expect(dispatchTool('tabs_create', 0, { url: 'https://slow.test' })).rejects.toThrow('timed out')
    navigation.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'))
    await expect(dispatchTool('tabs_create', 0, { url: 'https://bad.test', allowNotReady: true })).rejects.toThrow('ERR_NAME')
    expect(chrome.tabs.remove).toHaveBeenCalledTimes(2)
  })

  it('defers readiness when asked: dispatches the navigation and returns without waiting', async () => {
    await import('../tools/tabs.js')
    const { dispatchTool } = await import('../tool-registry.js')
    const result = await dispatchTool('tabs_create', 0, { url: 'https://slow.test', deferReadiness: true })
    expect(result.content).toEqual([{ type: 'text', text: 'Created tab: 42 (window 7)' }])
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'about:blank', active: false })
    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { url: 'https://slow.test' })
    expect(navigation).not.toHaveBeenCalled()
    await expect(
      dispatchTool('tabs_create', 0, { url: 'https://slow.test', deferReadiness: true, allowNotReady: true }),
    ).rejects.toThrow('exclusive')
  })
})

describe('tab removal', () => {
  it('leaves a New Tab page when closing the last tab, so Chrome keeps the profile and this worker loaded', async () => {
    await import('../tools/tabs.js')
    const { dispatchTool } = await import('../tool-registry.js')
    openTabs.mockResolvedValue([{ id: 42, windowId: 7 }])
    await dispatchTool('tabs_close', 0, { tabId: 42 })
    expect(chrome.tabs.create).toHaveBeenCalledWith({ windowId: 7, active: false })
    expect(vi.mocked(chrome.tabs.create).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(chrome.tabs.remove).mock.invocationCallOrder[0]!)
    expect(chrome.tabs.remove).toHaveBeenCalledWith(42)
  })

  it('closes a tab directly while another tab keeps a window open', async () => {
    await import('../tools/tabs.js')
    const { dispatchTool } = await import('../tool-registry.js')
    await dispatchTool('tabs_close', 0, { tabId: 42 })
    expect(chrome.tabs.create).not.toHaveBeenCalled()
    expect(chrome.tabs.remove).toHaveBeenCalledWith(42)
  })
})
