import { describe, expect, it } from 'vitest'
import { getUnsupportedDebuggerTargetReason } from '../debug-target.js'

describe('getUnsupportedDebuggerTargetReason', () => {
  const ownExtensionId = 'jpfhnnbdkolfgooefipkolbcehlpkinj'

  it('blocks pages from other extensions before CDP attach', () => {
    expect(
      getUnsupportedDebuggerTargetReason(
        'chrome-extension://bcjindcccaagfpapjjmafapmmgkkhgoa/options.html',
        ownExtensionId,
      ),
    ).toBe('target is a page from another extension')
  })

  it('does not block this extension own pages', () => {
    expect(
      getUnsupportedDebuggerTargetReason(
        `chrome-extension://${ownExtensionId}/options.html`,
        ownExtensionId,
      ),
    ).toBeUndefined()
  })

  it('blocks browser-internal pages', () => {
    expect(
      getUnsupportedDebuggerTargetReason('chrome://extensions', ownExtensionId),
    ).toBe('target is a browser-internal page')
  })

  it('allows normal web pages and unparseable URLs to fall through to Chrome', () => {
    expect(
      getUnsupportedDebuggerTargetReason('https://example.com', ownExtensionId),
    ).toBeUndefined()
    expect(
      getUnsupportedDebuggerTargetReason('about:blank', ownExtensionId),
    ).toBeUndefined()
    expect(
      getUnsupportedDebuggerTargetReason('not a url', ownExtensionId),
    ).toBeUndefined()
    expect(
      getUnsupportedDebuggerTargetReason(undefined, ownExtensionId),
    ).toBeUndefined()
  })
})
