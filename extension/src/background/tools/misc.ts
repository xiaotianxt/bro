// Miscellaneous tools — gif_creator, shortcuts_list, shortcuts_execute

import type { ToolResult } from '@bro/shared'
import { cdpSession } from '../cdp.js'
import { registerTool } from '../tool-registry.js'

// ---------------------------------------------------------------------------
// GIF encoder (lightweight, self-contained)
// Implements GIF89a with LZW compression, supporting animated GIFs.
// ---------------------------------------------------------------------------

/**
 * Write a 16-bit little-endian integer into a DataView.
 */
function writeUint16LE(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true)
}

/**
 * Simple median-cut color quantizer.
 * Reduces an RGBA pixel array to at most 256 colors.
 * Returns a palette of [r, g, b] triplets and a per-pixel index array.
 */
function quantize(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  maxColors = 256,
): { palette: number[][]; indices: Uint8Array } {
  const count = width * height

  // Build initial color frequency map (r,g,b) with reduced precision (5 bits per channel)
  const colorMap = new Map<number, number>()
  for (let i = 0; i < count; i++) {
    const r = (pixels[i * 4]! >> 3) & 0x1f
    const g = (pixels[i * 4 + 1]! >> 3) & 0x1f
    const b = (pixels[i * 4 + 2]! >> 3) & 0x1f
    const key = (r << 10) | (g << 5) | b
    colorMap.set(key, (colorMap.get(key) ?? 0) + 1)
  }

  // Convert to array, sort by frequency descending, take top maxColors
  const colorEntries = Array.from(colorMap.entries())
  colorEntries.sort((a, b) => b[1] - a[1])
  const topColors = colorEntries.slice(0, maxColors)

  // Build palette
  const palette: number[][] = topColors.map(([key]) => {
    const r = ((key >> 10) & 0x1f) << 3
    const g = ((key >> 5) & 0x1f) << 3
    const b = (key & 0x1f) << 3
    return [r, g, b]
  })

  // Pad palette to exactly maxColors entries
  while (palette.length < maxColors) {
    palette.push([0, 0, 0])
  }

  // Assign nearest palette index to each pixel
  const indices = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    const pr = pixels[i * 4]!
    const pg = pixels[i * 4 + 1]!
    const pb = pixels[i * 4 + 2]!

    // Find nearest colour (we do a fast lookup via quantized key)
    const qr = (pr >> 3) & 0x1f
    const qg = (pg >> 3) & 0x1f
    const qb = (pb >> 3) & 0x1f
    const key = (qr << 10) | (qg << 5) | qb

    // Check exact match first (O(1))
    let bestIdx = 0
    let found = false
    for (let j = 0; j < palette.length; j++) {
      const pal = palette[j]!
      if (((pal[0]! >> 3) << 10 | (pal[1]! >> 3) << 5 | (pal[2]! >> 3)) === key) {
        bestIdx = j
        found = true
        break
      }
    }

    if (!found) {
      // Linear nearest search
      let bestDist = Infinity
      for (let j = 0; j < palette.length; j++) {
        const pal = palette[j]!
        const dr = pr - pal[0]!
        const dg = pg - pal[1]!
        const db = pb - pal[2]!
        const dist = dr * dr + dg * dg + db * db
        if (dist < bestDist) {
          bestDist = dist
          bestIdx = j
          if (dist === 0) break
        }
      }
    }

    indices[i] = bestIdx
  }

  return { palette, indices }
}

/**
 * LZW encoder for GIF.
 * Returns the compressed byte stream as a Uint8Array.
 */
function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize
  const eodCode = clearCode + 1

  // Output bit-packer
  const output: number[] = []
  let bitBuf = 0
  let bitCount = 0

  function writeBits(value: number, bits: number): void {
    bitBuf |= value << bitCount
    bitCount += bits
    while (bitCount >= 8) {
      output.push(bitBuf & 0xff)
      bitBuf >>= 8
      bitCount -= 8
    }
  }

  function flush(): void {
    if (bitCount > 0) {
      output.push(bitBuf & 0xff)
      bitBuf = 0
      bitCount = 0
    }
  }

  // LZW compression
  let codeSize = minCodeSize + 1
  let codeTable = new Map<string, number>()
  let nextCode = eodCode + 1

  function resetTable(): void {
    codeTable = new Map<string, number>()
    for (let i = 0; i < clearCode + 2; i++) {
      codeTable.set(String(i), i)
    }
    nextCode = eodCode + 1
    codeSize = minCodeSize + 1
  }

  resetTable()
  writeBits(clearCode, codeSize)

  let indexBuffer = String(indices[0])

  for (let i = 1; i < indices.length; i++) {
    const k = String(indices[i])
    const combined = indexBuffer + ',' + k
    if (codeTable.has(combined)) {
      indexBuffer = combined
    } else {
      writeBits(codeTable.get(indexBuffer)!, codeSize)

      // Add new code
      if (nextCode <= 4095) {
        codeTable.set(combined, nextCode++)
        // If we've exhausted current bit depth, increase (max 12 bits)
        if (nextCode - 1 === (1 << codeSize) && codeSize < 12) {
          codeSize++
        }
      } else {
        // Reset table
        writeBits(clearCode, codeSize)
        resetTable()
      }

      indexBuffer = k
    }
  }

  // Flush remaining
  writeBits(codeTable.get(indexBuffer)!, codeSize)
  writeBits(eodCode, codeSize)
  flush()

  return new Uint8Array(output)
}

/**
 * Encode a sequence of RGBA pixel arrays + their dimensions into an animated GIF.
 * @param frames - array of { pixels: RGBA Uint8ClampedArray, width, height }
 * @param delayMs - delay between frames in milliseconds
 */
function encodeGif(
  frames: Array<{ pixels: Uint8ClampedArray; width: number; height: number }>,
  delayMs: number,
): Uint8Array {
  if (frames.length === 0) {
    throw new Error('gif_creator: no frames to encode')
  }

  const width = frames[0]!.width
  const height = frames[0]!.height
  const delayHundredths = Math.round(delayMs / 10)

  const parts: Uint8Array[] = []

  // GIF header
  const header = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) // GIF89a
  parts.push(header)

  // Logical Screen Descriptor (7 bytes)
  // Width, Height (2 bytes each LE), flags, bgcolor index, pixel aspect
  const lsd = new Uint8Array(7)
  const lsdView = new DataView(lsd.buffer)
  writeUint16LE(lsdView, 0, width)
  writeUint16LE(lsdView, 2, height)
  lsd[4] = 0x00 // no global color table
  lsd[5] = 0x00 // background color index
  lsd[6] = 0x00 // pixel aspect ratio
  parts.push(lsd)

  // Netscape Application Extension (for looping animation)
  const netscapeExt = new Uint8Array([
    0x21, 0xff, // extension introducer + application extension label
    0x0b, // block size = 11
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, // "NETSCAPE"
    0x32, 0x2e, 0x30, // "2.0"
    0x03, // sub-block size
    0x01, // sub-block ID
    0x00, 0x00, // loop count = 0 (infinite)
    0x00, // block terminator
  ])
  parts.push(netscapeExt)

  for (const frame of frames) {
    // Quantize frame to 256 colors
    const { palette, indices } = quantize(frame.pixels, frame.width, frame.height, 256)

    // Graphics Control Extension
    const gce = new Uint8Array([
      0x21, 0xf9, // extension introducer + graphic control label
      0x04, // block size
      0x04, // flags: do not dispose
      0x00, 0x00, // delay (placeholder, fill below)
      0x00, // transparent color index (none)
      0x00, // block terminator
    ])
    const gceView = new DataView(gce.buffer)
    writeUint16LE(gceView, 4, delayHundredths)
    parts.push(gce)

    // Build local color table (always 256 colors = 6 bits → size flag = 7)
    const colorTableSize = 256
    const localColorTable = new Uint8Array(colorTableSize * 3)
    for (let i = 0; i < colorTableSize; i++) {
      localColorTable[i * 3] = palette[i]![0]!
      localColorTable[i * 3 + 1] = palette[i]![1]!
      localColorTable[i * 3 + 2] = palette[i]![2]!
    }

    // Image Descriptor (10 bytes)
    const imgDesc = new Uint8Array(10)
    const imgView = new DataView(imgDesc.buffer)
    imgDesc[0] = 0x2c // image separator
    writeUint16LE(imgView, 1, 0) // left
    writeUint16LE(imgView, 3, 0) // top
    writeUint16LE(imgView, 5, frame.width)
    writeUint16LE(imgView, 7, frame.height)
    // flags: local color table present, size = 7 (256 colors)
    imgDesc[9] = 0x87
    parts.push(imgDesc)

    // Local color table
    parts.push(localColorTable)

    // LZW minimum code size
    const minCodeSize = 8
    const lzwData = lzwEncode(indices, minCodeSize)

    // LZW minimum code size byte
    parts.push(new Uint8Array([minCodeSize]))

    // Pack LZW data into sub-blocks (max 255 bytes each)
    let offset = 0
    while (offset < lzwData.length) {
      const blockSize = Math.min(255, lzwData.length - offset)
      const subBlock = new Uint8Array(1 + blockSize)
      subBlock[0] = blockSize
      subBlock.set(lzwData.subarray(offset, offset + blockSize), 1)
      parts.push(subBlock)
      offset += blockSize
    }

    // Sub-block terminator
    parts.push(new Uint8Array([0x00]))
  }

  // GIF trailer
  parts.push(new Uint8Array([0x3b]))

  // Concatenate all parts
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLength)
  let pos = 0
  for (const part of parts) {
    result.set(part, pos)
    pos += part.length
  }

  return result
}

/**
 * Decodes a base64-encoded JPEG/PNG into an RGBA pixel array using OffscreenCanvas.
 */
async function base64ToRgba(
  base64: string,
): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }> {
  // Create a blob from the base64 data
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  const blob = new Blob([bytes], { type: 'image/jpeg' })
  const bitmap = await createImageBitmap(blob)

  // Scale to GIF-friendly size (max 400px wide to keep GIF size manageable)
  const maxWidth = 400
  let outWidth = bitmap.width
  let outHeight = bitmap.height
  if (outWidth > maxWidth) {
    outHeight = Math.round((outHeight * maxWidth) / outWidth)
    outWidth = maxWidth
  }

  const canvas = new OffscreenCanvas(outWidth, outHeight)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, outWidth, outHeight)
  bitmap.close()

  const imageData = ctx.getImageData(0, 0, outWidth, outHeight)
  return { pixels: imageData.data, width: outWidth, height: outHeight }
}

// ---------------------------------------------------------------------------
// GIF creator state
// ---------------------------------------------------------------------------

interface GifRecordingState {
  frames: string[] // base64-encoded JPEG frames
  intervalId: ReturnType<typeof setInterval>
  fps: number
  tabId: number
}

const gifRecordings = new Map<number, GifRecordingState>()

// CDP response type
interface CaptureScreenshotResult {
  data: string // base64
}

// ---------------------------------------------------------------------------
// gif_creator tool
// ---------------------------------------------------------------------------

type GifAction = 'start' | 'stop' | 'export'

interface GifCreatorArgs {
  action: GifAction
  fps?: number
}

function validateGifCreatorArgs(args: unknown): GifCreatorArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('gif_creator: args must be an object')
  }

  const a = args as Record<string, unknown>

  if (typeof a['action'] !== 'string') {
    throw new Error('gif_creator: "action" must be a string')
  }

  const action = a['action']
  if (action !== 'start' && action !== 'stop' && action !== 'export') {
    throw new Error('gif_creator: "action" must be one of: start, stop, export')
  }

  const result: GifCreatorArgs = { action: action as GifAction }

  if (a['fps'] !== undefined) {
    if (typeof a['fps'] !== 'number' || a['fps'] <= 0) {
      throw new Error('gif_creator: "fps" must be a positive number')
    }
    result.fps = a['fps']
  }

  return result
}

async function captureFrame(tabId: number): Promise<string | null> {
  try {
    await cdpSession.ensure(tabId)
    const result = await cdpSession.send<CaptureScreenshotResult>(
      tabId,
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality: 70, // lower quality for GIF frames to reduce size
        captureBeyondViewport: false,
      },
    )
    return result.data
  } catch {
    return null
  }
}

async function executeGifCreator(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = validateGifCreatorArgs(rawArgs)

  switch (args.action) {
    case 'start': {
      // Stop any existing recording for this tab
      const existing = gifRecordings.get(tabId)
      if (existing) {
        clearInterval(existing.intervalId)
        gifRecordings.delete(tabId)
      }

      const fps = args.fps ?? 2
      const frames: string[] = []

      // Capture first frame immediately
      const firstFrame = await captureFrame(tabId)
      if (firstFrame) {
        frames.push(firstFrame)
      }

      const intervalMs = Math.round(1000 / fps)
      const intervalId = setInterval(() => {
        void captureFrame(tabId).then((frame) => {
          if (frame) {
            const state = gifRecordings.get(tabId)
            if (state) {
              state.frames.push(frame)
            }
          }
        })
      }, intervalMs)

      gifRecordings.set(tabId, { frames, intervalId, fps, tabId })

      return {
        content: [
          {
            type: 'text',
            text: `GIF recording started for tab ${tabId} at ${fps} fps. Use action "stop" to stop recording, "export" to get the GIF.`,
          },
        ],
      }
    }

    case 'stop': {
      const state = gifRecordings.get(tabId)
      if (!state) {
        return {
          content: [
            {
              type: 'text',
              text: `No active GIF recording for tab ${tabId}.`,
            },
          ],
        }
      }

      clearInterval(state.intervalId)

      // Keep frames in map for export (replace intervalId with a no-op)
      gifRecordings.set(tabId, {
        ...state,
        intervalId: 0 as unknown as ReturnType<typeof setInterval>,
      })

      return {
        content: [
          {
            type: 'text',
            text: `GIF recording stopped for tab ${tabId}. Captured ${state.frames.length} frames. Use action "export" to get the GIF.`,
          },
        ],
      }
    }

    case 'export': {
      const state = gifRecordings.get(tabId)
      if (!state || state.frames.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                state
                  ? `No frames captured for tab ${tabId}. Start recording first.`
                  : `No GIF recording found for tab ${tabId}. Use action "start" to begin recording.`,
            },
          ],
        }
      }

      // Stop recording if still running
      if (state.intervalId) {
        clearInterval(state.intervalId)
      }

      const delayMs = Math.round(1000 / state.fps)

      // Decode all frames to RGBA
      const rgbaFrames: Array<{
        pixels: Uint8ClampedArray
        width: number
        height: number
      }> = []

      for (const frameBase64 of state.frames) {
        try {
          const rgba = await base64ToRgba(frameBase64)
          rgbaFrames.push(rgba)
        } catch {
          // Skip frames that fail to decode
        }
      }

      if (rgbaFrames.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to decode any frames for tab ${tabId}.`,
            },
          ],
        }
      }

      // Ensure all frames have same dimensions (use first frame's dimensions)
      const targetWidth = rgbaFrames[0]!.width
      const targetHeight = rgbaFrames[0]!.height

      // Re-scale frames that don't match (can happen if window was resized)
      const normalizedFrames: Array<{
        pixels: Uint8ClampedArray
        width: number
        height: number
      }> = []
      for (const frame of rgbaFrames) {
        if (frame.width === targetWidth && frame.height === targetHeight) {
          normalizedFrames.push(frame)
        } else {
          // Rescale to first frame's dimensions
          const canvas = new OffscreenCanvas(targetWidth, targetHeight)
          const ctx = canvas.getContext('2d')!
          const srcCanvas = new OffscreenCanvas(frame.width, frame.height)
          const srcCtx = srcCanvas.getContext('2d')!
          // Create ImageData with a plain ArrayBuffer copy to satisfy strict type constraints
          const pixelsCopy = new Uint8ClampedArray(frame.pixels)
          srcCtx.putImageData(
            new ImageData(pixelsCopy, frame.width, frame.height),
            0,
            0,
          )
          ctx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight)
          const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight)
          normalizedFrames.push({
            pixels: imageData.data,
            width: targetWidth,
            height: targetHeight,
          })
        }
      }

      // Encode GIF
      const gifData = encodeGif(normalizedFrames, delayMs)

      // Convert to base64
      let binary = ''
      for (let i = 0; i < gifData.length; i++) {
        binary += String.fromCharCode(gifData[i]!)
      }
      const gifBase64 = btoa(binary)

      // Clean up state
      gifRecordings.delete(tabId)

      return {
        content: [
          {
            type: 'image',
            data: gifBase64,
            mimeType: 'image/gif',
          },
        ],
      }
    }

    default: {
      const _: never = args.action
      throw new Error(`gif_creator: unhandled action "${String(_)}"`)
    }
  }
}

// ---------------------------------------------------------------------------
// shortcuts_list tool
// ---------------------------------------------------------------------------

const BROWSER_SHORTCUTS = [
  'Ctrl+T — Open new tab',
  'Ctrl+W — Close current tab',
  'Ctrl+Shift+T — Reopen last closed tab',
  'Ctrl+Tab — Switch to next tab',
  'Ctrl+Shift+Tab — Switch to previous tab',
  'Ctrl+1..9 — Switch to tab by position',
  'Ctrl+L — Focus address bar',
  'Ctrl+R or F5 — Reload page',
  'Ctrl+Shift+R — Hard reload (bypass cache)',
  'Ctrl+F — Find in page',
  'Ctrl+G — Find next occurrence',
  'Ctrl+Shift+G — Find previous occurrence',
  'Ctrl+A — Select all',
  'Ctrl+C — Copy',
  'Ctrl+X — Cut',
  'Ctrl+V — Paste',
  'Ctrl+Z — Undo',
  'Ctrl+Shift+Z or Ctrl+Y — Redo',
  'Ctrl+S — Save page',
  'Ctrl+P — Print page',
  'Ctrl+D — Bookmark current page',
  'Ctrl+H — Open browser history',
  'Ctrl+J — Open downloads',
  'Ctrl+N — New window',
  'Ctrl+Shift+N — New incognito/private window',
  'Ctrl+Plus or Ctrl+= — Zoom in',
  'Ctrl+Minus — Zoom out',
  'Ctrl+0 — Reset zoom',
  'F5 — Reload page',
  'F11 — Toggle full screen',
  'F12 — Open developer tools',
  'Alt+Left — Navigate back',
  'Alt+Right — Navigate forward',
  'Backspace — Navigate back (non-input context)',
  'Escape — Stop loading page',
  'Space — Scroll down',
  'Shift+Space — Scroll up',
  'Home — Scroll to top',
  'End — Scroll to bottom',
  'Ctrl+Home — Scroll to top of page',
  'Ctrl+End — Scroll to bottom of page',
]

async function executeShortcutsList(
  _tabId: number,
  _rawArgs: unknown,
): Promise<ToolResult> {
  const text = BROWSER_SHORTCUTS.join('\n')
  return {
    content: [{ type: 'text', text }],
  }
}

// ---------------------------------------------------------------------------
// shortcuts_execute tool
// ---------------------------------------------------------------------------

/**
 * Maps human-readable key names to CDP key codes and key values.
 * (Mirrors the mapping in computer.ts)
 */
function resolveKey(keyName: string): {
  key: string
  code: string
  keyCode: number
} {
  const keyMap: Record<string, { key: string; code: string; keyCode: number }> =
    {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Return: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
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
      Left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      Right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      Up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      Down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
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
      PrintScreen: {
        key: 'PrintScreen',
        code: 'PrintScreen',
        keyCode: 44,
      },
      Pause: { key: 'Pause', code: 'Pause', keyCode: 19 },
    }

  const mapped = keyMap[keyName]
  if (mapped) return mapped

  // Single character key
  if (keyName.length === 1) {
    const charCode = keyName.toUpperCase().charCodeAt(0)
    return {
      key: keyName,
      code: `Key${keyName.toUpperCase()}`,
      keyCode: charCode,
    }
  }

  // Default fallback
  return { key: keyName, code: keyName, keyCode: 0 }
}

/**
 * Parses a shortcut string like 'Ctrl+A' into modifiers and key info.
 * Modifiers bitmask: 1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift
 */
function parseShortcut(shortcut: string): {
  key: string
  code: string
  keyCode: number
  modifiers: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
} {
  const parts = shortcut.split('+')
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
    } else if (
      lower === 'meta' ||
      lower === 'cmd' ||
      lower === 'command' ||
      lower === 'super'
    ) {
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

/**
 * Dispatches a key down + key up pair via CDP.
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

interface ShortcutsExecuteArgs {
  shortcut: string
}

function validateShortcutsExecuteArgs(args: unknown): ShortcutsExecuteArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('shortcuts_execute: args must be an object')
  }

  const a = args as Record<string, unknown>

  if (typeof a['shortcut'] !== 'string' || a['shortcut'].trim() === '') {
    throw new Error(
      'shortcuts_execute: "shortcut" must be a non-empty string (e.g., "Ctrl+A")',
    )
  }

  return { shortcut: a['shortcut'] as string }
}

async function executeShortcutsExecute(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args = validateShortcutsExecuteArgs(rawArgs)

  // Ensure CDP is attached
  await cdpSession.ensure(tabId)

  const parsed = parseShortcut(args.shortcut)

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
    content: [
      { type: 'text', text: `Shortcut executed: ${args.shortcut}` },
    ],
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool('gif_creator', executeGifCreator)
registerTool('shortcuts_list', executeShortcutsList)
registerTool('shortcuts_execute', executeShortcutsExecute)
