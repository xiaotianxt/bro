import { beforeEach, describe, expect, it, vi } from 'vitest'

const cdp = vi.hoisted(() => ({ send: vi.fn(), resetInputFocus: vi.fn(), onDetach: vi.fn() }))
vi.mock('../cdp.js', () => ({ cdpSession: cdp }))
import { withInput } from '../input.js'

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

beforeEach(() => {
  cdp.send.mockReset().mockResolvedValue({})
  cdp.resetInputFocus.mockReset().mockResolvedValue(undefined)
})

describe('scoped input focus', () => {
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
    cdp.onDetach.mock.calls[0]![0](6)
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
