import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SentCommand = { method: string; params: Record<string, unknown> }

let commands: SentCommand[]
let detach: ReturnType<typeof vi.fn>
let activateTab: ReturnType<typeof vi.fn>
let focusWindow: ReturnType<typeof vi.fn>
let hangOnMouseInput: boolean

function installChromeMock(): void {
  commands = []
  hangOnMouseInput = false
  detach = vi.fn((_target, callback: () => void) => callback())
  activateTab = vi.fn(async () => ({ id: 42, windowId: 7 }))
  focusWindow = vi.fn(async () => ({ id: 7 }))

  vi.stubGlobal('chrome', {
    runtime: { id: 'bro-extension', lastError: undefined },
    debugger: {
      attach: vi.fn((_target, _version, callback) => callback()),
      detach,
      sendCommand: vi.fn(
        (
          _target: chrome.debugger.Debuggee,
          method: string,
          params: Record<string, unknown>,
        ) => {
          commands.push({ method, params })
          if (hangOnMouseInput && method === 'Input.dispatchMouseEvent') {
            return new Promise(() => {})
          }
          if (method === 'Page.captureScreenshot') {
            return Promise.resolve({ data: 'aW1hZ2U=' })
          }
          if (method === 'Runtime.evaluate') {
            return Promise.resolve({
              result: {
                value: {
                  width: 1280,
                  height: 720,
                  deviceScaleFactor: 2,
                  scrollX: 0,
                  scrollY: 0,
                },
              },
            })
          }
          return Promise.resolve({})
        },
      ),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async () => ({ id: 42, url: 'https://example.test', windowId: 7 })),
      update: activateTab,
    },
    windows: { update: focusWindow },
  })
}

describe('computer input', () => {
  beforeEach(() => {
    vi.resetModules()
    installChromeMock()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the left button held during drag movement', async () => {
    await import('../tools/computer.js')
    const { dispatchTool } = await import('../tool-registry.js')

    await dispatchTool('computer', 42, {
      action: 'left_click_drag',
      start_coordinate: [100, 120],
      coordinate: [400, 320],
    })

    expect(activateTab).toHaveBeenCalledWith(42, { active: true })
    expect(focusWindow).toHaveBeenCalledWith(7, { focused: true })
    expect(commands[0]?.method).toBe('Page.bringToFront')
    const events = commands
      .filter((command) => command.method === 'Input.dispatchMouseEvent')
      .map((command) => command.params)
    const pressed = events.find((event) => event['type'] === 'mousePressed')
    const released = events.find((event) => event['type'] === 'mouseReleased')
    const dragMoves = events.slice(
      events.findIndex((event) => event['type'] === 'mousePressed') + 1,
      events.findIndex((event) => event['type'] === 'mouseReleased'),
    )

    expect(pressed?.['buttons']).toBe(1)
    expect(released?.['buttons']).toBe(0)
    expect(dragMoves.length).toBeGreaterThan(1)
    expect(dragMoves.every((event) => event['buttons'] === 1)).toBe(true)
    expect(dragMoves.every((event) => event['button'] === 'left')).toBe(true)
  })

  it('returns the screenshot coordinate space before the image', async () => {
    await import('../tools/computer.js')
    const { dispatchTool } = await import('../tool-registry.js')

    const result = await dispatchTool('computer', 42, { action: 'screenshot' })

    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Viewport 1280x720 CSS pixels; deviceScaleFactor 2. Computer coordinates use CSS pixels from top-left (0,0); divide image-pixel coordinates by 2 when the screenshot is device-scaled.',
    })
    expect(result.content[1]).toEqual({
      type: 'image',
      data: 'aW1hZ2U=',
      mimeType: 'image/jpeg',
    })
  })

  it('times out a stuck CDP input and detaches the debugger', async () => {
    vi.useFakeTimers()
    hangOnMouseInput = true
    await import('../tools/computer.js')
    const { dispatchTool } = await import('../tool-registry.js')

    const operation = dispatchTool('computer', 42, {
      action: 'left_click',
      coordinate: [10, 10],
    })
    const outcome = Promise.race([
      operation.then(() => 'resolved', () => 'rejected'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 6_000)),
    ])
    await vi.advanceTimersByTimeAsync(6_000)

    expect(await outcome).toBe('rejected')
    expect(detach).toHaveBeenCalled()
  })
})
