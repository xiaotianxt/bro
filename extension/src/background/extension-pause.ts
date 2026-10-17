// Profile-wide, explicit pause. Only one owner at a time: overlapping requests
// are rejected rather than allowing one agent to restore another agent's pause.
export const PAUSE_ALARM = 'bro-extension-pause'
const KEY = 'extensionPause'

export interface PauseRecord {
  extensionId: string
  name: string
  resumeToken: string
  restoreAt: number
  error?: string
}

let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run)
  queue = result.catch(() => undefined)
  return result
}

async function record(): Promise<PauseRecord | undefined> {
  const stored = await chrome.storage.local.get(KEY)
  return stored[KEY] as PauseRecord | undefined
}

async function indicate(paused: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: paused ? 'PAUSE' : '' })
  await chrome.action.setTitle({ title: paused
    ? 'bro — extension paused; use extensions_resume or chrome://extensions to restore'
    : 'bro' })
}

async function clear(): Promise<void> {
  await chrome.storage.local.remove(KEY)
  await chrome.alarms.clear(PAUSE_ALARM)
  await indicate(false)
}

async function installedTarget(id: string): Promise<chrome.management.ExtensionInfo | undefined> {
  return (await chrome.management.getAll()).find(info => info.id === id)
}

async function restore(current: PauseRecord): Promise<'enabled' | 'uninstalled'> {
  try {
    const info = await installedTarget(current.extensionId)
    if (!info) { await clear(); return 'uninstalled' }
    if (!info.enabled) await chrome.management.setEnabled(current.extensionId, true)
    if (!(await chrome.management.get(current.extensionId)).enabled) {
      throw new Error('Browser did not enable the extension')
    }
    await clear()
    return 'enabled'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await chrome.storage.local.set({ [KEY]: { ...current, error: message } })
    await indicate(true)
    throw new Error(`Restore failed for ${current.name}: ${message}. Enable it in chrome://extensions, then call extensions_resume to clear the record.`)
  }
}

export function pauseExtension(extensionId: string, durationSeconds: number): Promise<PauseRecord> {
  return serialized(async () => {
    if (!/^[a-p]{32}$/.test(extensionId) || extensionId === chrome.runtime.id) {
      throw new Error('Expected another extension ID; bro cannot pause itself')
    }
    if (!Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 900) {
      throw new Error('durationSeconds must be an integer between 30 and 900')
    }
    if (await record()) throw new Error('An extension pause is already outstanding; resume it first')
    const info = await chrome.management.get(extensionId)
    if (info.type !== 'extension' || !info.enabled || !info.mayDisable) {
      throw new Error('Target must be an enabled, user-disableable extension')
    }
    const current: PauseRecord = {
      extensionId, name: info.name, resumeToken: crypto.randomUUID(),
      restoreAt: Date.now() + durationSeconds * 1000,
    }
    // Journal and alarm must both exist BEFORE changing extension state.
    await chrome.storage.local.set({ [KEY]: current })
    try {
      await chrome.alarms.create(PAUSE_ALARM, { when: current.restoreAt })
      await indicate(true)
      await chrome.management.setEnabled(extensionId, false)
      if ((await chrome.management.get(extensionId)).enabled) {
        throw new Error('Browser did not disable the extension')
      }
    } catch (error) {
      // A rejected call may still have changed state. Restore and verify rather
      // than discarding the recovery journal based on the rejection alone.
      await restore(current)
      throw error
    }
    return current
  })
}

export function resumeExtension(resumeToken: string): Promise<'enabled' | 'uninstalled'> {
  return serialized(async () => {
    const current = await record()
    if (!current) throw new Error('No outstanding extension pause')
    if (current.resumeToken !== resumeToken) throw new Error('Pause ownership token does not match')
    return restore(current)
  })
}

export function extensionStatus(): Promise<unknown> {
  return serialized(async () => ({
    scope: 'profile', pause: (await record()) ?? null,
    extensions: (await chrome.management.getAll())
      .filter(info => info.type === 'extension' && info.id !== chrome.runtime.id)
      .map(info => ({ id: info.id, name: info.name, enabled: info.enabled, mayDisable: info.mayDisable })),
  }))
}

// Reconcile on every worker wake; alarms can be lost on browser restart.
// Never extend a deadline. A failed restore stays visible; no retry loop.
export function recoverPause(): Promise<void> {
  return serialized(async () => {
    const current = await record()
    if (!current) return
    await indicate(true)
    const info = await installedTarget(current.extensionId)
    if (!info || info.enabled) { await clear(); return }
    if (Date.now() >= current.restoreAt) { await restore(current); return }
    await chrome.alarms.create(PAUSE_ALARM, { when: current.restoreAt })
  })
}
