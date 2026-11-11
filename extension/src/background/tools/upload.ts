// file_upload: give local files to a page the way a user does, through the
// control they click to pick files or by dragging the files onto the page.
// Pages hide or create the file input on demand, so the caller may name the
// visible control (by ref, or by coordinate when it has none) instead of the
// input. A ref to the input itself is filled directly: the node is known, and
// a pointer click into a cross-site frame does not reliably activate it.
// The server resolved `paths` to absolute regular files on this machine; the
// browser reads them itself and fires trusted events.
import { cdpSession } from '../cdp.js'
import { withFileChooser } from '../dialogs.js'
import { withInput } from '../input.js'
import { registerTool } from '../tool-registry.js'
import { sendToFrame } from '../frames.js'
import { argsObject, prepareRefInput, refNode, withRef } from './accessibility.js'
import { isCoordinate, leftClick } from './computer.js'

// A chooser opens synchronously from the click handler; the slack covers pages
// that open it after a short async step.
const CHOOSER_TIMEOUT_MS = 3_000

// Runs in the page: the chooser mode of an enabled file input, or null for any
// other element.
function fileInputMode(this: Element): 'selectSingle' | 'selectMultiple' | null {
  if (!(this instanceof this.ownerDocument.defaultView!.HTMLInputElement) || this.type !== 'file') return null
  if (this.disabled) throw new Error('file_upload: the file input is disabled')
  return this.multiple ? 'selectMultiple' : 'selectSingle'
}

registerTool('file_upload', async (tabId, rawArgs) => {
  const args = argsObject(rawArgs)
  const { refId, coordinate, drop = false } = args
  if ((refId === undefined) === (coordinate === undefined))
    throw new Error('file_upload: give exactly one of "refId" or "coordinate"')
  let ref: string | undefined, at: [number, number] | undefined
  if (refId !== undefined) {
    if (typeof refId !== 'string' || !refId) throw new Error('file_upload: "refId" must be a nonempty string')
    ref = refId
  } else {
    if (!isCoordinate(coordinate)) throw new Error('file_upload: "coordinate" must be [number, number]')
    at = coordinate
  }
  if (typeof drop !== 'boolean') throw new Error('file_upload: "drop" must be a boolean')
  // The server's file_upload boundary guarantees a non-empty array of canonical paths.
  const paths = args['paths'] as string[]
  const target = ref ?? `(${at![0]}, ${at![1]})`
  const names = paths.map((path) => path.split(/[\\/]/).pop()).join(', ')
  // A real pointer, not element.click(): upload libraries ignore untrusted clicks.
  const point = async (): Promise<[number, number]> => {
    if (ref === undefined) return at!
    const prepared = await prepareRefInput(tabId, ref)
    return [prepared.x, prepared.y]
  }

  if (ref !== undefined && !drop) {
    const input = await withRef(tabId, ref, fileInputMode)
    if (input) {
      if (paths.length > 1 && input === 'selectSingle')
        throw new Error(`file_upload: the input accepts one file, got ${paths.length}`)
      const node = await refNode(tabId, ref)
      await sendToFrame(tabId, node.frame, 'DOM.setFileInputFiles', { files: paths, backendNodeId: node.backendNodeId })
      return { content: [{ type: 'text', text: `Set ${paths.length} file(s) on ${ref}: ${names}. Observe the page's ingestion result.` }] }
    }
  }

  if (drop) {
    await withInput(tabId, async () => {
      const [x, y] = await point()
      const data = { items: [], files: paths, dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop'])
        await cdpSession.send(tabId, 'Input.dispatchDragEvent', { type, x, y, data })
    })
    return { content: [{ type: 'text', text: `Dropped ${paths.length} file(s) on ${target}: ${names}. Observe the page's ingestion result.` }] }
  }

  const chooser = await withFileChooser(
    tabId,
    () => withInput(tabId, async () => leftClick(tabId, await point())),
    CHOOSER_TIMEOUT_MS,
  )
  if (!chooser)
    throw new Error(
      `file_upload: clicking ${target} opened no file chooser within ${CHOOSER_TIMEOUT_MS / 1000}s. ` +
        'Target the button, drop zone, or file input a user clicks to pick files; if a menu must open ' +
        'first, click it, then target the item inside it. A page that takes files only by drag and drop needs drop: true.',
    )
  if (chooser.backendNodeId === undefined)
    throw new Error(
      'file_upload: the page asked through showOpenFilePicker, which has no file input to fill; ' +
        'drop the files on its drop area instead (drop: true)',
    )
  if (paths.length > 1 && chooser.mode === 'selectSingle')
    throw new Error(`file_upload: the page asked for one file, got ${paths.length}`)
  await cdpSession.sendToSession(tabId, chooser.sessionId, 'DOM.setFileInputFiles', {
    files: paths,
    backendNodeId: chooser.backendNodeId,
  })
  return { content: [{ type: 'text', text: `Clicked ${target} and chose ${paths.length} file(s): ${names}. Observe the page's ingestion result.` }] }
})
