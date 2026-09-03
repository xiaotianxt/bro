import {
  DEFAULT_SERVER_URL,
  loadServerUrl,
  loadToken,
  saveSettings,
} from '../settings.js'
import {
  createInlineUserScript,
  listUserScripts,
  registerUserScripts,
  unregisterUserScripts,
  updateUserScripts,
} from '../userscripts.js'
import type { ManagedUserScript } from '../userscripts.js'

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing options element: ${id}`)
  return found as T
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const serverUrlInput = element<HTMLInputElement>('server-url')
const tokenInput = element<HTMLInputElement>('token')
const saveBtn = element<HTMLButtonElement>('save-btn')
const statusEl = element<HTMLDivElement>('status')
const statusTextEl = element<HTMLSpanElement>('status-text')
const connectionMessageEl = element<HTMLParagraphElement>('connection-message')

async function loadStoredSettings(): Promise<void> {
  try {
    const [serverUrl, token] = await Promise.all([loadServerUrl(), loadToken()])
    serverUrlInput.value = serverUrl
    tokenInput.value = token
  } catch (error) {
    console.warn('[Options] Failed to load settings:', error)
    serverUrlInput.value = DEFAULT_SERVER_URL
    setConnectionStatus(false, 'Settings unavailable')
    connectionMessageEl.textContent = errorMessage(error)
  }
}

function updateConnectionStatus(): void {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response: unknown) => {
    if (chrome.runtime.lastError) {
      setConnectionStatus(false)
      return
    }
    const connected =
      response !== null &&
      typeof response === 'object' &&
      'connected' in response &&
      (response as { connected: boolean }).connected === true
    setConnectionStatus(connected)
  })
}

function setConnectionStatus(connected: boolean, label?: string): void {
  statusEl.className = connected ? 'connected' : 'disconnected'
  statusTextEl.textContent = label ?? (connected ? 'Connected' : 'Disconnected')
}

function setConnecting(): void {
  statusEl.className = 'connecting'
  statusTextEl.textContent = 'Connecting…'
}

function pollUntilConnected(attempts = 0): void {
  const maxAttempts = 15
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response: unknown) => {
    void chrome.runtime.lastError
    const connected =
      response !== null &&
      typeof response === 'object' &&
      'connected' in response &&
      (response as { connected: boolean }).connected === true

    if (connected) {
      setConnectionStatus(true)
      connectionMessageEl.textContent = 'Connection saved.'
      return
    }
    if (attempts >= maxAttempts) {
      setConnectionStatus(false)
      connectionMessageEl.textContent = 'Saved, but bro did not connect. Check the URL and token.'
      return
    }
    setTimeout(() => pollUntilConnected(attempts + 1), 1_000)
  })
}

saveBtn.addEventListener('click', () => {
  void (async () => {
    saveBtn.disabled = true
    connectionMessageEl.textContent = 'Saving connection…'
    try {
      await saveSettings(serverUrlInput.value, tokenInput.value.trim())
    } catch (error) {
      connectionMessageEl.textContent = errorMessage(error)
      saveBtn.disabled = false
      return
    }

    chrome.runtime.sendMessage({ type: 'RECONNECT' }, () => {
      void chrome.runtime.lastError
    })
    setConnecting()
    pollUntilConnected()
    saveBtn.disabled = false
  })()
})

const createScriptBtn = element<HTMLButtonElement>('create-script-btn')
const emptyCreateScriptBtn = element<HTMLButtonElement>('empty-create-script-btn')
const scriptListEl = element<HTMLDivElement>('userscript-list')
const scriptEmptyEl = element<HTMLDivElement>('userscript-empty')
const scriptStatusEl = element<HTMLParagraphElement>('userscript-status')
const scriptForm = element<HTMLFormElement>('userscript-form')
const editorTitleEl = element<HTMLHeadingElement>('editor-title')
const closeEditorBtn = element<HTMLButtonElement>('close-editor-btn')
const discardScriptBtn = element<HTMLButtonElement>('discard-script-btn')
const saveScriptBtn = element<HTMLButtonElement>('save-script-btn')
const editorMessageEl = element<HTMLParagraphElement>('editor-message')
const scriptIdInput = element<HTMLInputElement>('script-id')
const scriptDescriptionInput = element<HTMLInputElement>('script-description')
const scriptMatchesInput = element<HTMLTextAreaElement>('script-matches')
const scriptCodeInput = element<HTMLTextAreaElement>('script-code')
const scriptRunAtInput = element<HTMLSelectElement>('script-run-at')
const scriptWorldInput = element<HTMLSelectElement>('script-world')
const scriptAllFramesInput = element<HTMLInputElement>('script-all-frames')
const scriptExcludeMatchesInput = element<HTMLTextAreaElement>('script-exclude-matches')

let scripts: ManagedUserScript[] = []
let editingId: string | null = null
let pendingDeleteId: string | null = null
let scriptOperationPending = false

function setScriptStatus(message: string, tone: 'normal' | 'error' | 'success' = 'normal'): void {
  scriptStatusEl.textContent = message
  scriptStatusEl.className = tone === 'normal'
    ? 'manager-status'
    : `manager-status ${tone}`
}

function setEditorMessage(message: string, error = false): void {
  editorMessageEl.textContent = message
  editorMessageEl.className = error ? 'manager-status error' : 'manager-status'
}

function inlineCode(script: chrome.userScripts.RegisteredUserScript): string | null {
  if (script.js?.length !== 1) return null
  const source = script.js[0]
  return source && 'code' in source && typeof source.code === 'string'
    ? source.code
    : null
}

function actionButton(
  label: string,
  action: string,
  scriptId: string,
  className = 'button-text',
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.className = className
  button.dataset.action = action
  button.dataset.scriptId = scriptId
  button.disabled = scriptOperationPending
  return button
}

function renderScripts(): void {
  scriptListEl.replaceChildren()
  scriptEmptyEl.hidden = scripts.length !== 0

  for (const script of scripts) {
    const row = document.createElement('article')
    row.className = 'script-row'
    row.setAttribute('role', 'listitem')

    const summary = document.createElement('div')
    const id = document.createElement('h3')
    id.className = 'script-id'
    id.textContent = script.id
    summary.append(id)

    const description = document.createElement('p')
    description.className = 'script-description'
    description.textContent = script.description || 'No description provided.'
    summary.append(description)

    const matches = document.createElement('p')
    matches.className = 'script-match'
    matches.textContent = script.matches?.join('\n') || 'No match patterns'
    summary.append(matches)

    const meta = document.createElement('div')
    meta.className = 'script-meta'
    const values = [
      script.runAt ?? 'document_idle',
      script.world ?? 'USER_SCRIPT',
      script.allFrames ? 'all frames' : 'top frame',
    ]
    if (inlineCode(script) === null) values.push('file-backed')
    for (const value of values) {
      const tag = document.createElement('span')
      tag.className = 'meta-tag'
      tag.textContent = value.replaceAll('_', ' ')
      meta.append(tag)
    }
    summary.append(meta)

    const actions = document.createElement('div')
    actions.className = 'script-actions'
    const edit = actionButton('Edit', 'edit', script.id)
    if (inlineCode(script) === null) {
      edit.disabled = true
      edit.title = 'File-backed scripts cannot be edited here.'
    }
    actions.append(edit, actionButton('Delete', 'delete', script.id, 'button-text danger'))
    row.append(summary, actions)

    if (pendingDeleteId === script.id) {
      const confirmation = document.createElement('div')
      confirmation.className = 'delete-confirmation'
      const message = document.createElement('span')
      message.textContent = `Delete ${script.id}?`
      confirmation.append(
        message,
        actionButton('Keep script', 'keep', script.id, 'button-secondary'),
        actionButton('Delete script', 'confirm-delete', script.id, 'button-danger'),
      )
      row.append(confirmation)
    }

    scriptListEl.append(row)
  }
}

async function refreshScripts(status = ''): Promise<void> {
  setScriptStatus(status || 'Reading scripts…')
  try {
    scripts = await listUserScripts()
    scripts.sort((a, b) => a.id.localeCompare(b.id))
    pendingDeleteId = null
    createScriptBtn.disabled = false
    emptyCreateScriptBtn.disabled = false
    renderScripts()
    setScriptStatus(status)
  } catch (error) {
    scripts = []
    scriptListEl.replaceChildren()
    scriptEmptyEl.hidden = true
    createScriptBtn.disabled = true
    emptyCreateScriptBtn.disabled = true
    setScriptStatus(`${errorMessage(error)} Open chrome://extensions and enable Allow User Scripts.`, 'error')
  }
}

function openCreateEditor(): void {
  editingId = null
  scriptForm.reset()
  scriptIdInput.disabled = false
  scriptRunAtInput.value = 'document_idle'
  scriptWorldInput.value = 'USER_SCRIPT'
  editorTitleEl.textContent = 'Create script'
  saveScriptBtn.textContent = 'Create script'
  setEditorMessage('')
  scriptForm.hidden = false
  scriptEmptyEl.hidden = true
  scriptIdInput.focus()
}

function openEditEditor(scriptId: string): void {
  const script = scripts.find((item) => item.id === scriptId)
  if (!script) return
  const code = inlineCode(script)
  if (code === null) {
    setScriptStatus('File-backed scripts cannot be edited in this version.', 'error')
    return
  }

  editingId = script.id
  scriptIdInput.value = script.id
  scriptIdInput.disabled = true
  scriptDescriptionInput.value = script.description ?? ''
  scriptMatchesInput.value = script.matches?.join('\n') ?? ''
  scriptCodeInput.value = code
  scriptRunAtInput.value = script.runAt ?? 'document_idle'
  scriptWorldInput.value = script.world ?? 'USER_SCRIPT'
  scriptAllFramesInput.checked = script.allFrames ?? false
  scriptExcludeMatchesInput.value = script.excludeMatches?.join('\n') ?? ''
  editorTitleEl.textContent = 'Edit script'
  saveScriptBtn.textContent = 'Save script'
  setEditorMessage('')
  scriptForm.hidden = false
  scriptCodeInput.focus()
}

function closeEditor(): void {
  editingId = null
  scriptForm.hidden = true
  scriptForm.reset()
  setEditorMessage('')
  renderScripts()
}

function lines(value: string): string[] {
  return value.split('\n')
}

scriptForm.addEventListener('submit', (event) => {
  event.preventDefault()
  if (scriptOperationPending) return

  void (async () => {
    scriptOperationPending = true
    saveScriptBtn.disabled = true
    setEditorMessage(editingId === null ? 'Creating script…' : 'Saving script…')
    try {
      const script = createInlineUserScript({
        id: scriptIdInput.value,
        description: scriptDescriptionInput.value,
        matches: lines(scriptMatchesInput.value),
        excludeMatches: lines(scriptExcludeMatchesInput.value),
        code: scriptCodeInput.value,
        runAt: scriptRunAtInput.value as 'document_start' | 'document_end' | 'document_idle',
        world: scriptWorldInput.value as 'USER_SCRIPT' | 'MAIN',
        allFrames: scriptAllFramesInput.checked,
      })
      if (editingId === null) {
        await registerUserScripts([script])
      } else {
        await updateUserScripts([script])
      }
      const message = editingId === null
        ? `Created ${script.id}.`
        : `Saved ${script.id}.`
      closeEditor()
      await refreshScripts(message)
      setScriptStatus(message, 'success')
    } catch (error) {
      setEditorMessage(errorMessage(error), true)
    } finally {
      scriptOperationPending = false
      saveScriptBtn.disabled = false
      renderScripts()
    }
  })()
})

scriptListEl.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest<HTMLButtonElement>('button[data-action]')
  const scriptId = button?.dataset.scriptId
  if (!button || !scriptId || scriptOperationPending) return

  switch (button.dataset.action) {
    case 'edit':
      openEditEditor(scriptId)
      break
    case 'delete':
      pendingDeleteId = scriptId
      renderScripts()
      break
    case 'keep':
      pendingDeleteId = null
      renderScripts()
      break
    case 'confirm-delete':
      void (async () => {
        scriptOperationPending = true
        renderScripts()
        setScriptStatus(`Deleting ${scriptId}…`)
        try {
          await unregisterUserScripts([scriptId])
          if (editingId === scriptId) closeEditor()
          await refreshScripts(`Deleted ${scriptId}.`)
          setScriptStatus(`Deleted ${scriptId}.`, 'success')
        } catch (error) {
          setScriptStatus(errorMessage(error), 'error')
        } finally {
          scriptOperationPending = false
          renderScripts()
        }
      })()
      break
  }
})

createScriptBtn.addEventListener('click', openCreateEditor)
emptyCreateScriptBtn.addEventListener('click', openCreateEditor)
closeEditorBtn.addEventListener('click', closeEditor)
discardScriptBtn.addEventListener('click', closeEditor)

void loadStoredSettings()
updateConnectionStatus()
setInterval(updateConnectionStatus, 3_000)
void refreshScripts()
