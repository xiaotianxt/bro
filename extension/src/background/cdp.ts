// CDP (Chrome DevTools Protocol) abstraction layer for the extension service worker.
// Manages debugger attachment state and event subscriptions per tab.

type EventCallback = (params: unknown) => void
type DetachCallback = (tabId: number) => void

/**
 * CDPSession manages chrome.debugger attachments and routes CDP events
 * to registered callbacks. One instance is shared across the service worker.
 */
export class CDPSession {
  // Tracks which tabIds currently have an active debugger attachment.
  private readonly attached = new Map<number, boolean>()

  // Event subscribers: tabId → eventName → Set of callbacks
  private readonly eventListeners = new Map<
    number,
    Map<string, Set<EventCallback>>
  >()

  private readonly detachCallbacks = new Set<DetachCallback>()

  constructor() {
    // Route raw debugger events to registered callbacks.
    chrome.debugger.onEvent.addListener(
      (source: chrome.debugger.Debuggee, method: string, params?: object) => {
        const tabId = source.tabId
        if (tabId === undefined) return
        const tabListeners = this.eventListeners.get(tabId)
        if (!tabListeners) return
        const callbacks = tabListeners.get(method)
        if (!callbacks) return
        for (const cb of callbacks) {
          cb(params ?? null)
        }
      },
    )

    // Clean up state when the debugger is detached externally (e.g., DevTools opened).
    chrome.debugger.onDetach.addListener(
      (source: chrome.debugger.Debuggee) => {
        const tabId = source.tabId
        if (tabId === undefined) return
        this.attached.delete(tabId)
        this.eventListeners.delete(tabId)
        for (const callback of this.detachCallbacks) {
          callback(tabId)
        }
      },
    )
  }

  /**
   * Attaches the debugger to the given tab if not already attached.
   * Gracefully ignores "Already attached" errors.
   */
  async ensure(tabId: number): Promise<void> {
    if (this.attached.get(tabId)) return

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        const err = chrome.runtime.lastError
        if (err) {
          const msg = err.message ?? ''
          reject(new Error(`CDP attach failed for tab ${tabId}: ${msg}`))
        } else {
          this.attached.set(tabId, true)
          resolve()
        }
      })
    })
  }

  /**
   * Detaches the debugger from the given tab.
   * Gracefully ignores "Not attached" errors.
   */
  async detach(tabId: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.detach({ tabId }, () => {
        const err = chrome.runtime.lastError
        if (err) {
          const msg = err.message ?? ''
          if (msg.includes('not attached') || msg.includes('Not attached')) {
            // Already detached — that's fine.
            resolve()
          } else {
            reject(new Error(`CDP detach failed for tab ${tabId}: ${msg}`))
          }
        } else {
          resolve()
        }
      })
    })
    this.attached.delete(tabId)
    this.eventListeners.delete(tabId)
  }

  /**
   * Detaches from tabs that only needed CDP for a short-lived command.
   * Long-lived monitors keep event listeners registered and stay attached.
   */
  async detachIfIdle(tabId: number): Promise<boolean> {
    if (!this.attached.get(tabId)) return false
    if (this.hasEventListeners(tabId)) return false

    await this.detach(tabId)
    return true
  }

  /**
   * Sends a CDP command to the given tab. Automatically attaches if needed.
   */
  async send<T>(tabId: number, method: string, params?: object): Promise<T> {
    await this.ensure(tabId)
    try {
      return await this.sendAttached<T>(tabId, method, params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('Debugger is not attached')) {
        throw error
      }
      if (this.hasEventListeners(tabId)) {
        this.attached.delete(tabId)
        this.eventListeners.delete(tabId)
        throw new Error(
          `CDP command "${method}" failed for tab ${tabId}: debugger detached while event listeners were active; re-enable monitoring and retry`,
        )
      }
      this.attached.delete(tabId)
      await this.ensure(tabId)
      return await this.sendAttached<T>(tabId, method, params)
    }
  }

  private async sendAttached<T>(
    tabId: number,
    method: string,
    params?: object,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
        const err = chrome.runtime.lastError
        if (err) {
          reject(new Error(`CDP command "${method}" failed for tab ${tabId}: ${err.message ?? ''}`))
        } else {
          resolve(result as T)
        }
      })
    })
  }

  /**
   * Subscribes to a CDP event on the given tab.
   * Returns an unsubscribe function.
   */
  onEvent(
    tabId: number,
    eventName: string,
    callback: EventCallback,
  ): () => void {
    let tabListeners = this.eventListeners.get(tabId)
    if (!tabListeners) {
      tabListeners = new Map()
      this.eventListeners.set(tabId, tabListeners)
    }

    let callbacks = tabListeners.get(eventName)
    if (!callbacks) {
      callbacks = new Set()
      tabListeners.set(eventName, callbacks)
    }

    callbacks.add(callback)

    return () => {
      const listeners = this.eventListeners.get(tabId)
      if (!listeners) return
      const cbs = listeners.get(eventName)
      if (!cbs) return
      cbs.delete(callback)
      if (cbs.size === 0) {
        listeners.delete(eventName)
      }
    }
  }

  onDetach(callback: DetachCallback): () => void {
    this.detachCallbacks.add(callback)
    return () => {
      this.detachCallbacks.delete(callback)
    }
  }

  /**
   * Detaches all active debugger sessions.
   * Should be called on service worker unload.
   */
  async detachAll(): Promise<void> {
    const tabIds = Array.from(this.attached.keys())
    await Promise.allSettled(tabIds.map((tabId) => this.detach(tabId)))
  }

  private hasEventListeners(tabId: number): boolean {
    const tabListeners = this.eventListeners.get(tabId)
    if (!tabListeners) return false

    for (const callbacks of tabListeners.values()) {
      if (callbacks.size > 0) return true
    }
    return false
  }
}

// Export a singleton instance for use across the service worker.
export const cdpSession = new CDPSession()
