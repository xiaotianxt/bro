// Comparison arm: the unchanged normal adapter/tool surface, isolated credentials.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { installBroPiExtension } from '../../pi-extension/src/index.ts'
import { BroMcpClient } from '../../pi-extension/src/client.ts'

export default function (pi: ExtensionAPI) {
  const address = process.env.BRO_REFS_MCP_URL
  const settingsPath = process.env.BRO_REFS_SETTINGS_PATH
  if (!address || !settingsPath) throw new Error('Isolated comparison endpoint/settings are required')
  const endpoint = new URL(address)
  if (endpoint.hostname !== '127.0.0.1' || endpoint.port === '3500') throw new Error('Refusing production endpoint')
  installBroPiExtension(pi, { createClient: () => new BroMcpClient({ endpoint, settingsPath }) })
}
