import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrollAndObserve } from '../scroll.js'

function fixture(rtl = false, onFrame?: () => void) {
  const element = {
    isConnected: true,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 1300,
    clientWidth: 300,
    scrollHeight: 1000,
    clientHeight: 80,
    scrollBy: vi.fn(({ left, top }: { left: number; top: number }) => {
      element.scrollLeft = Math.max(
        rtl ? -1000 : 0,
        Math.min(rtl ? 0 : 1000, element.scrollLeft + left),
      )
      element.scrollTop = Math.max(
        0,
        Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + top),
      )
    }),
  }
  let first = true
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => {
      if (first) {
        first = false
        onFrame?.()
      }
      callback(0)
    })
    return 1
  })
  vi.stubGlobal('getComputedStyle', () => ({
    direction: rtl ? 'rtl' : 'ltr',
    writingMode: 'horizontal-tb',
    display: 'block',
    flexDirection: 'row',
  }))
  return element
}

afterEach(() => vi.unstubAllGlobals())

describe('observed scroll outcomes', () => {
  it('reports actual offsets and distinguishes a boundary from movement without replaying', async () => {
    const el = fixture()
    const first = await scrollAndObserve.call(el as unknown as Element, 'down', 100)
    expect(first).toMatchObject({
      before: { y: 0 },
      after: { y: 100 },
      delta: { y: 100 },
      moved: true,
      boundary: false,
      renderSynchronized: true,
    })
    expect(el.scrollBy).toHaveBeenCalledTimes(1)
    const end = await scrollAndObserve.call(el as unknown as Element, 'down', 10000)
    expect(end).toMatchObject({ after: { y: 920 }, moved: true, boundary: true })
    const boundary = await scrollAndObserve.call(el as unknown as Element, 'down', 100)
    expect(boundary).toMatchObject({
      before: { y: 920 },
      after: { y: 920 },
      delta: { y: 0 },
      moved: false,
      boundary: true,
    })
  })

  it('measures the range after event-driven content growth, not before it', async () => {
    const el = fixture(false, () => {
      el.scrollHeight += 1000
    })
    const result = await scrollAndObserve.call(el as unknown as Element, 'down', 10000)
    expect(result).toMatchObject({ after: { y: 920 }, extent: { y: 1920 }, boundary: false })
  })

  it('handles RTL negative horizontal offsets', async () => {
    const el = fixture(true)
    const left = await scrollAndObserve.call(el as unknown as Element, 'left', 10000)
    expect(left).toMatchObject({ after: { x: -1000 }, delta: { x: -1000 }, boundary: true })
    const right = await scrollAndObserve.call(el as unknown as Element, 'right', 10000)
    expect(right).toMatchObject({ after: { x: 0 }, boundary: true })
  })

  it('does not present a removed target as a completed observation', async () => {
    const el = fixture(false, () => {
      el.isConnected = false
    })
    await expect(scrollAndObserve.call(el as unknown as Element, 'down', 100)).rejects.toThrow(
      'target was replaced',
    )
    expect(el.scrollBy).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-scrollable axis without modifying the target', async () => {
    const el = fixture()
    el.scrollHeight = el.clientHeight
    await expect(scrollAndObserve.call(el as unknown as Element, 'down', 100)).rejects.toThrow(
      'not scrollable',
    )
    expect(el.scrollBy).not.toHaveBeenCalled()
  })
})
