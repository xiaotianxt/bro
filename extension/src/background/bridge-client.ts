// WebSocket bridge client for the Chrome Extension.
// Connects to the local MCP server and manages reconnection.
//
// Reconnect strategy: Uses chrome.alarms API (persists across service worker
// suspension) instead of setTimeout (which is lost on suspension).
// A 'keepalive' alarm fires every ~6 seconds (periodInMinutes: 0.1).
// When the alarm fires and the client is disconnected, it triggers reconnect.

import {
  type ExtensionToServerMessage,
  type ServerToExtensionMessage,
  parseServerMessage,
} from '@bro/shared'

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:3500/ws'
const EXTENSION_VERSION = '0.1.0'

// Alarm names
export const ALARM_KEEPALIVE = 'keepalive'
export const ALARM_WS_RECONNECT = 'ws-reconnect'

// Keepalive alarm period in minutes (~6 seconds)
const KEEPALIVE_PERIOD_MINUTES = 0.1

type MessageHandler = (msg: ServerToExtensionMessage) => void

/**
 * BridgeClient manages the WebSocket connection between the extension
 * service worker and the MCP server. Handles auto-reconnection via
 * chrome.alarms (which persist across service worker suspension cycles).
 */
export class BridgeClient {
  private ws: WebSocket | null = null
  private messageHandlers: Set<MessageHandler> = new Set()
  private _isConnected = false
  // Tracks whether connect() has been called (and disconnect() not yet called)
  private active = false
  // Cached server URL for reconnect attempts triggered by alarms
  private serverUrl: string | null = null

  get isConnected(): boolean {
    return this._isConnected
  }

  /**
   * Reads the server URL from chrome.storage.sync, then opens the
   * WebSocket connection. Call only once on service worker startup.
   * Also registers the keepalive alarm to survive service worker suspension.
   */
  async connect(): Promise<void> {
    this.active = true
    const url = await this.getServerUrl()
    this.serverUrl = url
    this.registerKeepaliveAlarm()
    this.openSocket(url)
  }

  /**
   * Permanently disconnects and stops reconnection attempts.
   * Also clears the keepalive and reconnect alarms.
   */
  disconnect(): void {
    this.active = false
    this.clearAlarms()
    if (this.ws) {
      this.ws.onclose = null // prevent reconnect callback
      this.ws.close()
      this.ws = null
    }
    this._isConnected = false
    this.serverUrl = null
    console.log('[BridgeClient] Disconnected (manual)')
  }

  /**
   * Sends a message to the server. No-op if not connected.
   */
  send(msg: ExtensionToServerMessage): void {
    if (!this._isConnected || !this.ws) {
      console.warn('[BridgeClient] Cannot send — not connected')
      return
    }
    this.ws.send(JSON.stringify(msg))
  }

  /**
   * Registers a handler for incoming messages from the server.
   * Returns an unsubscribe function.
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => {
      this.messageHandlers.delete(handler)
    }
  }

  /**
   * Called by the alarm handler (in service-worker.ts) when a keepalive or
   * ws-reconnect alarm fires. If the client is active but not connected,
   * attempts to reconnect.
   */
  async onAlarm(alarmName: string): Promise<void> {
    if (
      alarmName !== ALARM_KEEPALIVE &&
      alarmName !== ALARM_WS_RECONNECT
    ) {
      return
    }

    if (!this.active) return

    if (this._isConnected) {
      // Already connected — nothing to do
      return
    }

    console.log(`[BridgeClient] Alarm '${alarmName}' fired — attempting reconnect`)

    // Re-read server URL in case it changed
    const url = await this.getServerUrl()
    this.serverUrl = url
    this.openSocket(url)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getOrCreateInstanceId(): Promise<string> {
    return new Promise((resolve) => {
      // Use storage.local so the instanceId persists across service worker
      // restarts, Chrome restarts, and extension updates. storage.session
      // is cleared when the browser session ends or the extension is reloaded,
      // causing a new instanceId to be generated on every SW restart and
      // leaving stale zombie connections on the server.
      chrome.storage.local.get({ instance_id: '' }, (items) => {
        const err = chrome.runtime.lastError
        if (err) {
          console.warn('[BridgeClient] storage.local.get error:', err.message)
          resolve(crypto.randomUUID())
          return
        }
        const existing = items['instance_id']
        if (typeof existing === 'string' && existing.length > 0) {
          resolve(existing)
          return
        }
        const newId = crypto.randomUUID()
        chrome.storage.local.set({ instance_id: newId }, () => {
          resolve(newId)
        })
      })
    })
  }

  private async getServerUrl(): Promise<string> {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL }, (items) => {
        const err = chrome.runtime.lastError
        if (err) {
          console.warn('[BridgeClient] storage.sync.get error:', err.message)
          resolve(DEFAULT_SERVER_URL)
        } else {
          const url =
            typeof items['serverUrl'] === 'string'
              ? items['serverUrl']
              : DEFAULT_SERVER_URL
          resolve(url)
        }
      })
    })
  }

  private async getToken(): Promise<string> {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ token: '' }, (items) => {
        void chrome.runtime.lastError
        resolve(typeof items['token'] === 'string' ? items['token'] : '')
      })
    })
  }

  private registerKeepaliveAlarm(): void {
    // Create a repeating alarm that fires every KEEPALIVE_PERIOD_MINUTES.
    // This wakes the service worker periodically so we can check connection
    // state and reconnect if needed. The alarm persists across SW suspension.
    chrome.alarms.create(ALARM_KEEPALIVE, {
      periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
    })
    console.log('[BridgeClient] Keepalive alarm registered')
  }

  private clearAlarms(): void {
    chrome.alarms.clear(ALARM_KEEPALIVE)
    chrome.alarms.clear(ALARM_WS_RECONNECT)
  }

  private openSocket(url: string): void {
    if (!this.active) return

    // Avoid creating duplicate connections
    if (this.ws !== null) return

    console.log(`[BridgeClient] Connecting to ${url}…`)

    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = async () => {
      if (!this.active) {
        ws.close()
        return
      }
      console.log('[BridgeClient] Connected')
      this._isConnected = true

      // Get or create a per-window instanceId (survives SW restarts, unique per window)
      const instanceId = await this.getOrCreateInstanceId()

      // Read the authentication token from storage
      const token = await this.getToken()

      // Query the active tab URL for identification
      let activeTabUrl = ''
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
        activeTabUrl = tabs[0]?.url ?? ''
      } catch {
        // tabs.query can fail if no window is focused
      }

      // Collect browser identity info via User-Agent Client Hints API
      type UABrand = { brand: string; version: string }
      type NavigatorUAData = { brands: UABrand[]; mobile: boolean; platform: string }
      const uaData = (navigator as unknown as { userAgentData?: NavigatorUAData }).userAgentData
      let browserName = 'Chromium'
      let browserVersion = ''
      let platform = ''
      if (uaData) {
        platform = uaData.platform ?? ''
        // Filter out noise entries like "Not A Brand" / "Not-A.Brand"
        const significant = uaData.brands.filter(
          (b) => !b.brand.toLowerCase().includes('not') && b.brand !== 'Chromium',
        )
        const chromium = uaData.brands.find((b) => b.brand === 'Chromium')
        if (significant.length > 0) {
          browserName = significant[0]!.brand
          browserVersion = significant[0]!.version
        } else if (chromium) {
          browserName = 'Chromium'
          browserVersion = chromium.version
        }
      }
      // Vivaldi hides from userAgentData brands — detect via User-Agent string
      const vivaldiMatch = navigator.userAgent.match(/Vivaldi\/([\d.]+)/)
      if (vivaldiMatch) {
        browserName = 'Vivaldi'
        browserVersion = vivaldiMatch[1] ?? ''
      }
      // Brave hides from userAgentData brands — detect via navigator.brave
      type BraveNavigator = { brave?: { isBrave?: () => Promise<boolean> } }
      if ((navigator as unknown as BraveNavigator).brave?.isBrave) {
        browserName = 'Brave'
      }

      // Send the connect handshake
      const connectMsg: ExtensionToServerMessage = {
        type: 'connect',
        version: EXTENSION_VERSION,
        extensionId: chrome.runtime.id,
        instanceId,
        token,
        activeTabUrl,
        browserInfo: {
          name: browserName,
          version: browserVersion,
          platform,
          userAgent: navigator.userAgent,
        },
      }
      ws.send(JSON.stringify(connectMsg))
    }

    ws.onmessage = (event: MessageEvent<string>) => {
      let msg: ServerToExtensionMessage
      try {
        msg = parseServerMessage(event.data)
      } catch (err) {
        console.warn('[BridgeClient] Failed to parse message:', err)
        return
      }

      // Handle ping internally — send pong immediately
      if (msg.type === 'ping') {
        this.send({ type: 'pong' })
        return
      }

      // Handle reload command — reload the extension immediately
      if (msg.type === 'reload_extension') {
        console.log('[BridgeClient] Received reload_extension command')
        chrome.runtime.reload()
        return
      }

      for (const handler of this.messageHandlers) {
        handler(msg)
      }
    }

    ws.onclose = () => {
      this._isConnected = false
      this.ws = null
      if (!this.active) return

      // Don't schedule reconnect here with setTimeout — the keepalive alarm
      // will fire within KEEPALIVE_PERIOD_MINUTES and trigger reconnect via
      // onAlarm(). This approach survives service worker suspension.
      console.log('[BridgeClient] Disconnected. Will reconnect on next alarm.')
    }

    ws.onerror = (event) => {
      // The onclose handler fires after onerror, so just log here.
      console.warn('[BridgeClient] WebSocket error', event)
    }
  }
}

// Singleton for use in service-worker.ts
export const bridgeClient = new BridgeClient()
