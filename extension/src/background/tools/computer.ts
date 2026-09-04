// Computer tool — handles mouse, keyboard, and screenshot actions via CDP.

import type { ToolResult } from '@bro/shared'
import { cdpSession } from '../cdp.js'
import { registerTool } from '../tool-registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Coordinate = [number, number]

type ScrollDirection = 'up' | 'down' | 'left' | 'right'

type ComputerAction =
  | 'screenshot'
  | 'zoom'
  | 'left_click'
  | 'right_click'
  | 'middle_click'
  | 'double_click'
  | 'triple_click'
  | 'hover'
  | 'scroll'
  | 'left_click_drag'
  | 'type'
  | 'key'

const KNOWN_ACTIONS: ReadonlySet<ComputerAction> = new Set([
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'hover',
  'scroll',
  'left_click_drag',
  'type',
  'key',
])

interface ComputerArgs {
  action: ComputerAction
  coordinate?: Coordinate
  start_coordinate?: Coordinate
  text?: string
  direction?: ScrollDirection
  amount?: number
  region?: [number, number, number, number] // x, y, width, height
  quality?: number
}

// CDP response types
interface CaptureScreenshotResult {
  data: string // base64
}

interface ViewportMetadata {
  width: number
  height: number
  deviceScaleFactor: number
  scrollX: number
  scrollY: number
}

interface ViewportEvaluateResult {
  result: { value?: ViewportMetadata }
}

const DEFAULT_SCREENSHOT_QUALITY = 55
const DEFAULT_ZOOM_QUALITY = 70
const MIN_SCREENSHOT_QUALITY = 10
const MAX_SCREENSHOT_QUALITY = 95

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function isCoordinate(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  )
}

function validateArgs(args: unknown): ComputerArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('computer: args must be an object')
  }

  const a = args as Record<string, unknown>

  if (typeof a['action'] !== 'string') {
    throw new Error('computer: "action" must be a string')
  }

  const action = a['action'] as string
  if (!KNOWN_ACTIONS.has(action as ComputerAction)) {
    throw new Error(`computer: unknown action "${action}"`)
  }

  const validated: ComputerArgs = { action: action as ComputerAction }

  // Validate coordinate if present
  if (a['coordinate'] !== undefined) {
    if (!isCoordinate(a['coordinate'])) {
      throw new Error('computer: "coordinate" must be [number, number]')
    }
    validated.coordinate = a['coordinate']
  }

  // Validate start_coordinate if present
  if (a['start_coordinate'] !== undefined) {
    if (!isCoordinate(a['start_coordinate'])) {
      throw new Error('computer: "start_coordinate" must be [number, number]')
    }
    validated.start_coordinate = a['start_coordinate']
  }

  // Validate text if present
  if (a['text'] !== undefined) {
    if (typeof a['text'] !== 'string') {
      throw new Error('computer: "text" must be a string')
    }
    validated.text = a['text']
  }

  // Validate direction if present
  if (a['direction'] !== undefined) {
    const dir = a['direction']
    if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') {
      throw new Error(
        `computer: "direction" must be one of: up, down, left, right`,
      )
    }
    validated.direction = dir
  }

  // Validate amount if present
  if (a['amount'] !== undefined) {
    if (typeof a['amount'] !== 'number') {
      throw new Error('computer: "amount" must be a number')
    }
    validated.amount = a['amount']
  }

  // Validate region if present
  if (a['region'] !== undefined) {
    const r = a['region']
    if (
      !Array.isArray(r) ||
      r.length !== 4 ||
      r.some((v) => typeof v !== 'number')
    ) {
      throw new Error('computer: "region" must be [x, y, width, height]')
    }
    validated.region = r as [number, number, number, number]
  }

  if (a['quality'] !== undefined) {
    if (
      typeof a['quality'] !== 'number' ||
      !Number.isFinite(a['quality'])
    ) {
      throw new Error('computer: "quality" must be a finite number')
    }
    validated.quality = Math.min(
      MAX_SCREENSHOT_QUALITY,
      Math.max(MIN_SCREENSHOT_QUALITY, Math.round(a['quality'])),
    )
  }

  return validated
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

/**
 * Sends a CDP mouse event to the given tab.
 */
async function dispatchMouseEvent(
  tabId: number,
  type: string,
  x: number,
  y: number,
  button: 'none' | 'left' | 'middle' | 'right' = 'none',
  clickCount = 0,
  deltaX = 0,
  deltaY = 0,
  buttons?: number,
): Promise<void> {
  const resolvedButtons = buttons ?? (
    type === 'mousePressed'
      ? mouseButtonMask(button)
      : type === 'mouseReleased'
        ? 0
        : undefined
  )
  await cdpSession.send(tabId, 'Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button,
    clickCount,
    deltaX,
    deltaY,
    ...(resolvedButtons === undefined ? {} : { buttons: resolvedButtons }),
    modifiers: 0,
  })
}

function mouseButtonMask(button: 'none' | 'left' | 'middle' | 'right'): number {
  switch (button) {
    case 'left': return 1
    case 'right': return 2
    case 'middle': return 4
    case 'none': return 0
  }
}

/**
 * Performs a single click at the given position (move + press + release).
 */
async function singleClick(
  tabId: number,
  x: number,
  y: number,
  button: 'left' | 'middle' | 'right',
  clickCount = 1,
): Promise<void> {
  await dispatchMouseEvent(tabId, 'mouseMoved', x, y)
  await dispatchMouseEvent(tabId, 'mousePressed', x, y, button, clickCount)
  await dispatchMouseEvent(tabId, 'mouseReleased', x, y, button, clickCount)
}

// ---------------------------------------------------------------------------
// Key name mapping
// ---------------------------------------------------------------------------

/**
 * Maps human-readable key names to CDP key codes and key values.
 */
function resolveKey(keyName: string): { key: string; code: string; keyCode: number } {
  const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Return: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
    Home: { key: 'Home', code: 'Home', keyCode: 36 },
    End: { key: 'End', code: 'End', keyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    F1: { key: 'F1', code: 'F1', keyCode: 112 },
    F2: { key: 'F2', code: 'F2', keyCode: 113 },
    F3: { key: 'F3', code: 'F3', keyCode: 114 },
    F4: { key: 'F4', code: 'F4', keyCode: 115 },
    F5: { key: 'F5', code: 'F5', keyCode: 116 },
    F6: { key: 'F6', code: 'F6', keyCode: 117 },
    F7: { key: 'F7', code: 'F7', keyCode: 118 },
    F8: { key: 'F8', code: 'F8', keyCode: 119 },
    F9: { key: 'F9', code: 'F9', keyCode: 120 },
    F10: { key: 'F10', code: 'F10', keyCode: 121 },
    F11: { key: 'F11', code: 'F11', keyCode: 122 },
    F12: { key: 'F12', code: 'F12', keyCode: 123 },
    Space: { key: ' ', code: 'Space', keyCode: 32 },
    CapsLock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
    NumLock: { key: 'NumLock', code: 'NumLock', keyCode: 144 },
    ScrollLock: { key: 'ScrollLock', code: 'ScrollLock', keyCode: 145 },
    PrintScreen: { key: 'PrintScreen', code: 'PrintScreen', keyCode: 44 },
    Pause: { key: 'Pause', code: 'Pause', keyCode: 19 },
  }

  // Check the map first
  const mapped = keyMap[keyName]
  if (mapped) return mapped

  // Single character key (e.g., 'a', 'A', '1')
  if (keyName.length === 1) {
    const charCode = keyName.toUpperCase().charCodeAt(0)
    return { key: keyName, code: `Key${keyName.toUpperCase()}`, keyCode: charCode }
  }

  // Default fallback
  return { key: keyName, code: keyName, keyCode: 0 }
}

/**
 * Parses a key string like 'ctrl+a' into modifier flags and key name.
 * Modifiers bitmask: 1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift
 */
function parseKeyCombo(combo: string): {
  key: string
  code: string
  keyCode: number
  modifiers: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
} {
  const parts = combo.split('+')
  let modifiers = 0
  let altKey = false
  let ctrlKey = false
  let metaKey = false
  let shiftKey = false

  const keyParts: string[] = []
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') {
      modifiers |= 2
      ctrlKey = true
    } else if (lower === 'shift') {
      modifiers |= 8
      shiftKey = true
    } else if (lower === 'alt' || lower === 'option') {
      modifiers |= 1
      altKey = true
    } else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super') {
      modifiers |= 4
      metaKey = true
    } else {
      keyParts.push(part)
    }
  }

  const keyName = keyParts.join('+') || 'Unknown'
  const resolved = resolveKey(keyName)

  return {
    key: resolved.key,
    code: resolved.code,
    keyCode: resolved.keyCode,
    modifiers,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
  }
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

async function readViewportMetadata(tabId: number): Promise<ViewportMetadata> {
  const response = await cdpSession.send<ViewportEvaluateResult>(tabId, 'Runtime.evaluate', {
    expression: '({width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY})',
    returnByValue: true,
  })
  return response.result.value ?? {
    width: 0,
    height: 0,
    deviceScaleFactor: 1,
    scrollX: 0,
    scrollY: 0,
  }
}

function coordinateGuidance(viewport: ViewportMetadata): string {
  return `Viewport ${viewport.width}x${viewport.height} CSS pixels; deviceScaleFactor ${viewport.deviceScaleFactor}. Computer coordinates use CSS pixels from top-left (0,0); divide image-pixel coordinates by ${viewport.deviceScaleFactor} when the screenshot is device-scaled.`
}

async function actionScreenshot(
  tabId: number,
  quality = DEFAULT_SCREENSHOT_QUALITY,
): Promise<ToolResult> {
  const viewport = await readViewportMetadata(tabId)
  const result = await cdpSession.send<CaptureScreenshotResult>(
    tabId,
    'Page.captureScreenshot',
    {
      format: 'jpeg',
      quality,
      captureBeyondViewport: false,
    },
  )

  return {
    content: [
      { type: 'text', text: coordinateGuidance(viewport) },
      {
        type: 'image',
        data: result.data,
        mimeType: 'image/jpeg',
      },
    ],
  }
}

async function actionZoom(
  tabId: number,
  region: [number, number, number, number],
  quality = DEFAULT_ZOOM_QUALITY,
): Promise<ToolResult> {
  const viewport = await readViewportMetadata(tabId)
  const [x, y, width, height] = region
  const clippedResult = await cdpSession.send<CaptureScreenshotResult>(
    tabId,
    'Page.captureScreenshot',
    {
      format: 'jpeg',
      quality,
      captureBeyondViewport: false,
      clip: { x, y, width, height, scale: 1 },
    },
  )

  return {
    content: [
      {
        type: 'text',
        text: `${coordinateGuidance(viewport)} Zoom region: (${x},${y}) ${width}x${height} CSS pixels.`,
      },
      {
        type: 'image',
        data: clippedResult.data,
        mimeType: 'image/jpeg',
      },
    ],
  }
}

async function actionLeftClick(tabId: number, x: number, y: number): Promise<ToolResult> {
  await singleClick(tabId, x, y, 'left', 1)
  return { content: [{ type: 'text', text: `Left clicked at (${x}, ${y})` }] }
}

async function actionRightClick(tabId: number, x: number, y: number): Promise<ToolResult> {
  await singleClick(tabId, x, y, 'right', 1)
  return { content: [{ type: 'text', text: `Right clicked at (${x}, ${y})` }] }
}

async function actionMiddleClick(tabId: number, x: number, y: number): Promise<ToolResult> {
  await singleClick(tabId, x, y, 'middle', 1)
  return { content: [{ type: 'text', text: `Middle clicked at (${x}, ${y})` }] }
}

async function actionDoubleClick(tabId: number, x: number, y: number): Promise<ToolResult> {
  await singleClick(tabId, x, y, 'left', 1)
  await singleClick(tabId, x, y, 'left', 2)
  return { content: [{ type: 'text', text: `Double clicked at (${x}, ${y})` }] }
}

async function actionTripleClick(tabId: number, x: number, y: number): Promise<ToolResult> {
  await singleClick(tabId, x, y, 'left', 1)
  await singleClick(tabId, x, y, 'left', 2)
  await singleClick(tabId, x, y, 'left', 3)
  return { content: [{ type: 'text', text: `Triple clicked at (${x}, ${y})` }] }
}

async function actionHover(tabId: number, x: number, y: number): Promise<ToolResult> {
  await dispatchMouseEvent(tabId, 'mouseMoved', x, y)
  return { content: [{ type: 'text', text: `Hovered at (${x}, ${y})` }] }
}

async function actionScroll(
  tabId: number,
  x: number,
  y: number,
  direction: ScrollDirection,
  amount: number,
): Promise<ToolResult> {
  const PIXELS_PER_UNIT = 120

  let deltaX = 0
  let deltaY = 0

  switch (direction) {
    case 'up':
      deltaY = -amount * PIXELS_PER_UNIT
      break
    case 'down':
      deltaY = amount * PIXELS_PER_UNIT
      break
    case 'left':
      deltaX = -amount * PIXELS_PER_UNIT
      break
    case 'right':
      deltaX = amount * PIXELS_PER_UNIT
      break
  }

  await dispatchMouseEvent(tabId, 'mouseWheel', x, y, 'none', 0, deltaX, deltaY)
  return {
    content: [
      {
        type: 'text',
        text: `Scrolled ${direction} by ${amount} at (${x}, ${y})`,
      },
    ],
  }
}

async function dragMouseEvent(
  stage: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`computer drag ${stage} failed: ${message}`)
  }
}

async function actionLeftClickDrag(
  tabId: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): Promise<ToolResult> {
  const INTERMEDIATE_POINTS = 5

  await dragMouseEvent('move-to-start', () =>
    dispatchMouseEvent(tabId, 'mouseMoved', startX, startY),
  )
  await dragMouseEvent('press', () =>
    dispatchMouseEvent(tabId, 'mousePressed', startX, startY, 'left', 1),
  )

  for (let i = 1; i <= INTERMEDIATE_POINTS; i++) {
    const ratio = i / (INTERMEDIATE_POINTS + 1)
    const ix = Math.round(startX + (endX - startX) * ratio)
    const iy = Math.round(startY + (endY - startY) * ratio)
    await dragMouseEvent(`move-${i}`, () =>
      dispatchMouseEvent(tabId, 'mouseMoved', ix, iy, 'left', 0, 0, 0, 1),
    )
  }

  await dragMouseEvent('move-to-end', () =>
    dispatchMouseEvent(tabId, 'mouseMoved', endX, endY, 'left', 0, 0, 0, 1),
  )
  await dragMouseEvent('release', () =>
    dispatchMouseEvent(tabId, 'mouseReleased', endX, endY, 'left', 1),
  )

  return {
    content: [
      {
        type: 'text',
        text: `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})`,
      },
    ],
  }
}

/**
 * Checks if a character is printable (can be inserted via Input.insertText).
 */
function isPrintableChar(char: string): boolean {
  return char.length === 1 && char.codePointAt(0)! >= 32
}

async function actionType(tabId: number, text: string): Promise<ToolResult> {
  // Split text into printable segments and non-printable chars
  let printable = ''

  for (const char of text) {
    if (isPrintableChar(char)) {
      printable += char
    } else {
      // Flush any accumulated printable text
      if (printable.length > 0) {
        await cdpSession.send(tabId, 'Input.insertText', { text: printable })
        printable = ''
      }

      // Handle special characters via key events
      const charCode = char.charCodeAt(0)
      if (charCode === 9) {
        // Tab
        await dispatchKeyEvent(tabId, 'Tab', 'Tab', 9, 0, false, false, false, false)
      } else if (charCode === 13) {
        // Enter
        await dispatchKeyEvent(tabId, 'Enter', 'Enter', 13, 0, false, false, false, false)
      } else if (charCode === 8) {
        // Backspace
        await dispatchKeyEvent(tabId, 'Backspace', 'Backspace', 8, 0, false, false, false, false)
      }
      // Other non-printable chars are silently skipped
    }
  }

  // Flush remaining printable text
  if (printable.length > 0) {
    await cdpSession.send(tabId, 'Input.insertText', { text: printable })
  }

  return {
    content: [{ type: 'text', text: `Typed: ${JSON.stringify(text)}` }],
  }
}

/**
 * Dispatch a key down + key up pair via CDP.
 */
async function dispatchKeyEvent(
  tabId: number,
  key: string,
  code: string,
  keyCode: number,
  modifiers: number,
  altKey: boolean,
  ctrlKey: boolean,
  metaKey: boolean,
  shiftKey: boolean,
): Promise<void> {
  const commonParams = {
    key,
    code,
    keyCode,
    nativeVirtualKeyCode: keyCode,
    windowsVirtualKeyCode: keyCode,
    modifiers,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
  }

  await cdpSession.send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...commonParams,
  })
  await cdpSession.send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...commonParams,
  })
}

async function actionKey(tabId: number, combo: string): Promise<ToolResult> {
  const parsed = parseKeyCombo(combo)

  await dispatchKeyEvent(
    tabId,
    parsed.key,
    parsed.code,
    parsed.keyCode,
    parsed.modifiers,
    parsed.altKey,
    parsed.ctrlKey,
    parsed.metaKey,
    parsed.shiftKey,
  )

  return {
    content: [{ type: 'text', text: `Key pressed: ${combo}` }],
  }
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function activateTabForInput(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true })
  if (!tab) throw new Error(`computer: tab ${tabId} disappeared while activating input`)
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true })
  }
}

async function executeComputer(tabId: number, rawArgs: unknown): Promise<ToolResult> {
  const args = validateArgs(rawArgs)

  // Screenshots work in background tabs, but Chromium stalls real Input.*
  // dispatch unless both the tab and its window are active.
  if (args.action !== 'screenshot' && args.action !== 'zoom') {
    await activateTabForInput(tabId)
  }
  await cdpSession.ensure(tabId)
  if (args.action !== 'screenshot' && args.action !== 'zoom') {
    await cdpSession.send(tabId, 'Page.bringToFront', {})
  }

  switch (args.action) {
    case 'screenshot':
      return actionScreenshot(tabId, args.quality)

    case 'zoom': {
      const region = args.region ?? [0, 0, 1280, 720]
      return actionZoom(tabId, region, args.quality)
    }

    case 'left_click': {
      if (!args.coordinate) throw new Error('computer: left_click requires "coordinate"')
      const [x, y] = args.coordinate
      return actionLeftClick(tabId, x, y)
    }

    case 'right_click': {
      if (!args.coordinate) throw new Error('computer: right_click requires "coordinate"')
      const [x, y] = args.coordinate
      return actionRightClick(tabId, x, y)
    }

    case 'middle_click': {
      if (!args.coordinate) throw new Error('computer: middle_click requires "coordinate"')
      const [x, y] = args.coordinate
      return actionMiddleClick(tabId, x, y)
    }

    case 'double_click': {
      if (!args.coordinate) throw new Error('computer: double_click requires "coordinate"')
      const [x, y] = args.coordinate
      return actionDoubleClick(tabId, x, y)
    }

    case 'triple_click': {
      if (!args.coordinate) throw new Error('computer: triple_click requires "coordinate"')
      const [x, y] = args.coordinate
      return actionTripleClick(tabId, x, y)
    }

    case 'hover': {
      if (!args.coordinate) throw new Error('computer: hover requires "coordinate"')
      const [x, y] = args.coordinate
      return actionHover(tabId, x, y)
    }

    case 'scroll': {
      if (!args.coordinate) throw new Error('computer: scroll requires "coordinate"')
      if (!args.direction) throw new Error('computer: scroll requires "direction"')
      const [x, y] = args.coordinate
      const amount = args.amount ?? 3
      return actionScroll(tabId, x, y, args.direction, amount)
    }

    case 'left_click_drag': {
      if (!args.start_coordinate) {
        throw new Error('computer: left_click_drag requires "start_coordinate"')
      }
      if (!args.coordinate) {
        throw new Error('computer: left_click_drag requires "coordinate" (end position)')
      }
      const [startX, startY] = args.start_coordinate
      const [endX, endY] = args.coordinate
      return actionLeftClickDrag(tabId, startX, startY, endX, endY)
    }

    case 'type': {
      if (args.text === undefined) throw new Error('computer: type requires "text"')
      return actionType(tabId, args.text)
    }

    case 'key': {
      if (args.text === undefined) throw new Error('computer: key requires "text"')
      return actionKey(tabId, args.text)
    }

    default: {
      // TypeScript exhaustiveness check
      const _: never = args.action
      throw new Error(`computer: unhandled action "${String(_)}"`)
    }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool('computer', executeComputer)
