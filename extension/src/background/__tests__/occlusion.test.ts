import { beforeEach, describe, expect, it, vi } from 'vitest'

// Runs the real serialized page functions against a minimal fake DOM, so the
// hit-acceptance rules are tested as shipped, not as mocked results.
const mocks = vi.hoisted(() => ({ frames: vi.fn(), send: vi.fn(), input: vi.fn(), SessionClosed: class extends Error {} }))
vi.mock('../frames.js', () => ({ getBrowserFrames: mocks.frames, sendToFrame: mocks.send }))
// render-state.ts owns resuming frozen tabs (tested there); here the page always runs.
vi.mock('../render-state.js', () => ({ inLivePage: (injection: chrome.scripting.ScriptInjection<unknown[], unknown>) => chrome.scripting.executeScript(injection), sinceResumed: () => Infinity }))
vi.mock('../cdp.js', () => ({ CDP_COMMAND_TIMEOUT_MS: 5000, cdpSession: { send: mocks.input }, CdpSessionClosed: mocks.SessionClosed }))
const order = vi.hoisted(() => [] as string[])
vi.mock('../input.js', () => ({
  withInput: async (_tab: number, run: (input: unknown) => unknown) =>
    run({ composited: async () => void order.push('composited') }),
}))
const main = { id: 'main', loaderId: 'doc', url: 'https://example.test' }

class FakeShadowRoot {
  constructor(readonly host: FakeElement) {}
}
class FakeElement {
  parentElement: FakeElement | null = null
  assignedSlot: FakeElement | null = null
  shadowRoot: FakeShadowRoot | null = null
  root: unknown = null
  control: FakeElement | null = null
  isConnected = true
  constructor(
    readonly localName: string,
    readonly ownerDocument: FakeDocument,
    readonly rect = { left: 10, top: 10, right: 50, bottom: 30, width: 40, height: 20 },
  ) {}
  getRootNode(): unknown {
    return this.root ?? this.ownerDocument
  }
  hasAttribute(): boolean {
    return false
  }
  getAttribute(): string | null {
    return null
  }
  matches(): boolean {
    return false
  }
  scrollIntoView(): void {}
  get tagName(): string {
    return this.localName.toUpperCase()
  }
  getBoundingClientRect() {
    return this.rect
  }
}
interface FakeDocument {
  documentElement: FakeElement
  body: FakeElement
  hits: Array<FakeElement | null>
  elementFromPoint: () => FakeElement | null
  defaultView: FakeWindow
}
// Where the browser routes a dispatched press: the target's document, or
// (before a cross-site frame is hit-testable) the parent document instead.
class FakeWindow {
  readonly listeners = new Map<string, Set<(event: { isTrusted: boolean }) => void>>()
  addEventListener(type: string, listener: (event: { isTrusted: boolean }) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener))
  }
  removeEventListener(type: string, listener: (event: { isTrusted: boolean }) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ isTrusted: true })
  }
}
let pressReachesTarget = true

let doc: FakeDocument
let target: FakeElement
const handles = new Map<string, FakeElement>()

function page() {
  doc = { hits: [] } as unknown as FakeDocument
  const html = new FakeElement('html', doc)
  const body = new FakeElement('body', doc)
  body.parentElement = html
  Object.assign(doc, {
    defaultView: new FakeWindow(),
    documentElement: html,
    body,
    // Each hit test consumes the next scripted hit; the last one repeats.
    elementFromPoint: () => (doc.hits.length > 1 ? doc.hits.shift()! : doc.hits[0]!) ?? null,
  })
  target = new FakeElement('button', doc)
  target.parentElement = body
  handles.clear()
  handles.set('node', target)
  return { html, body }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('chrome', { tabs: { onRemoved: { addListener: vi.fn() } } })
  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('ShadowRoot', FakeShadowRoot)
  vi.stubGlobal('HTMLInputElement', class {})
  vi.stubGlobal('HTMLSelectElement', class {})
  vi.stubGlobal('innerWidth', 1000)
  vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', position: 'static' }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0))
    return 1
  })
  pressReachesTarget = true
  order.length = 0
  mocks.input.mockReset().mockImplementation(async (_tab, method, params) => {
    if (method === 'Input.dispatchMouseEvent') order.push(params.type)
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && pressReachesTarget)
      for (const type of ['pointerdown', 'mousedown']) doc.defaultView.dispatch(type)
    return {}
  })
  mocks.frames.mockReset().mockResolvedValue([main])
  mocks.send.mockReset().mockImplementation(async (_tab, _frame, method, params) => {
    if (method === 'Accessibility.getFullAXTree')
      return { nodes: [{ nodeId: '1', backendDOMNodeId: 1, role: { value: 'button' }, name: { value: 'Play' } }] }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } }
    if (method === 'Runtime.callFunctionOn') {
      const fn = new Function(`return (${params.functionDeclaration})`)()
      const value = await fn.apply(
        handles.get(params.objectId),
        (params.arguments ?? []).map((a: { value: unknown }) => a.value),
      )
      if (params.returnByValue !== false) return { result: { value } }
      if (!value) return { result: {} }
      const id = `picked${handles.size}`
      handles.set(id, value)
      return { result: { objectId: id } }
    }
    if (method === 'DOM.describeNode') {
      const element = handles.get(params.objectId)!
      return { node: { backendNodeId: element === target ? 1 : 100 + handles.size, localName: element.localName } }
    }
    return {}
  })
})

async function click() {
  const { readAXPage, refTool } = await import('../tools/accessibility.js')
  const text = (await readAXPage(42, {})).content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  const ref = /\[([a-z]{3}\d+)\]/.exec(text)![1]!
  const outcome = await refTool('click_element', 42, { refId: ref }).then(
    (result) => result.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
    (error: Error) => error.message,
  )
  const clicks = mocks.input.mock.calls.filter(([, method]) => method === 'Input.dispatchMouseEvent')
  return { ref, outcome, clicked: clicks.length > 0, mouse: clicks.map(([, , params]) => params.type as string) }
}

describe('ref click hit testing', () => {
  // Regression (live, password manager): the overlay frame a click's focus
  // draws closes the session at whatever command runs next, often the release.
  it('counts a release on a session Chrome closed as done, since the closure freed the object', async () => {
    page()
    doc.hits = [target]
    const send = mocks.send.getMockImplementation()!
    mocks.send.mockImplementation(async (tab, frame, method, params) => {
      if (method === 'Runtime.releaseObject') throw new mocks.SessionClosed('Chrome closed the debugger session')
      return send(tab, frame, method, params)
    })
    const { ref, outcome, mouse } = await click()
    expect(outcome).toBe(`Clicked ${ref}.`)
    expect(mouse).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('accepts a hit on a descendant, a slotted child, a label or a composed ancestor', async () => {
    for (const arrange of [
      () => {
        const path = new FakeElement('path', doc)
        path.parentElement = target
        return path
      },
      () => {
        const slotted = new FakeElement('span', doc)
        const slot = new FakeElement('slot', doc)
        slot.parentElement = target
        slotted.assignedSlot = slot
        return slotted
      },
      () => {
        const label = new FakeElement('label', doc)
        label.control = target
        return label
      },
      () => {
        const host = new FakeElement('yt-button', doc)
        host.parentElement = doc.body
        target.parentElement = null
        target.root = new FakeShadowRoot(host)
        return host
      },
    ]) {
      vi.resetModules()
      mocks.input.mockClear()
      page()
      doc.hits = [arrange()]
      const { ref, outcome, clicked } = await click()
      expect(outcome).toBe(`Clicked ${ref}.`)
      expect(clicked).toBe(true)
    }
  })

  it('retries the hit test once after rendering before calling the target covered', async () => {
    page()
    const tooltip = new FakeElement('div', doc)
    doc.hits = [tooltip, target]
    const { ref, outcome, clicked } = await click()
    expect(outcome).toBe(`Clicked ${ref}.`)
    expect(clicked).toBe(true)
  })

  it('never reports the target as covering itself', async () => {
    page()
    const tooltip = new FakeElement('div', doc)
    // Both prepare attempts see a transient cover; the diagnosis sees the target.
    doc.hits = [tooltip, tooltip, target]
    const { ref, outcome, clicked } = await click()
    expect(outcome).toBe(`Target ${ref} moved during hit testing; no click dispatched. Retry the click`)
    expect(outcome).not.toContain('covered by')
    expect(clicked).toBe(false)
  })

  it('reports a point that reaches only <html>/<body> as not visible, not covered', async () => {
    const { html, body } = page()
    for (const hit of [html, body, null]) {
      vi.resetModules()
      mocks.input.mockClear()
      doc.hits = [hit]
      const { outcome, clicked } = await click()
      expect(outcome).toMatch(/^Target is not visible at its click point/)
      expect(outcome).not.toContain('covered')
      expect(clicked).toBe(false)
    }
  })

  it('still names a genuine cover and dispatches nothing', async () => {
    page()
    doc.hits = [new FakeElement('input', doc)]
    const { ref, outcome, clicked } = await click()
    expect(outcome).toMatch(new RegExp(`^Target ${ref} is covered by [a-z]{3}\\d+ <input>`))
    expect(clicked).toBe(false)
  })
})

describe('ref click delivery', () => {
  it('waits for a composited frame of the prepared layout before any mouse event', async () => {
    page()
    doc.hits = [target]
    const { ref, outcome } = await click()
    expect(outcome).toBe(`Clicked ${ref}.`)
    expect(order).toEqual(['composited', 'mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('fails a click whose press the browser delivered outside the target document', async () => {
    page()
    doc.hits = [target]
    pressReachesTarget = false
    const { ref, outcome, mouse } = await click()
    expect(outcome).toMatch(new RegExp(`^Click on ${ref} did not reach its document`))
    // The press went somewhere; its release follows so no button stays down.
    expect(mouse).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(doc.defaultView.listeners.get('pointerdown')?.size).toBe(0)
  })
})

describe('ref element state', () => {
  it('reports visibility and disabled state for condition waits', async () => {
    page()
    const { readAXPage, refTool } = await import('../tools/accessibility.js')
    const text = (await readAXPage(42, {})).content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    const ref = /\[([a-z]{3}\d+)\]/.exec(text)![1]!
    const info = async () => {
      const result = await refTool('get_element_info', 42, { refId: ref })
      return JSON.parse(result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')) as {
        visible: boolean
        disabled: boolean
      }
    }
    expect(await info()).toMatchObject({ visible: true, disabled: false })
    Object.assign(target, {
      rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
      matches: (selector: string) => selector === ':disabled',
    })
    expect(await info()).toMatchObject({ visible: false, disabled: true })
    Object.assign(target, {
      rect: { left: 10, top: 10, right: 50, bottom: 30, width: 40, height: 20 },
      matches: () => false,
      checkVisibility: () => false,
      getAttribute: (name: string) => (name === 'aria-disabled' ? 'true' : null),
    })
    expect(await info()).toMatchObject({ visible: false, disabled: true })
  })
})
