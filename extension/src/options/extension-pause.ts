import type { PauseRecord } from '../background/extension-pause.js'

interface Status {
  pause: PauseRecord | null
  extensions: { id: string; name: string; enabled: boolean; mayDisable: boolean }[]
}
const select = document.getElementById('pause-extension') as HTMLSelectElement
const pause = document.getElementById('pause-extension-btn') as HTMLButtonElement
const resume = document.getElementById('resume-extension-btn') as HTMLButtonElement
const refresh = document.getElementById('refresh-extensions-btn') as HTMLButtonElement
const message = document.getElementById('pause-status') as HTMLParagraphElement
let current: PauseRecord | null = null
let busy = false

async function call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = await chrome.runtime.sendMessage({ type: 'EXTENSION_CONTROL', tool, args })
  if (!response || response.error) throw new Error(response?.error ?? 'Background worker did not respond')
  return JSON.parse(response.result.content[0].text)
}

async function load(): Promise<void> {
  const status = await call('extensions_status') as Status
  current = status.pause
  select.replaceChildren()
  const placeholder = new Option('Choose an extension', '')
  select.add(placeholder)
  for (const info of status.extensions) {
    if (info.enabled && info.mayDisable) select.add(new Option(info.name, info.id))
  }
  select.disabled = current !== null
  pause.disabled = true
  resume.hidden = current === null
  message.className = current?.error ? 'manager-status error' : 'manager-status'
  message.textContent = current
    ? `${current.name} has an outstanding pause. Restore scheduled for ${new Date(current.restoreAt).toLocaleTimeString()}.${current.error ? ` Restoration failed: ${current.error}. Enable it in your browser’s extension manager, then click Restore extension now.` : ''}`
    : 'No extensions paused by bro.'
}

async function run(action: () => Promise<unknown>): Promise<void> {
  if (busy) return
  busy = true
  pause.disabled = resume.disabled = refresh.disabled = select.disabled = true
  try {
    await action()
    await load()
  } catch (error) {
    // Reload recovery state even when pause/restore failed; it may have changed.
    try { await load() } catch { /* Preserve the original actionable failure. */ }
    message.className = 'manager-status error'
    message.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    busy = false
    resume.disabled = refresh.disabled = false
    select.disabled = current !== null
    pause.disabled = current !== null || !select.value
  }
}

select.addEventListener('change', () => { pause.disabled = !select.value || current !== null })
pause.addEventListener('click', () => {
  const extensionId = select.value
  if (extensionId) void run(() => call('extensions_pause', { extensionId, confirmProfileWide: true }))
})
resume.addEventListener('click', () => {
  const resumeToken = current?.resumeToken
  if (resumeToken) void run(() => call('extensions_resume', { resumeToken }))
})
refresh.addEventListener('click', () => { void run(async () => undefined) })
// Reflect alarm restoration and failures without polling or refreshing the tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['extensionPause']) void run(async () => undefined)
})
void run(async () => undefined)
