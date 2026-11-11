// file_upload: set local files on a file input. The server resolved `paths` to
// absolute regular files on this machine, so the browser reads them itself and
// fires trusted input and change events.

import { sendToFrame } from '../frames.js'
import { registerTool } from '../tool-registry.js'
import { argsObject, callRef, refNode, stringArg } from './accessibility.js'

// Runs in the page, so it must be self-contained.
function fileInputAcceptsMultiple(this: Element): boolean {
  for (let node: Element | null = this; node; node = node.parentElement ?? (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)) {
    if (node.matches(':disabled') || node.hasAttribute('inert')) throw new Error('file_upload: the file input is disabled or inert')
  }
  if (this.tagName.toLowerCase() !== 'input' || (this as HTMLInputElement).type.toLowerCase() !== 'file')
    throw new Error(`file_upload: the ref is a <${this.tagName.toLowerCase()}>, expected <input type="file">`)
  return (this as HTMLInputElement).multiple
}

registerTool('file_upload', async (tabId, rawArgs) => {
  const args = argsObject(rawArgs)
  const refId = stringArg(args, 'refId')
  // The server's file_upload boundary guarantees a non-empty array of canonical paths.
  const paths = args['paths'] as string[]

  // One resolution: check and set the same node, so a navigation in between
  // fails on that node instead of reaching a node from a newer document.
  const node = await refNode(tabId, refId)
  const multiple = await callRef(tabId, refId, node, fileInputAcceptsMultiple)
  if (paths.length > 1 && !multiple)
    throw new Error(`file_upload: the input accepts one file, got ${paths.length}`)
  await sendToFrame(tabId, node.frame, 'DOM.setFileInputFiles', {
    files: paths,
    backendNodeId: node.backendNodeId,
  })
  const names = paths.map((path) => path.split(/[\\/]/).pop()).join(', ')
  return {
    content: [{ type: 'text', text: `Set ${paths.length} file(s): ${names}. Observe the page's ingestion result.` }],
  }
})
