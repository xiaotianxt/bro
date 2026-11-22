import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../dialogs.js', () => ({ takeDialogs: () => [] }))

// CDP events by name; emit() delivers one as Chrome would.
const listeners = new Map<string, Set<(params: unknown) => void>>()
const emit = (name: string, params: unknown) => listeners.get(name)?.forEach((listener) => listener(params))
vi.mock('../cdp.js', () => ({
  cdpSession: {
    send: vi.fn(async () => ({})),
    onEvent: (_tabId: number, name: string, listener: (params: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => listeners.get(name)!.delete(listener)
    },
  },
}))
const sent = (requestId: string, type: string, url = `https://app.test/${requestId}`) =>
  emit('Network.requestWillBeSent', { requestId, type, request: { method: 'GET', url } })

// The page side, by the serialized function bro runs: a watch started at
// `start`, whose last mutation is the latest one at or before now.
let start: number
let mutations: number[]
let collectedAt: number | undefined

beforeEach(() => {
  vi.useFakeTimers()
  mutations = []
  collectedAt = undefined
  listeners.clear()
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

  // One table: what the action's requests do, and when the report may end.
  // `answer` is when the request finishes after the action; the page renders
  // its answer 20 ms later.
  it.each([
    { name: 'a fetch slower than the quiet period', type: 'Fetch', answer: 1500, waitsFor: true },
    { name: 'an XHR', type: 'XHR', answer: 900, waitsFor: true },
    { name: 'a failed fetch', type: 'Fetch', answer: 900, failed: true, waitsFor: true },
    { name: 'a beacon', type: 'Ping', answer: 1500, waitsFor: false },
    { name: 'a WebSocket', type: 'WebSocket', answer: 1500, waitsFor: false },
  ])('waits for $name the action started: $waitsFor', async ({ type, answer, failed, waitsFor }) => {
    const { watchChanges, QUIET_MS } = await import('../changes.js')
    let acted = 0
    const watching = watchChanges(1, async () => {
      acted = Date.now()
      sent('r1', type)
      setTimeout(() => {
        emit(failed ? 'Network.loadingFailed' : 'Network.loadingFinished', { requestId: 'r1' })
        mutations.push(Date.now() + 20)
      }, answer)
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const { changes } = await watching
    if (waitsFor) expect(collectedAt! - acted).toBeGreaterThanOrEqual(answer + 20 + QUIET_MS)
    else expect(collectedAt! - acted).toBeLessThan(answer)
    expect(changes.waitingOn).toBeUndefined()
  })

  it('takes a response as the answer when the page never reads its body', async () => {
    const { watchChanges, QUIET_MS } = await import('../changes.js')
    let acted = 0
    const watching = watchChanges(1, async () => {
      acted = Date.now()
      sent('log', 'Fetch')
      setTimeout(() => {
        emit('Network.responseReceived', { requestId: 'log' })
        mutations.push(Date.now() + 20)
      }, 600)
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const { changes } = await watching
    expect(collectedAt! - acted).toBeGreaterThanOrEqual(600 + 20 + QUIET_MS)
    expect(collectedAt! - acted).toBeLessThan(1500)
    expect(changes.waitingOn).toBeUndefined()
  })

  it('does not wait for a request that was already out before the action', async () => {
    const { watchChanges } = await import('../changes.js')
    let acted = 0
    const watching = watchChanges(1, async () => {
      acted = Date.now()
      setTimeout(() => emit('Network.loadingFinished', { requestId: 'earlier' }), 2000)
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await watching
    expect(collectedAt! - acted).toBeLessThan(1000)
  })

  it('ends at the cap with a request still out, and names it', async () => {
    const { watchChanges, CAP_MS } = await import('../changes.js')
    let acted = 0
    const watching = watchChanges(1, async () => {
      acted = Date.now()
      sent('poll', 'Fetch', 'https://app.test/poll?wait=60')
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const { changes } = await watching
    expect(collectedAt! - acted).toBeGreaterThanOrEqual(CAP_MS)
    expect(changes.waitingOn).toEqual(['GET https://app.test/poll?wait=60'])
    expect(changes.quiet).toBe(false)
  })
})
