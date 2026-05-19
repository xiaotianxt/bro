// Upload tools — file_upload and upload_image

import type { ToolResult } from '@bro/shared'
import { cdpSession } from '../cdp.js'
import { registerTool } from '../tool-registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// CDP response types
interface CaptureScreenshotResult {
  data: string // base64
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function getString(
  args: Record<string, unknown>,
  key: string,
  required: true,
): string
function getString(
  args: Record<string, unknown>,
  key: string,
  required?: false,
): string | undefined
function getString(
  args: Record<string, unknown>,
  key: string,
  required?: boolean,
): string | undefined {
  if (args[key] === undefined) {
    if (required) throw new Error(`"${key}" is required`)
    return undefined
  }
  if (typeof args[key] !== 'string') {
    throw new Error(`"${key}" must be a string`)
  }
  return args[key] as string
}

// ---------------------------------------------------------------------------
// Page-side function: inject a File into a file input element
// This runs in the page's MAIN world, so it must be self-contained.
// ---------------------------------------------------------------------------

type FileInjectResult =
  | { success: true; message: string }
  | { success: false; error: string }

function pageInjectFileIntoInput(
  refId: number,
  fileName: string,
  mimeType: string,
  base64Data: string,
): FileInjectResult {
  type WinWithRefId = Window &
    typeof globalThis & {
      __getElementByRefId?: (refId: number) => Element | null
    }

  const win = window as WinWithRefId
  if (typeof win.__getElementByRefId !== 'function') {
    return {
      success: false,
      error: 'file_upload: content script not loaded (__getElementByRefId not available)',
    }
  }

  const el = win.__getElementByRefId(refId)
  if (!el) {
    return {
      success: false,
      error: `file_upload: element ref_${refId} not found`,
    }
  }

  const tag = el.tagName.toLowerCase()
  if (tag !== 'input') {
    return {
      success: false,
      error: `file_upload: element ref_${refId} is a <${tag}>, expected <input>`,
    }
  }

  const inputEl = el as HTMLInputElement
  if (inputEl.type.toLowerCase() !== 'file') {
    return {
      success: false,
      error: `file_upload: element ref_${refId} is an <input type="${inputEl.type}">, expected type="file"`,
    }
  }

  try {
    // Decode base64 string to binary
    const binaryStr = atob(base64Data)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }

    // Create a File object from the binary data
    const file = new File([bytes], fileName, { type: mimeType })

    // Create a DataTransfer and add the file
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)

    // Assign to the input's files property
    Object.defineProperty(inputEl, 'files', {
      value: dataTransfer.files,
      configurable: true,
      writable: true,
    })

    // Dispatch change and input events so frameworks pick up the change
    inputEl.dispatchEvent(new Event('change', { bubbles: true }))
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))

    return {
      success: true,
      message: `File "${fileName}" injected into input ref_${refId}`,
    }
  } catch (err) {
    return {
      success: false,
      error: `file_upload: failed to inject file — ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Scripting helper — run function in MAIN world with 4 args
// ---------------------------------------------------------------------------

async function executeInPage4<A, B, C, D, T>(
  tabId: number,
  func: (a: A, b: B, c: C, d: D) => T,
  args: [A, B, C, D],
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args,
  })

  const result = results[0]
  if (!result) {
    throw new Error('executeScript returned no results')
  }

  return result.result as T
}

// ---------------------------------------------------------------------------
// Shared helper: inject a file by refId into a file input
// ---------------------------------------------------------------------------

async function injectFile(
  tabId: number,
  refId: string,
  fileName: string,
  mimeType: string,
  base64Data: string,
): Promise<ToolResult> {
  // Parse ref_X format
  const match = refId.match(/^ref_(\d+)$/)
  if (!match) {
    throw new Error(
      `"refId" must be in format "ref_X" (e.g., "ref_42"), got "${refId}"`,
    )
  }
  const refIdNum = parseInt(match[1]!, 10)

  const result = await executeInPage4(
    tabId,
    pageInjectFileIntoInput,
    [refIdNum, fileName, mimeType, base64Data],
  )

  if (!result.success) {
    return {
      content: [{ type: 'text', text: result.error }],
      isError: true,
    } as ToolResult & { isError: true }
  }

  return {
    content: [{ type: 'text', text: result.message }],
  }
}

// ---------------------------------------------------------------------------
// file_upload tool
// ---------------------------------------------------------------------------

async function executeFileUpload(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const refId = getString(args, 'refId', true)
  const fileName = getString(args, 'fileName', true)
  const mimeType = getString(args, 'mimeType', true)
  const data = getString(args, 'data', true)

  return injectFile(tabId, refId, fileName, mimeType, data)
}

// ---------------------------------------------------------------------------
// upload_image tool
// ---------------------------------------------------------------------------

async function executeUploadImage(
  tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null
      ? (rawArgs as Record<string, unknown>)
      : {}

  const refId = getString(args, 'refId', true)
  let screenshotData = getString(args, 'screenshotData')

  // If no screenshot data provided, take a new screenshot
  if (!screenshotData) {
    await cdpSession.ensure(tabId)
    const captured = await cdpSession.send<CaptureScreenshotResult>(
      tabId,
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality: 85,
        captureBeyondViewport: false,
      },
    )
    screenshotData = captured.data
  }

  // Determine mime type from data URI prefix or default to JPEG
  const mimeType = screenshotData.startsWith('data:image/png')
    ? 'image/png'
    : 'image/jpeg'

  // Strip data URI prefix if present (e.g., "data:image/png;base64,...")
  const base64Data = screenshotData.includes(',')
    ? screenshotData.split(',')[1] ?? screenshotData
    : screenshotData

  const fileName = mimeType === 'image/png' ? 'screenshot.png' : 'screenshot.jpg'

  return injectFile(tabId, refId, fileName, mimeType, base64Data)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool('file_upload', executeFileUpload)
registerTool('upload_image', executeUploadImage)
