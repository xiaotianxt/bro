// CDP (Chrome DevTools Protocol) abstraction layer for the extension service worker.
// Manages debugger attachment state and event subscriptions per tab.

import { formatDebuggerAttachError, getDebuggerTargetBlockReason } from './debug-target.js'
import { isForeignExtensionRejection, removeForeignExtensionFrames } from './foreign-frames.js'

type EventCallback = (params: unknown) => void
type DetachCallback = (tabId: number) => void
/** sessionId names the child (cross-site frame) session that sent the event; undefined for the tab itself. */
type EveryTabCallback = (tabId: number, params: unknown, sessionId: string | undefined) => void

// Shared by every CDP command; a timeout also detaches the debugger, so a
// longer bound would hold up recovery for all commands, not just evaluations.
export const CDP_COMMAND_TIMEOUT_MS = 5_000

/** A CDP command got no reply within CDP_COMMAND_TIMEOUT_MS. */
export class CdpCommandTimeout extends Error {}

/** Chrome closed the debugger session while a command was in flight. */
export class CdpSessionClosed extends Error {}

/**
 * CDPSession manages chrome.debugger attachments and routes CDP events
 * to registered callbacks. One instance is shared across the service worker.
 */
export class CDPSession {
  // Tracks which tabIds currently have an active debugger attachment.
  private readonly attached = new Map<number, boolean>()
  private readonly attaching = new Map<number, Promise<void>>()
  private readonly detaching = new Map<number, Promise<void>>()

  // Event subscribers: tabId → eventName → Set of callbacks
  private readonly eventListeners = new Map<
    number,
    Map<string, Set<EventCallback>>
  >()

  private readonly detachCallbacks = new Set<DetachCallback>()

  // Tabs where another extension's frame rejected or closed a session. Tab IDs
  // are not reused within a browser session; the set lives with the worker.
  private readonly foreignFrameTabs = new Set<number>()

  // Events handled for every attached tab. Unlike eventListeners they do not
  // keep a tab attached, and attachment clears none of them.
  private readonly everyTabListeners = new Map<string, Set<EveryTabCallback>>()

  constructor() {
    // Route raw debugger events to registered callbacks.
    chrome.debugger.onEvent.addListener(
      (source: chrome.debugger.DebuggerSession, method: string, params?: object) => {
        const tabId = source.tabId
        if (tabId === undefined) return
        for (const cb of this.everyTabListeners.get(method) ?? []) cb(tabId, params ?? null, source.sessionId)
        // Other child-target events belong to the frame transport, not root monitors.
        if (source.sessionId) return
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
      (source: chrome.debugger.DebuggerSession, reason: string) => {
        const tabId = source.tabId
        if (tabId === undefined || source.sessionId) return
        // Chrome reports a newly created foreign extension frame this way
        // (also a closing tab, for which the removal attempt is harmless).
        if (reason === 'target_closed') this.foreignFrameTabs.add(tabId)
        this.markDetached(tabId)
      },
    )
  }

  /**
   * Attaches the debugger after any previous attachment has finished detaching.
   */
  async ensure(tabId: number): Promise<void> {
    await this.detaching.get(tabId)
    if (this.attached.get(tabId)) return

    const pending = this.attaching.get(tabId)
    if (pending) return pending
    const operation = this.attach(tabId)
    this.attaching.set(tabId, operation)
    try {
      await operation
    } finally {
      this.attaching.delete(tabId)
    }
  }

  private async attach(tabId: number): Promise<void> {
    const blockReason = await getDebuggerTargetBlockReason(tabId)
    if (blockReason) {
      throw new Error(
        `CDP attach blocked for tab ${tabId}: ${blockReason}. Target a normal web page tab explicitly; Chrome does not allow debugger access to this URL type.`,
      )
    }

    // Attach checks committed frame URLs only: an extension frame still
    // loading passes, then closes the session when it commits. Once a tab has
    // shown such frames, remove them before attaching too. A failure here is
    // not final: the rejection path below removes again and reports.
    if (this.foreignFrameTabs.has(tabId)) await removeForeignExtensionFrames(tabId).catch(() => 0)
    let failure = await this.attachDebugger(tabId)
    if (failure !== undefined && isForeignExtensionRejection(failure)) {
      this.foreignFrameTabs.add(tabId)
      // A password manager's in-page iframe; removing it is page-local and
      // needs no reload or extension pause. See foreign-frames.ts.
      let removed: number
      try {
        removed = await removeForeignExtensionFrames(tabId)
      } catch (error) {
        throw new Error(`${formatDebuggerAttachError(tabId, failure)}\nRemoving foreign extension frames failed: ${String(error)}`)
      }
      if (removed > 0) failure = await this.attachDebugger(tabId)
    }
    if (failure !== undefined) throw new Error(formatDebuggerAttachError(tabId, failure))
    // Native dialogs block the page, and file choosers open an OS window no
    // tool can reach; dialogs.ts answers both from these Page events.
    await this.sendAttached(tabId, 'Page.enable')
    await this.sendAttached(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true })
  }

  /** Attaches once; returns the browser's rejection message, if any. */
  private attachDebugger(tabId: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        const err = chrome.runtime.lastError
        if (err) {
          resolve(err.message ?? '')
        } else {
          this.attached.set(tabId, true)
          resolve(undefined)
        }
      })
    })
  }

  /**
   * Detaches the debugger from the given tab.
   * Gracefully ignores "Not attached" errors.
   */
  async detach(tabId: number): Promise<void> {
    const pending = this.detaching.get(tabId)
    if (pending) return pending
    const operation = this.detachAttachment(tabId)
    this.detaching.set(tabId, operation)
    try {
      await operation
    } finally {
      this.detaching.delete(tabId)
    }
  }

  private async detachAttachment(tabId: number): Promise<void> {
    await this.attaching.get(tabId)
    // Child-session IDs become unusable as soon as detachment starts, not when
    // its callback happens to arrive. The next ensure waits for this operation.
    this.markDetached(tabId)
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.detach({ tabId }, () => {
        const err = chrome.runtime.lastError
        if (err) {
          const msg = err.message ?? ''
          if (msg.includes('not attached') || msg.includes('Not attached') || isForeignExtensionRejection(msg)) {
            // Already detached — that's fine. A foreign extension frame ends
            // the session the same way, reporting its access error instead.
            resolve()
          } else {
            reject(new Error(`CDP detach failed for tab ${tabId}: ${msg}`))
          }
        } else {
          resolve()
        }
      })
    })
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
    return this.sendAttached<T>(tabId, method, params)
  }

  async sendToSession<T>(tabId: number, sessionId: string | undefined, method: string, params?: object): Promise<T> {
    if (sessionId === undefined) return this.send<T>(tabId, method, params)
    await this.ensure(tabId)
    return this.sendAttached<T>(tabId, method, params, sessionId)
  }

  /** Clear temporary input emulation without reattaching a closed/detached tab. */
  async resetInputFocus(tabId: number): Promise<void> {
    if (!this.attached.get(tabId)) return // Detachment clears emulation itself.
    try {
      await this.sendAttached(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false })
    } catch (error) {
      // A closed session took its emulation with it, as a detach would: the
      // input that preceded this cleanup stands. Typical when the click woke a
      // password manager, whose new frame made Chrome close the session.
      if (error instanceof CdpSessionClosed) return
      // Do not leave a live page permanently reporting simulated focus.
      try {
        await this.detach(tabId)
      } catch (detachError) {
        throw new Error(`Focus cleanup failed: ${String(error)}; detach failed: ${String(detachError)}`)
      }
      throw new Error(`Focus cleanup failed; debugger detached: ${String(error)}`)
    }
  }

  private async sendAttached<T>(
    tabId: number,
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        this.forceDetach(tabId)
        reject(
          new CdpCommandTimeout(
            `CDP command "${method}" timed out for tab ${tabId} after ${CDP_COMMAND_TIMEOUT_MS}ms`,
          ),
        )
      }, CDP_COMMAND_TIMEOUT_MS)

      void chrome.debugger
        .sendCommand(
          { tabId, ...(sessionId === undefined ? {} : { sessionId }) },
          method,
          (params ?? {}) as Record<string, unknown>,
        )
        .then(
          (result) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve(result as T)
          },
          (error: unknown) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            const message = error instanceof Error ? error.message : String(error)
            const foreign = isForeignExtensionRejection(message)
            if (foreign || /Debugger is not attached|Detached while handling command/.test(message)) {
              // Invalidate frame sessions and monitors together for root and
              // child commands. Never replay input across a new attachment.
              if (foreign) this.foreignFrameTabs.add(tabId)
              this.markDetached(tabId)
              reject(new CdpSessionClosed(`CDP command "${method}" failed for tab ${tabId}: ${message.replace(/\.$/, '')}. Chrome closed the debugger session during this command: DevTools opened, or another extension such as a password manager created its own frame in the page. The next call reattaches and removes such frames; input may have been partly applied, so observe the page before retrying.`))
              return
            }
            reject(new Error(`CDP command "${method}" failed for tab ${tabId}: ${message}`))
          },
        )
    })
  }

  private forceDetach(tabId: number): void {
    // Use the same lifecycle barrier as normal idle cleanup.
    void this.detach(tabId).catch(() => {
      // The original command timeout is reported to its caller.
    })
  }

  private markDetached(tabId: number): void {
    const wasAttached = this.attached.delete(tabId)
    this.eventListeners.delete(tabId)
    if (!wasAttached) return
    for (const callback of this.detachCallbacks) {
      callback(tabId)
    }
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

  /** Subscribes to a CDP event on every tab the session attaches to. */
  onEveryTab(eventName: string, callback: EveryTabCallback): void {
    let callbacks = this.everyTabListeners.get(eventName)
    if (!callbacks) {
      callbacks = new Set()
      this.everyTabListeners.set(eventName, callbacks)
    }
    callbacks.add(callback)
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
