// Flat CDP child sessions are required for out-of-process (cross-site) frames.
// A session ID is transport state only. Refs retain frame + document identity,
// never a session ID, so detach/re-attach cannot silently retarget an action.
import { cdpSession } from './cdp.js'

export interface BrowserFrame {
  id: string
  parentId?: string
  loaderId: string
  url: string
  name?: string
  sessionId?: string
}
interface FrameTree {
  frame: Omit<BrowserFrame, 'sessionId'>
  childFrames?: FrameTree[]
}
interface AttachedTarget {
  sessionId: string
  targetInfo: { type: string; targetId: string }
}
interface Sessions {
  targets: Map<string, string>
  pending: Set<Promise<void>>
  errors: string[]
}
const tabs = new Map<number, Sessions>()
const autoAttach = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'iframe' }, { exclude: true }],
}
const MAX_FRAMES = 64

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return
  const state = tabs.get(source.tabId)
  if (!state) return
  if (method === 'Target.detachedFromTarget') {
    const id = (params as { sessionId?: string }).sessionId
    if (id) state.targets.delete(id)
  }
  if (method !== 'Target.attachedToTarget') return
  const event = params as AttachedTarget
  if (event.targetInfo.type !== 'iframe') return
  state.targets.set(event.sessionId, event.targetInfo.targetId)
  if (state.targets.size > MAX_FRAMES) {
    state.errors.push(`Frame limit exceeded (${MAX_FRAMES})`)
    return
  }
  // Auto-attach is recursive only when enabled on each child target too.
  const operation = cdpSession
    .sendToSession(source.tabId, event.sessionId, 'Target.setAutoAttach', autoAttach)
    .then(
      () => {},
      (error) => {
        state.errors.push(String(error))
      },
    )
    .finally(() => state.pending.delete(operation))
  state.pending.add(operation)
})
cdpSession.onDetach((tabId) => tabs.delete(tabId))

export async function getBrowserFrames(tabId: number): Promise<BrowserFrame[]> {
  await cdpSession.ensure(tabId)
  let state = tabs.get(tabId)
  if (!state) {
    state = { targets: new Map(), pending: new Set(), errors: [] }
    tabs.set(tabId, state)
    try {
      await cdpSession.send(tabId, 'Target.setAutoAttach', autoAttach)
    } catch (error) {
      tabs.delete(tabId)
      throw error
    }
  }
  while (state.pending.size) await Promise.all([...state.pending])
  if (state.errors.length)
    throw new Error(`Cannot enumerate frame targets: ${state.errors.join('; ')}`)
  const frames = new Map<string, BrowserFrame>()
  const visit = (node: FrameTree, sessionId?: string): void => {
    const previous = frames.get(node.frame.id)
    const parentId = node.frame.parentId ?? previous?.parentId
    frames.set(node.frame.id, {
      ...node.frame,
      ...(parentId === undefined ? {} : { parentId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    })
    for (const child of node.childFrames ?? []) visit(child, sessionId)
  }
  const main = await cdpSession.send<{ frameTree: FrameTree }>(tabId, 'Page.getFrameTree')
  visit(main.frameTree)
  for (const [sessionId] of state.targets) {
    const child = await cdpSession.sendToSession<{ frameTree: FrameTree }>(
      tabId,
      sessionId,
      'Page.getFrameTree',
    )
    visit(child.frameTree, sessionId)
  }
  if (frames.size > MAX_FRAMES)
    throw new Error(`Frame limit exceeded (${MAX_FRAMES}); narrow the page before observing`)
  return [...frames.values()]
}

export function sendToFrame<T>(
  tabId: number,
  frame: BrowserFrame,
  method: string,
  params?: object,
): Promise<T> {
  return cdpSession.sendToSession<T>(tabId, frame.sessionId, method, params)
}
