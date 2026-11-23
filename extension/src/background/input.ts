import { CDP_COMMAND_TIMEOUT_MS, cdpSession } from './cdp.js'
import { renderState, unresponsive } from './render-state.js'

/** What an action running inside withInput may wait on. */
export interface Input {
  /**
   * Resolves once the browser has composited the page as it is now. Call it
   * after preparing a point and before dispatching input the browser hit-tests.
   * The browser routes such input into a cross-site frame by hit-test data that
   * follows composited frames, not the renderer's requestAnimationFrame; a tab
   * that was not painting has none for its current layout until one is drawn,
   * and its input lands in the parent document instead.
   */
  composited(): Promise<void>
}

// A tab has one emulation state. Serialize whole actions, not just preparation,
// so another action cannot turn emulation off while input is still in flight.
const inputs = new Map<number, { tail: Promise<void>; interrupted: boolean }>()
cdpSession.onDetach((tabId) => {
  const state = inputs.get(tabId)
  if (state) state.interrupted = true
})

export async function withInput<T>(tabId: number, action: (input: Input) => Promise<T>): Promise<T> {
  const state = inputs.get(tabId) ?? { tail: Promise.resolve(), interrupted: false }
  const previous = state.tail
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  state.tail = current
  inputs.set(tabId, state)
  await previous

  let failure: unknown
  try {
    if (state.interrupted) throw new Error('Queued input cancelled: debugger detached')
    const render = await renderState(tabId, CDP_COMMAND_TIMEOUT_MS)
    if (render === 'frozen' || render === 'discarded') throw new Error(unresponsive(tabId, render))
    await cdpSession.removeForeignFramesBeforeInput(tabId)
    // Allows hidden-page rendering without selecting a tab or focusing a window.
    // No foreground fallback: a failed dispatch must never be replayed.
    await cdpSession.send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true })
    const input: Input = {
      // A painting tab composites every frame by itself.
      composited:
        render === 'painting'
          ? async () => {}
          : async () => {
              // The reply follows a composited frame; a busy renderer delays it.
              await cdpSession.send(
                tabId,
                'Page.captureScreenshot',
                { format: 'jpeg', quality: 1, optimizeForSpeed: true },
              )
            },
    }
    const result = await action(input)
    if (state.interrupted) throw new Error('Input interrupted: debugger detached; verify the page before retrying')
    return result
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      await cdpSession.resetInputFocus(tabId)
    } catch (cleanupError) {
      if (failure !== undefined) {
        throw new Error(`${String(failure)}; focus cleanup also failed: ${String(cleanupError)}`)
      }
      throw cleanupError
    } finally {
      if (state.tail === current) inputs.delete(tabId)
      release()
    }
  }
}
