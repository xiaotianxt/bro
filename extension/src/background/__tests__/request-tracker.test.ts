import { describe, expect, it } from 'vitest'
import { ActiveRequestTracker } from '../request-tracker.js'

describe('ActiveRequestTracker', () => {
  it('keeps concurrent requests independent', () => {
    const tracker = new ActiveRequestTracker()

    tracker.start('slow', 7)
    tracker.start('fast', 7)

    expect(tracker.setResolvedTabId('slow', 7)).toBe(true)
    expect(tracker.setResolvedTabId('fast', 7)).toBe(true)

    expect(tracker.finish('fast')?.requestId).toBe('fast')
    expect(tracker.isActive('slow')).toBe(true)
    expect(tracker.hasActiveRequestForTab(7)).toBe(true)

    expect(tracker.finish('slow')?.requestId).toBe('slow')
    expect(tracker.hasActiveRequestForTab(7)).toBe(false)
  })

  it('cancels every active request for Stop', () => {
    const tracker = new ActiveRequestTracker()

    tracker.start('first', 1)
    tracker.start('second', 2)
    tracker.setResolvedTabId('first', 1)
    tracker.setResolvedTabId('second', 2)

    expect(tracker.cancelAll().map((request) => request.requestId)).toEqual([
      'first',
      'second',
    ])
    expect(tracker.isActive('first')).toBe(false)
    expect(tracker.isActive('second')).toBe(false)
    expect(tracker.setResolvedTabId('first', 1)).toBe(false)
  })

  it('cancels requests associated with agent_done tabs', () => {
    const tracker = new ActiveRequestTracker()

    tracker.start('same-tab', 3)
    tracker.start('resolved-tab')
    tracker.start('other-tab', 4)
    tracker.setResolvedTabId('resolved-tab', 3)
    tracker.setResolvedTabId('other-tab', 4)

    expect(
      tracker.cancelForTabs([3]).map((request) => request.requestId),
    ).toEqual(['same-tab', 'resolved-tab'])
    expect(tracker.isActive('same-tab')).toBe(false)
    expect(tracker.isActive('resolved-tab')).toBe(false)
    expect(tracker.isActive('other-tab')).toBe(true)
  })
})
