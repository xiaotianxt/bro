import { describe, it, expect } from 'vitest'
import {
  BridgeMessageType,
  isConnectMessage,
  isToolResultMessage,
  isToolErrorMessage,
  isPongMessage,
  isConnectedMessage,
  isToolCallMessage,
  isPingMessage,
  parseExtensionMessage,
  parseServerMessage,
} from '../protocol.js'

// ---------------------------------------------------------------------------
// BridgeMessageType constants
// ---------------------------------------------------------------------------

describe('BridgeMessageType', () => {
  it('has all required extension-to-server message type strings', () => {
    expect(BridgeMessageType.CONNECT).toBe('connect')
    expect(BridgeMessageType.TOOL_RESULT).toBe('tool_result')
    expect(BridgeMessageType.TOOL_ERROR).toBe('tool_error')
    expect(BridgeMessageType.PONG).toBe('pong')
  })

  it('has all required server-to-extension message type strings', () => {
    expect(BridgeMessageType.CONNECTED).toBe('connected')
    expect(BridgeMessageType.TOOL_CALL).toBe('tool_call')
    expect(BridgeMessageType.PING).toBe('ping')
  })
})

// ---------------------------------------------------------------------------
// Type guards — ExtensionToServerMessage
// ---------------------------------------------------------------------------

describe('isConnectMessage', () => {
  it('returns true for a connect message', () => {
    const msg = { type: 'connect' as const, version: '1.0', extensionId: 'abc', instanceId: 'inst-1', token: 'tok' }
    expect(isConnectMessage(msg)).toBe(true)
  })

  it('returns false for a tool_result message', () => {
    const msg = {
      type: 'tool_result' as const,
      requestId: '1',
      result: { content: [] },
    }
    expect(isConnectMessage(msg)).toBe(false)
  })
})

describe('isToolResultMessage', () => {
  it('returns true for a tool_result message', () => {
    const msg = {
      type: 'tool_result' as const,
      requestId: 'req-1',
      result: { content: [{ type: 'text' as const, text: 'hello' }] },
    }
    expect(isToolResultMessage(msg)).toBe(true)
  })

  it('returns false for a connect message', () => {
    const msg = { type: 'connect' as const, version: '1.0', extensionId: 'abc', instanceId: 'inst-1', token: 'tok' }
    expect(isToolResultMessage(msg)).toBe(false)
  })
})

describe('isToolErrorMessage', () => {
  it('returns true for a tool_error message', () => {
    const msg = {
      type: 'tool_error' as const,
      requestId: 'req-2',
      error: { message: 'something went wrong' },
    }
    expect(isToolErrorMessage(msg)).toBe(true)
  })

  it('returns false for a pong message', () => {
    const msg = { type: 'pong' as const }
    expect(isToolErrorMessage(msg)).toBe(false)
  })
})

describe('isPongMessage', () => {
  it('returns true for a pong message', () => {
    expect(isPongMessage({ type: 'pong' })).toBe(true)
  })

  it('returns false for a connect message', () => {
    const msg = { type: 'connect' as const, version: '1.0', extensionId: 'abc', instanceId: 'inst-1', token: 'tok' }
    expect(isPongMessage(msg)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Type guards — ServerToExtensionMessage
// ---------------------------------------------------------------------------

describe('isConnectedMessage', () => {
  it('returns true for a connected message', () => {
    const msg = { type: 'connected' as const, sessionId: 'sess-abc' }
    expect(isConnectedMessage(msg)).toBe(true)
  })

  it('returns false for a ping message', () => {
    expect(isConnectedMessage({ type: 'ping' })).toBe(false)
  })
})

describe('isToolCallMessage', () => {
  it('returns true for a tool_call message', () => {
    const msg = {
      type: 'tool_call' as const,
      requestId: 'r1',
      tool: 'navigate',
      args: { url: 'https://example.com' },
    }
    expect(isToolCallMessage(msg)).toBe(true)
  })

  it('returns false for a connected message', () => {
    const msg = { type: 'connected' as const, sessionId: 'sess-abc' }
    expect(isToolCallMessage(msg)).toBe(false)
  })
})

describe('isPingMessage', () => {
  it('returns true for a ping message', () => {
    expect(isPingMessage({ type: 'ping' })).toBe(true)
  })

  it('returns false for a tool_call message', () => {
    const msg = {
      type: 'tool_call' as const,
      requestId: 'r1',
      tool: 'navigate',
      args: {},
    }
    expect(isPingMessage(msg)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseExtensionMessage
// ---------------------------------------------------------------------------

describe('parseExtensionMessage', () => {
  it('parses a valid connect message', () => {
    const raw = JSON.stringify({ type: 'connect', version: '1.0', extensionId: 'ext-123', instanceId: 'inst-456', token: 'secret' })
    const msg = parseExtensionMessage(raw)
    expect(msg.type).toBe('connect')
    if (isConnectMessage(msg)) {
      expect(msg.version).toBe('1.0')
      expect(msg.extensionId).toBe('ext-123')
      expect(msg.instanceId).toBe('inst-456')
      expect(msg.token).toBe('secret')
    }
  })

  it('parses a tool_result message with text content', () => {
    const raw = JSON.stringify({
      type: 'tool_result',
      requestId: 'req-1',
      result: { content: [{ type: 'text', text: 'done' }] },
    })
    const msg = parseExtensionMessage(raw)
    expect(msg.type).toBe('tool_result')
    if (isToolResultMessage(msg)) {
      expect(msg.requestId).toBe('req-1')
      expect(msg.result.content[0]).toEqual({ type: 'text', text: 'done' })
    }
  })

  it('parses a tool_result message with image content', () => {
    const raw = JSON.stringify({
      type: 'tool_result',
      requestId: 'req-2',
      result: {
        content: [{ type: 'image', data: 'base64data', mimeType: 'image/jpeg' }],
      },
    })
    const msg = parseExtensionMessage(raw)
    expect(msg.type).toBe('tool_result')
    if (isToolResultMessage(msg)) {
      const first = msg.result.content[0]
      expect(first?.type).toBe('image')
      if (first?.type === 'image') {
        expect(first.data).toBe('base64data')
        expect(first.mimeType).toBe('image/jpeg')
      }
    }
  })

  it('parses a tool_error message', () => {
    const raw = JSON.stringify({
      type: 'tool_error',
      requestId: 'req-3',
      error: { message: 'CDP failure' },
    })
    const msg = parseExtensionMessage(raw)
    expect(msg.type).toBe('tool_error')
    if (isToolErrorMessage(msg)) {
      expect(msg.requestId).toBe('req-3')
      expect(msg.error.message).toBe('CDP failure')
    }
  })

  it('parses a pong message', () => {
    const raw = JSON.stringify({ type: 'pong' })
    const msg = parseExtensionMessage(raw)
    expect(msg.type).toBe('pong')
  })

  it('throws on an unknown message type', () => {
    const raw = JSON.stringify({ type: 'unknown_type' })
    expect(() => parseExtensionMessage(raw)).toThrow('Unknown ExtensionToServer message type')
  })

  it('throws when type field is missing', () => {
    const raw = JSON.stringify({ version: '1.0' })
    expect(() => parseExtensionMessage(raw)).toThrow('string "type"')
  })

  it('throws on non-object input', () => {
    expect(() => parseExtensionMessage('"string"')).toThrow('JSON object')
  })

  it('throws when connect message is missing extensionId', () => {
    const raw = JSON.stringify({ type: 'connect', version: '1.0' })
    expect(() => parseExtensionMessage(raw)).toThrow('extensionId')
  })

  it('throws when tool_result result field is missing', () => {
    const raw = JSON.stringify({ type: 'tool_result', requestId: 'r1' })
    expect(() => parseExtensionMessage(raw)).toThrow('result')
  })

  it('throws when tool_result content item has unknown type', () => {
    const raw = JSON.stringify({
      type: 'tool_result',
      requestId: 'r1',
      result: { content: [{ type: 'audio' }] },
    })
    expect(() => parseExtensionMessage(raw)).toThrow('Unknown content type')
  })

  it('throws when tool_error error field is missing', () => {
    const raw = JSON.stringify({ type: 'tool_error', requestId: 'r1' })
    expect(() => parseExtensionMessage(raw)).toThrow('error')
  })
})

// ---------------------------------------------------------------------------
// parseServerMessage
// ---------------------------------------------------------------------------

describe('parseServerMessage', () => {
  it('parses a connected message', () => {
    const raw = JSON.stringify({ type: 'connected', sessionId: 'sess-xyz' })
    const msg = parseServerMessage(raw)
    expect(msg.type).toBe('connected')
    if (isConnectedMessage(msg)) {
      expect(msg.sessionId).toBe('sess-xyz')
    }
  })

  it('parses a tool_call message without tabId', () => {
    const raw = JSON.stringify({
      type: 'tool_call',
      requestId: 'r42',
      tool: 'computer',
      args: { action: 'screenshot' },
    })
    const msg = parseServerMessage(raw)
    expect(msg.type).toBe('tool_call')
    if (isToolCallMessage(msg)) {
      expect(msg.requestId).toBe('r42')
      expect(msg.tool).toBe('computer')
      expect(msg.args).toEqual({ action: 'screenshot' })
      expect(msg.tabId).toBeUndefined()
    }
  })

  it('parses a tool_call message with optional tabId', () => {
    const raw = JSON.stringify({
      type: 'tool_call',
      requestId: 'r43',
      tool: 'navigate',
      args: { url: 'https://example.com' },
      tabId: 42,
    })
    const msg = parseServerMessage(raw)
    if (isToolCallMessage(msg)) {
      expect(msg.tabId).toBe(42)
    }
  })

  it('parses a ping message', () => {
    const raw = JSON.stringify({ type: 'ping' })
    const msg = parseServerMessage(raw)
    expect(msg.type).toBe('ping')
  })

  it('throws on an unknown message type', () => {
    const raw = JSON.stringify({ type: 'mystery' })
    expect(() => parseServerMessage(raw)).toThrow('Unknown ServerToExtension message type')
  })

  it('throws when connected message is missing sessionId', () => {
    const raw = JSON.stringify({ type: 'connected' })
    expect(() => parseServerMessage(raw)).toThrow('sessionId')
  })

  it('throws when tool_call message is missing requestId', () => {
    const raw = JSON.stringify({ type: 'tool_call', tool: 'navigate', args: {} })
    expect(() => parseServerMessage(raw)).toThrow('requestId')
  })

  it('throws when tool_call args is not an object', () => {
    const raw = JSON.stringify({ type: 'tool_call', requestId: 'r1', tool: 'nav', args: 'bad' })
    expect(() => parseServerMessage(raw)).toThrow('args')
  })
})
