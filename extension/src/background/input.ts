import { cdpSession } from './cdp.js'

// A tab has one emulation state. Serialize whole actions, not just preparation,
// so another action cannot turn emulation off while input is still in flight.
const inputs = new Map<number, { tail: Promise<void>; interrupted: boolean }>()
cdpSession.onDetach((tabId) => {
  const state = inputs.get(tabId)
  if (state) state.interrupted = true
})

export async function withInput<T>(tabId: number, action: () => Promise<T>): Promise<T> {
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
    // Allows hidden-page rendering without selecting a tab or focusing a window.
    // No foreground fallback: a failed dispatch must never be replayed.
    await cdpSession.send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true })
    const result = await action()
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
