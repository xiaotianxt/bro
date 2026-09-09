// Acceptance-only configuration: real adapter, isolated endpoint, no fallback tools.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { installBroPiExtension } from '../../pi-extension/src/index.ts'
import { BroMcpClient } from '../../pi-extension/src/client.ts'

export default function (pi: ExtensionAPI) {
  const value = process.env.BRO_REFS_MCP_URL
  if (!value) throw new Error('BRO_REFS_MCP_URL is required for isolated acceptance')
  const endpoint = new URL(value)
  if (endpoint.hostname !== '127.0.0.1' || endpoint.port === '3500') {
    throw new Error('Ref acceptance must not use the installed/default bro endpoint')
  }
  const settingsPath = process.env.BRO_REFS_SETTINGS_PATH
  if (!settingsPath)
    throw new Error('BRO_REFS_SETTINGS_PATH is required; do not use production credentials')
  installBroPiExtension(pi, { createClient: () => new BroMcpClient({ endpoint, settingsPath }) })
  const allowed = new Set([
    'bro_browser_flow_start',
    'bro_browser_flow_observe',
    'bro_browser_flow_act',
    'bro_browser_flow_finish',
  ])
  pi.on('tool_call', (event) => {
    if (!allowed.has(event.toolName))
      return { block: true, reason: 'Acceptance permits only the four flow tools.' }
    if (event.toolName !== 'bro_browser_flow_act') return
    const steps = event.input.steps as Array<Record<string, unknown>>
    if (
      steps.some(
        (step) =>
          step.type === 'eval' ||
          step.css !== undefined ||
          step.frameId !== undefined ||
          step.code !== undefined,
      )
    ) {
      return {
        block: true,
        reason: 'Acceptance requires snapshot refs: no JS, CSS, or manual frame targeting.',
      }
    }
  })
}
