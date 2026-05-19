// Protocol message types for the WebSocket bridge between
// the Chrome Extension and the MCP Server.
// Zero runtime dependencies — only TypeScript types and type guards.

// ---------------------------------------------------------------------------
// Content types (mirror MCP content types)
// ---------------------------------------------------------------------------

export type TextContent = {
  type: 'text'
  text: string
}

export type ImageContent = {
  type: 'image'
  data: string
  mimeType: string
}

export type ToolResult = {
  content: Array<TextContent | ImageContent>
}

// ---------------------------------------------------------------------------
// Bridge message type constants
// ---------------------------------------------------------------------------

export const BridgeMessageType = {
  // Extension → Server
  CONNECT: 'connect',
  TOOL_RESULT: 'tool_result',
  TOOL_ERROR: 'tool_error',
  PONG: 'pong',
  // Server → Extension
  CONNECTED: 'connected',
  TOOL_CALL: 'tool_call',
  PING: 'ping',
  AGENT_DONE: 'agent_done',
} as const

export type BridgeMessageTypeValue =
  (typeof BridgeMessageType)[keyof typeof BridgeMessageType]

// ---------------------------------------------------------------------------
// Extension → Server messages
// ---------------------------------------------------------------------------

export type BrowserInfo = {
  name: string      // e.g. "Google Chrome", "Microsoft Edge", "Brave", "Chromium"
  version: string   // major version, e.g. "120"
  platform: string  // e.g. "Windows", "macOS", "Linux"
  userAgent: string // full UA string
}

export type ConnectMessage = {
  type: 'connect'
  version: string
  extensionId: string
  instanceId: string
  token: string
  activeTabUrl?: string
  browserInfo?: BrowserInfo
}

export type ToolResultMessage = {
  type: 'tool_result'
  requestId: string
  result: ToolResult
}

export type ToolErrorMessage = {
  type: 'tool_error'
  requestId: string
  error: { message: string }
}

export type PongMessage = {
  type: 'pong'
}

export type ExtensionToServerMessage =
  | ConnectMessage
  | ToolResultMessage
  | ToolErrorMessage
  | PongMessage

// ---------------------------------------------------------------------------
// Server → Extension messages
// ---------------------------------------------------------------------------

export type ConnectedMessage = {
  type: 'connected'
  sessionId: string
}

export type ToolCallMessage = {
  type: 'tool_call'
  requestId: string
  tool: string
  args: Record<string, unknown>
  tabId?: number
}

export type PingMessage = {
  type: 'ping'
}

export type AgentDoneMessage = {
  type: 'agent_done'
  tabIds: number[]
}

export type ServerToExtensionMessage =
  | ConnectedMessage
  | ToolCallMessage
  | PingMessage
  | AgentDoneMessage

// ---------------------------------------------------------------------------
// Status / registry types
// ---------------------------------------------------------------------------

export type ExtensionInfo = {
  id: string
  instanceId: string
  connectedAt: string
  activeTabId?: number
  activeTabUrl?: string
  browserInfo?: BrowserInfo
}

export type StatusResponse = {
  connectedExtensions: ExtensionInfo[]
}

// ---------------------------------------------------------------------------
// Type guards for ExtensionToServerMessage
// ---------------------------------------------------------------------------

export function isConnectMessage(
  msg: ExtensionToServerMessage,
): msg is ConnectMessage {
  return msg.type === BridgeMessageType.CONNECT
}

export function isToolResultMessage(
  msg: ExtensionToServerMessage,
): msg is ToolResultMessage {
  return msg.type === BridgeMessageType.TOOL_RESULT
}

export function isToolErrorMessage(
  msg: ExtensionToServerMessage,
): msg is ToolErrorMessage {
  return msg.type === BridgeMessageType.TOOL_ERROR
}

export function isPongMessage(
  msg: ExtensionToServerMessage,
): msg is PongMessage {
  return msg.type === BridgeMessageType.PONG
}

// ---------------------------------------------------------------------------
// Type guards for ServerToExtensionMessage
// ---------------------------------------------------------------------------

export function isConnectedMessage(
  msg: ServerToExtensionMessage,
): msg is ConnectedMessage {
  return msg.type === BridgeMessageType.CONNECTED
}

export function isToolCallMessage(
  msg: ServerToExtensionMessage,
): msg is ToolCallMessage {
  return msg.type === BridgeMessageType.TOOL_CALL
}

export function isPingMessage(
  msg: ServerToExtensionMessage,
): msg is PingMessage {
  return msg.type === BridgeMessageType.PING
}

export function isAgentDoneMessage(
  msg: ServerToExtensionMessage,
): msg is AgentDoneMessage {
  return msg.type === BridgeMessageType.AGENT_DONE
}

// ---------------------------------------------------------------------------
// Runtime validation helpers
// ---------------------------------------------------------------------------

/**
 * Parses a raw JSON string into an ExtensionToServerMessage.
 * Throws if the message type is unknown.
 */
export function parseExtensionMessage(raw: string): ExtensionToServerMessage {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) {
    throw new Error('Message must be a JSON object')
  }
  const { type } = parsed
  if (typeof type !== 'string') {
    throw new Error('Message must have a string "type" field')
  }
  switch (type) {
    case BridgeMessageType.CONNECT:
      assertString(parsed, 'version')
      assertString(parsed, 'extensionId')
      assertString(parsed, 'instanceId')
      assertString(parsed, 'token')
      return parsed as ConnectMessage
    case BridgeMessageType.TOOL_RESULT:
      assertString(parsed, 'requestId')
      assertToolResult(parsed)
      return parsed as ToolResultMessage
    case BridgeMessageType.TOOL_ERROR:
      assertString(parsed, 'requestId')
      assertErrorObject(parsed)
      return parsed as ToolErrorMessage
    case BridgeMessageType.PONG:
      return { type: 'pong' }
    default:
      throw new Error(`Unknown ExtensionToServer message type: "${type}"`)
  }
}

/**
 * Parses a raw JSON string into a ServerToExtensionMessage.
 * Throws if the message type is unknown.
 */
export function parseServerMessage(raw: string): ServerToExtensionMessage {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) {
    throw new Error('Message must be a JSON object')
  }
  const { type } = parsed
  if (typeof type !== 'string') {
    throw new Error('Message must have a string "type" field')
  }
  switch (type) {
    case BridgeMessageType.CONNECTED:
      assertString(parsed, 'sessionId')
      return parsed as ConnectedMessage
    case BridgeMessageType.TOOL_CALL:
      assertString(parsed, 'requestId')
      assertString(parsed, 'tool')
      assertRecord(parsed, 'args')
      return parsed as ToolCallMessage
    case BridgeMessageType.PING:
      return { type: 'ping' }
    case BridgeMessageType.AGENT_DONE: {
      const tabIds = (parsed['tabIds'] as unknown)
      if (!Array.isArray(tabIds) || !tabIds.every((id) => typeof id === 'number')) {
        throw new Error('agent_done requires a "tabIds" array of numbers')
      }
      return { type: 'agent_done', tabIds: tabIds as number[] }
    }
    default:
      throw new Error(`Unknown ServerToExtension message type: "${type}"`)
  }
}

// ---------------------------------------------------------------------------
// Internal validation helpers (not exported)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertString(obj: Record<string, unknown>, key: string): void {
  if (typeof obj[key] !== 'string') {
    throw new Error(`Expected string field "${key}", got ${typeof obj[key]}`)
  }
}

function assertRecord(obj: Record<string, unknown>, key: string): void {
  if (!isRecord(obj[key])) {
    throw new Error(`Expected object field "${key}"`)
  }
}

function assertToolResult(obj: Record<string, unknown>): void {
  if (!isRecord(obj['result'])) {
    throw new Error('Expected object field "result"')
  }
  const result = obj['result'] as Record<string, unknown>
  if (!Array.isArray(result['content'])) {
    throw new Error('Expected array field "result.content"')
  }
  for (const item of result['content'] as unknown[]) {
    if (!isRecord(item)) {
      throw new Error('Each content item must be an object')
    }
    if (item['type'] === 'text') {
      if (typeof item['text'] !== 'string') {
        throw new Error('TextContent must have a string "text" field')
      }
    } else if (item['type'] === 'image') {
      if (typeof item['data'] !== 'string') {
        throw new Error('ImageContent must have a string "data" field')
      }
      if (typeof item['mimeType'] !== 'string') {
        throw new Error('ImageContent must have a string "mimeType" field')
      }
    } else {
      throw new Error(`Unknown content type: "${String(item['type'])}"`)
    }
  }
}

function assertErrorObject(obj: Record<string, unknown>): void {
  if (!isRecord(obj['error'])) {
    throw new Error('Expected object field "error"')
  }
  const error = obj['error'] as Record<string, unknown>
  if (typeof error['message'] !== 'string') {
    throw new Error('Expected string field "error.message"')
  }
}
