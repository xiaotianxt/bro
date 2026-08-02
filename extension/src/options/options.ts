// Options page script for bro extension.
// Allows configuring the WebSocket server URL and shows connection status.

import {
  DEFAULT_SERVER_URL,
  loadServerUrl,
  loadToken,
  saveSettings,
} from '../settings.js'

const serverUrlInput = document.getElementById('server-url') as HTMLInputElement
const tokenInput = document.getElementById('token') as HTMLInputElement
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLDivElement
const statusTextEl = document.getElementById('status-text') as HTMLSpanElement

// ---------------------------------------------------------------------------
// Load saved URL on page open
// ---------------------------------------------------------------------------

async function loadStoredSettings(): Promise<void> {
  try {
    const [serverUrl, token] = await Promise.all([loadServerUrl(), loadToken()])
    serverUrlInput.value = serverUrl
    tokenInput.value = token
  } catch (error) {
    console.warn('[Options] Failed to load settings:', error)
    serverUrlInput.value = DEFAULT_SERVER_URL
    setStatus(false, 'Failed to load settings')
  }
}

// ---------------------------------------------------------------------------
// Status polling — query service worker every 3 seconds
// ---------------------------------------------------------------------------

function updateStatus(): void {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response: unknown) => {
    if (chrome.runtime.lastError) {
      // Service worker may be inactive; treat as disconnected
      setStatus(false)
      return
    }
    if (
      response !== null &&
      typeof response === 'object' &&
      'type' in response &&
      (response as { type: string }).type === 'STATUS' &&
      'connected' in response
    ) {
      const { connected } = response as { connected: boolean }
      setStatus(connected)
    } else {
      setStatus(false)
    }
  })
}

function setStatus(connected: boolean, label?: string): void {
  statusEl.className = connected ? 'connected' : 'disconnected'
  statusTextEl.textContent = label ?? (connected ? 'Connected' : 'Disconnected')
}

function setConnecting(): void {
  statusEl.className = 'connecting'
  statusTextEl.textContent = 'Connecting…'
}

// ---------------------------------------------------------------------------
// Poll until connected (used after save/reconnect)
// ---------------------------------------------------------------------------

function pollUntilConnected(attempts = 0): void {
  const MAX_ATTEMPTS = 15 // 15 × 1s = 15s max
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response: unknown) => {
    void chrome.runtime.lastError
    const connected =
      response !== null &&
      typeof response === 'object' &&
      'connected' in response &&
      (response as { connected: boolean }).connected === true

    if (connected) {
      setStatus(true)
      return
    }
    if (attempts >= MAX_ATTEMPTS) {
      setStatus(false)
      return
    }
    setTimeout(() => pollUntilConnected(attempts + 1), 1_000)
  })
}

// ---------------------------------------------------------------------------
// Save button — persist URL and tell service worker to reconnect
// ---------------------------------------------------------------------------

saveBtn.addEventListener('click', () => {
  void (async () => {
    try {
      await saveSettings(serverUrlInput.value, tokenInput.value.trim())
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save settings'
      setStatus(false, message)
      return
    }

    // Tell the service worker to reconnect with the new URL/token
    chrome.runtime.sendMessage({ type: 'RECONNECT' }, () => {
      void chrome.runtime.lastError
    })
    // Show connecting state and poll until the service worker reports connected
    setConnecting()
    pollUntilConnected()
  })()
})

// ---------------------------------------------------------------------------
// Auto-refresh status every 3 seconds
// ---------------------------------------------------------------------------

void loadStoredSettings()
updateStatus()
setInterval(updateStatus, 3_000)
