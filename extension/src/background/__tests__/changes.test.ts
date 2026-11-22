import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../dialogs.js', () => ({ takeDialogs: () => [] }))

// The page side, by the serialized function bro runs: a watch started at
// `start`, whose last mutation is the latest one at or before now.
let start: number
let mutations: number[]
let collectedAt: number | undefined

beforeEach(() => {
  vi.useFakeTimers()
  mutations = []
  collectedAt = undefined
  vi.stubGlobal('chrome', {
    scripting: {
      executeScript: vi.fn(async ({ func }: { func: { name: string } }) => {
        const now = Date.now()
        const last = Math.max(start, ...mutations.filter((at) => at <= now))
        if (func.name === 'startWatch') start = now
        if (func.name === 'watchAges') return [{ result: { quiet: now - last, total: now - start, navigating: false } }]
        if (func.name === 'collectWatch') {
          collectedAt = now
          return [{ result: { settledMs: now - start, quiet: now - last >= 400 } }]
        }
        return [{ result: undefined }]
      }),
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('change watch', () => {
  // Regression: a click that took 600 ms to prepare settled the moment it
  // returned, so its fetch's DOM update 100 ms later was never reported.
  it('counts quiet from when the action returned, not from when the watch started', async () => {
    const { watchChanges, QUIET_MS } = await import('../changes.js')
    let acted = 0
    const watching = watchChanges(1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      acted = Date.now()
      mutations.push(acted + 100)
    })
    await vi.advanceTimersByTimeAsync(5000)
    const { changes } = await watching
    expect(collectedAt! - acted).toBeGreaterThanOrEqual(100 + QUIET_MS)
    expect(changes.quiet).toBe(true)
  })

  it('caps the wait counted from the action, however long the action took', async () => {
    const { watchChanges, CAP_MS } = await import('../changes.js')
    let acted = 0
    const watching = watchChanges(1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      acted = Date.now()
      for (let at = acted; at < acted + 10_000; at += 100) mutations.push(at)
    })
    await vi.advanceTimersByTimeAsync(20_000)
    await watching
    expect(collectedAt! - acted).toBeGreaterThanOrEqual(CAP_MS)
    expect(collectedAt! - acted).toBeLessThan(CAP_MS + 200)
  })
})
