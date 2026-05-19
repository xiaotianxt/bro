// Options page script for bro extension.
// Allows configuring the WebSocket server URL and shows connection status.

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:3500/ws'

const serverUrlInput = document.getElementById('server-url') as HTMLInputElement
const tokenInput = document.getElementById('token') as HTMLInputElement
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement
const testBtn = document.getElementById('test-btn') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLDivElement
const statusTextEl = document.getElementById('status-text') as HTMLSpanElement

// ---------------------------------------------------------------------------
// Load saved URL on page open
// ---------------------------------------------------------------------------

function loadStoredSettings(): void {
  chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL, token: '' }, (items) => {
    if (chrome.runtime.lastError) {
      console.warn('[Options] storage.sync.get error:', chrome.runtime.lastError.message)
      serverUrlInput.value = DEFAULT_SERVER_URL
    } else {
      const url = typeof items['serverUrl'] === 'string' ? items['serverUrl'] : DEFAULT_SERVER_URL
      serverUrlInput.value = url
      tokenInput.value = typeof items['token'] === 'string' ? items['token'] : ''
    }
  })
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
  const url = serverUrlInput.value.trim() || DEFAULT_SERVER_URL
  const token = tokenInput.value.trim()
  chrome.storage.sync.set({ serverUrl: url, token }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[Options] storage.sync.set error:', chrome.runtime.lastError.message)
      return
    }
    // Tell the service worker to reconnect with the new URL/token
    chrome.runtime.sendMessage({ type: 'RECONNECT' }, () => {
      void chrome.runtime.lastError
    })
    // Show connecting state and poll until the service worker reports connected
    setConnecting()
    pollUntilConnected()
  })
})

// ---------------------------------------------------------------------------
// Test Connection button — attempt a WebSocket handshake to the URL
// ---------------------------------------------------------------------------

testBtn.addEventListener('click', () => {
  const url = serverUrlInput.value.trim() || DEFAULT_SERVER_URL
  testBtn.disabled = true
  testBtn.textContent = 'Testing…'

  let finished = false

  const ws = new WebSocket(url)

  const finish = (success: boolean): void => {
    if (finished) return
    finished = true
    ws.onopen = null
    ws.onerror = null
    ws.onclose = null
    try {
      ws.close()
    } catch {
      // ignore
    }
    testBtn.disabled = false
    testBtn.textContent = 'Test Connection'
    setStatus(success)
  }

  const timeoutId = setTimeout(() => {
    finish(false)
  }, 5_000)

  ws.onopen = () => {
    clearTimeout(timeoutId)
    finish(true)
  }

  ws.onerror = () => {
    clearTimeout(timeoutId)
    finish(false)
  }

  ws.onclose = () => {
    clearTimeout(timeoutId)
    // onopen wasn't called yet → treat as failure
    if (!finished) {
      finish(false)
    }
  }
})

// ---------------------------------------------------------------------------
// Auto-refresh status every 3 seconds
// ---------------------------------------------------------------------------

loadStoredSettings()
updateStatus()
setInterval(updateStatus, 3_000)
