import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTool } from '../tool-registry.js'
import '../tools/extensions.js'

const getAllFrames = vi.fn()
beforeEach(() => {
  getAllFrames.mockReset()
  vi.stubGlobal('chrome', {
    runtime: { id: 'b'.repeat(32) },
    webNavigation: { getAllFrames },
  })
})

async function diagnose() {
  const result = await dispatchTool('debugger_diagnose', 42, {})
  const item = result.content[0]
  if (item?.type !== 'text') throw new Error('Expected JSON text')
  return JSON.parse(item.text)
}

describe('non-CDP extension diagnostics', () => {
  it('reports only origins, never frame paths, credentials or query strings', async () => {
    getAllFrames.mockResolvedValue([
      { frameId: 0, parentFrameId: -1, url: 'https://user:pass@example.com/private?token=secret', errorOccurred: false, processId: 1 },
      { frameId: 1, parentFrameId: 0, url: `chrome-extension://${'a'.repeat(32)}/private.html?secret=123`, errorOccurred: false, processId: 2 },
    ])
    const value = await diagnose()
    expect(value.frames[0].origin).toBe('https://example.com')
    expect(value.frames[1].foreignExtension).toBe(true)
    expect(JSON.stringify(value)).not.toMatch(/private|secret|user|pass/)
    expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledWith({ tabId: 42 })
  })

  it('does not present empty inventory as proof that no extension frame exists', async () => {
    getAllFrames.mockResolvedValue([])
    expect(await diagnose()).toMatchObject({ completeness: 'not-guaranteed', frames: [] })
    expect((await diagnose()).warning).toContain('inconclusive')
  })

  it('requires explicit profile-wide confirmation before accessing management', async () => {
    await expect(dispatchTool('extensions_pause', 0, { extensionId: 'a'.repeat(32) }))
      .rejects.toThrow('confirmProfileWide')
  })
})
