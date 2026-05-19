// Tool registry for the extension service worker.
// Maps tool names to their handler functions.

import type { ToolResult } from '@bro/shared'

/**
 * A tool handler receives a tabId and arbitrary args (validated by the tool
 * itself) and returns a ToolResult or throws on error.
 */
export type ToolHandler = (
  tabId: number,
  args: unknown,
) => Promise<ToolResult>

const registry = new Map<string, ToolHandler>()

/**
 * Registers a tool handler under the given name.
 * Overwrites any previously registered handler with the same name.
 */
export function registerTool(name: string, handler: ToolHandler): void {
  registry.set(name, handler)
}

/**
 * Dispatches a tool call to the registered handler.
 * Throws if no handler is registered for the given name.
 */
export async function dispatchTool(
  name: string,
  tabId: number,
  args: unknown,
): Promise<ToolResult> {
  const handler = registry.get(name)
  if (!handler) {
    throw new Error(`Unknown tool: "${name}"`)
  }
  return handler(tabId, args)
}
