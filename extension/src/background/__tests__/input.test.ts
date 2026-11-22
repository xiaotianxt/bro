import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdp = vi.hoisted(() => ({ send: vi.fn(), resetInputFocus: vi.fn(), onDetach: vi.fn(), removeForeignFramesBeforeInput: vi.fn() }))
vi.mock('../cdp.js', () => ({ cdpSession: cdp }))
const render = vi.hoisted(() => ({ state: vi.fn() }))
vi.mock('../render-state.js', async (actual) => ({
  ...(await actual<typeof import('../render-state.js')>()),
  renderState: render.state,
}))
import { withInput } from '../input.js'

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

beforeEach(() => {
  cdp.send.mockReset().mockResolvedValue({})
  cdp.resetInputFocus.mockReset().mockResolvedValue(undefined)
  cdp.removeForeignFramesBeforeInput.mockReset().mockResolvedValue(undefined)
  render.state.mockReset().mockResolvedValue('painting')
})

describe('scoped input focus', () => {
  // Regression (live, password manager): a menu drawn at load was still
  // loading when the first click attached; it committed mid-click and closed
  // the session.
  it('removes foreign frames before anything is sent for the input', async () => {
    const order: string[] = []
    cdp.removeForeignFramesBeforeInput.mockImplementation(async () => void order.push('remove'))
    cdp.send.mockImplementation(async (_tab: number, method: string) => void order.push(method))
    await withInput(9, async () => void order.push('action'))
    expect(order).toEqual(['remove', 'Emulation.setFocusEmulationEnabled', 'action'])
  })

  it('does not let overlapping actions clear each other’s emulation', async () => {
    const entered = gate(), finish = gate()
    const first = withInput(1, async () => { entered.open(); await finish.promise })
    await entered.promise
    const secondAction = vi.fn(async () => 'second')
    const second = withInput(1, secondAction)
    await withInput(2, async () => 'other tab')
    expect(secondAction).not.toHaveBeenCalled()
    expect(cdp.resetInputFocus).not.toHaveBeenCalledWith(1)
    finish.open()
    await first
    expect(await second).toBe('second')
    expect(cdp.resetInputFocus.mock.calls.filter(([id]) => id === 1)).toHaveLength(2)
  })

  it('cleans up a failed action and releases the next caller without replay', async () => {
    const action = vi.fn(async () => { throw new Error('dispatch failed') })
    await expect(withInput(3, action)).rejects.toThrow('dispatch failed')
    expect(action).toHaveBeenCalledTimes(1)
    expect(cdp.resetInputFocus).toHaveBeenCalledWith(3)
    expect(await withInput(3, async () => 'next')).toBe('next')
  })

  it('does not hide cleanup failure or the original action failure', async () => {
    cdp.resetInputFocus.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(withInput(4, async () => { throw new Error('input failed') }))
      .rejects.toThrow('input failed; focus cleanup also failed: Error: cleanup failed')
    expect(await withInput(4, async () => 'released')).toBe('released')
  })

  it('cancels queued input after detachment instead of reattaching and dispatching', async () => {
    const entered = gate(), finish = gate()
    const first = withInput(6, async () => { entered.open(); await finish.promise })
    const firstResult = expect(first).rejects.toThrow('Input interrupted')
    await entered.promise
    const action = vi.fn()
    const queued = withInput(6, action)
    const queuedResult = expect(queued).rejects.toThrow('Queued input cancelled')
    for (const [detached] of cdp.onDetach.mock.calls) detached(6)
    finish.open()
    await Promise.all([firstResult, queuedResult])
    expect(action).not.toHaveBeenCalled()
    expect(cdp.send).toHaveBeenCalledTimes(1)
  })

  it('never dispatches when emulation cannot be enabled', async () => {
    cdp.send.mockRejectedValueOnce(new Error('unsupported'))
    const action = vi.fn()
    await expect(withInput(5, action)).rejects.toThrow('unsupported')
    expect(action).not.toHaveBeenCalled()
  })
})

describe('input by render state', () => {
  it('refuses a frozen or discarded tab before emulating or dispatching', async () => {
    for (const state of ['frozen', 'discarded'] as const) {
      render.state.mockResolvedValueOnce(state)
      const action = vi.fn()
      await expect(withInput(7, action)).rejects.toThrow(`tab 7 is ${state}`)
      expect(action).not.toHaveBeenCalled()
    }
    expect(cdp.send).not.toHaveBeenCalled()
  })

  it('composites a frame before hit-tested input only in a tab that was not painting', async () => {
    const captures = () => cdp.send.mock.calls.filter(([, method]) => method === 'Page.captureScreenshot')
    await withInput(8, (input) => input.composited())
    expect(captures()).toHaveLength(0)
    render.state.mockResolvedValueOnce('hidden')
    await withInput(8, (input) => input.composited())
    expect(captures()).toHaveLength(1)
    // A busy renderer delays the frame; that is not a dead session to detach.
    expect(captures()[0]![3]).toBe('caller')
  })
})
