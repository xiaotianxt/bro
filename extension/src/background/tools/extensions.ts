import { registerTool } from '../tool-registry.js'
import { extensionStatus, pauseExtension, resumeExtension } from '../extension-pause.js'

function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an argument object')
  return value as Record<string, unknown>
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

// Deliberately independent of chrome.debugger: usable when attach is rejected.
registerTool('debugger_diagnose', async (tabId) => {
  const frames = await chrome.webNavigation.getAllFrames({ tabId })
  if (frames === null) throw new Error('Frame inventory unavailable; this does not mean there are no extension frames')
  return result({ tabId, source: 'webNavigation', completeness: 'not-guaranteed',
    warning: frames.length === 0
      ? 'Browser returned no frame inventory. This is inconclusive, not evidence that no foreign extension iframe exists.'
      : 'Browser may omit protected frames. Absence of a foreign extension here does not rule out attach blockers.',
    frames: frames.map(frame => {
    let origin = 'opaque'
    let extensionId: string | undefined
    try {
      const url = new URL(frame.url)
      origin = url.protocol === 'chrome-extension:' ? `${url.protocol}//${url.hostname}` : url.origin
      if (url.protocol === 'chrome-extension:') extensionId = url.hostname
    } catch { /* Invalid/opaque URL; never expose paths, query strings or data URLs. */ }
    return { frameId: frame.frameId, parentFrameId: frame.parentFrameId, origin,
      extensionId, foreignExtension: extensionId !== undefined && extensionId !== chrome.runtime.id }
  }) })
})

registerTool('extensions_status', async () => result(await extensionStatus()))
registerTool('extensions_pause', async (_tabId, input) => {
  const args = objectArgs(input)
  if (args['confirmProfileWide'] !== true) throw new Error('Explicit confirmProfileWide: true required; pause affects every tab in this profile')
  if (typeof args['extensionId'] !== 'string') throw new Error('extensionId is required')
  const duration = args['durationSeconds'] ?? 300
  if (typeof duration !== 'number') throw new Error('durationSeconds must be a number')
  return result({ scope: 'profile', pause: await pauseExtension(args['extensionId'], duration),
    warning: 'No pages were refreshed. Resume after your task; automatic restoration may require user interaction. Use chrome://extensions if restoration fails.' })
})
registerTool('extensions_resume', async (_tabId, input) => {
  const args = objectArgs(input)
  if (typeof args['resumeToken'] !== 'string') throw new Error('resumeToken is required; inspect extensions_status for recovery')
  const outcome = await resumeExtension(args['resumeToken'])
  return result({ outcome })
})
