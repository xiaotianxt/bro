// Reports what an action visibly changed in the main frame, so the caller
// does not sleep a fixed delay and read the page back to find out.
//
// The watch settles when the DOM has been quiet for QUIET_MS, or at CAP_MS.
// A change that starts after a quiet gap longer than QUIET_MS (a slow fetch
// rendering later) is missed; callers use a condition wait for those.
// The extension polls the page's mutation clock: bro tabs are usually in the
// background, where Chrome throttles page timers to about one per second.

export const QUIET_MS = 400
export const CAP_MS = 3000

export interface ChangeReport {
  settledMs: number
  quiet: boolean
  navigated?: string
  navigating?: string
  opened?: string[]
  closed?: string[]
  alerts?: string[]
  added?: string[]
  // Filled in by the act tool from the AX tree: refs inside opened layers.
  controls?: string[]
  moreControls?: string
}

interface Watch {
  url: string
  started: number
  last: number
  observer: MutationObserver
  touched: Set<Node>
  layers: string[]
  alerts: string[]
  // Destination of a navigation that started and has not finished in this document.
  navigating?: string
}

// Serialized into the page: everything below must stay self-contained.
function startWatch(): void {
  const describe = (el: Element | null): string => {
    if (!el || el === document.body || el === document.documentElement) return ''
    const label =
      el.getAttribute('aria-label') ??
      (el.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
    const text = (label || (el as HTMLElement).innerText || '').trim().replace(/\s+/g, ' ')
    const role = el.getAttribute('role') ?? el.tagName.toLowerCase()
    return `${role} "${text.slice(0, 80)}"`
  }
  const shown = (el: Element) =>
    typeof el.checkVisibility === 'function'
      ? el.checkVisibility()
      : el.getBoundingClientRect().width > 0
  const layers = () =>
    [
      ...document.querySelectorAll(
        '[role=dialog],[role=alertdialog],dialog[open],[role=menu],[role=listbox]',
      ),
    ]
      .filter(shown)
      .map(describe)
  const alerts = () =>
    [...document.querySelectorAll('[role=alert],[aria-live=assertive],[aria-invalid=true]')]
      .filter(shown)
      .map((el) =>
        el.getAttribute('aria-invalid') === 'true'
          ? `invalid ${describe(el)}`
          : ((el as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 160),
      )
      .filter(Boolean)
  const scope = globalThis as typeof globalThis & { __broWatch?: Watch }
  scope.__broWatch?.observer.disconnect()
  const now = performance.now()
  const watch: Watch = {
    url: location.href,
    started: now,
    last: now,
    touched: new Set(),
    layers: layers(),
    alerts: alerts(),
    observer: new MutationObserver((records) => {
      watch.last = performance.now()
      for (const record of records) {
        if (record.type === 'characterData') watch.touched.add(record.target)
        for (const node of record.addedNodes) watch.touched.add(node)
      }
    }),
  }
  // Attributes are excluded: animations and class toggles would keep a page
  // from ever settling. Opened/closed layers are compared by query instead.
  watch.observer.observe(document, { subtree: true, childList: true, characterData: true })
  // The Navigation API sees form posts and link clicks before the response
  // arrives; same-document navigations finish with navigatesuccess/error.
  const navigation = (globalThis as { navigation?: EventTarget }).navigation
  navigation?.addEventListener('navigate', (event) => {
    if (scope.__broWatch === watch)
      watch.navigating = (event as Event & { destination: { url: string } }).destination.url
  })
  for (const done of ['navigatesuccess', 'navigateerror'])
    navigation?.addEventListener(done, () => {
      if (scope.__broWatch === watch) delete watch.navigating
    })
  scope.__broWatch = watch
}

// Milliseconds since the last mutation and since the watch started.
function watchAges(): { quiet: number; total: number; navigating: boolean } | null {
  const watch = (globalThis as typeof globalThis & { __broWatch?: Watch }).__broWatch
  if (!watch) return null
  const now = performance.now()
  return { quiet: now - watch.last, total: now - watch.started, navigating: !!watch.navigating }
}

function collectWatch(quietMs: number): ChangeReport | null {
  const scope = globalThis as typeof globalThis & { __broWatch?: Watch }
  const watch = scope.__broWatch
  if (!watch) return null
  watch.observer.disconnect()
  delete scope.__broWatch
  const now = performance.now()
  const describe = (el: Element | null): string => {
    if (!el || el === document.body || el === document.documentElement) return ''
    const label =
      el.getAttribute('aria-label') ??
      (el.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
    const text = (label || (el as HTMLElement).innerText || '').trim().replace(/\s+/g, ' ')
    const role = el.getAttribute('role') ?? el.tagName.toLowerCase()
    return `${role} "${text.slice(0, 80)}"`
  }
  const shown = (el: Element) =>
    typeof el.checkVisibility === 'function'
      ? el.checkVisibility()
      : el.getBoundingClientRect().width > 0
  const layers = [
    ...document.querySelectorAll(
      '[role=dialog],[role=alertdialog],dialog[open],[role=menu],[role=listbox]',
    ),
  ]
    .filter(shown)
    .map(describe)
  const alerts = [
    ...document.querySelectorAll('[role=alert],[aria-live=assertive],[aria-invalid=true]'),
  ]
    .filter(shown)
    .map((el) =>
      el.getAttribute('aria-invalid') === 'true'
        ? `invalid ${describe(el)}`
        : ((el as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 160),
    )
    .filter(Boolean)
  // Visible text of the outermost touched elements, so a re-rendered subtree
  // reports once rather than once per descendant.
  const roots: Element[] = []
  for (const node of watch.touched) {
    const el = node instanceof Element ? node : node.parentElement
    if (!el || !el.isConnected || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue
    if (roots.some((root) => root.contains(el))) continue
    for (let i = roots.length - 1; i >= 0; i--) if (el.contains(roots[i]!)) roots.splice(i, 1)
    roots.push(el)
  }
  const added = [
    ...new Set(
      roots
        .filter(shown)
        .map((el) => ((el as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .map((text) => text.slice(0, 120)),
    ),
  ].slice(0, 5)
  const report: ChangeReport = {
    settledMs: Math.round(now - watch.started),
    quiet: now - watch.last >= quietMs,
  }
  if (location.href !== watch.url) report.navigated = location.href
  else if (watch.navigating) report.navigating = watch.navigating
  const opened = layers.filter((layer) => !watch.layers.includes(layer))
  const closed = watch.layers.filter((layer) => !layers.includes(layer))
  const newAlerts = alerts.filter((alert) => !watch.alerts.includes(alert))
  if (opened.length) report.opened = opened
  if (closed.length) report.closed = closed
  if (newAlerts.length) report.alerts = newAlerts
  if (added.length) report.added = added
  return report
}

export async function watchChanges<T>(
  tabId: number,
  action: () => Promise<T>,
): Promise<{ result: T; changes: ChangeReport }> {
  const started = Date.now()
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'ISOLATED',
    func: startWatch,
  })
  const result = await action()
  const inPage = <A extends unknown[], R>(func: (...args: A) => R, args: A) =>
    chrome.scripting
      .executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func, args })
      .then(([frame]) => frame?.result as Awaited<R> | undefined)
  try {
    for (;;) {
      const ages = await inPage(watchAges, [])
      if (!ages || (ages.quiet >= QUIET_MS && !ages.navigating) || ages.total >= CAP_MS) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(10, QUIET_MS - ages.quiet))))
    }
    const changes = await inPage(collectWatch, [QUIET_MS])
    if (changes) return { result, changes }
  } catch (error) {
    // A cross-document navigation destroys the watch's world mid-collection.
    if (!/Frame with ID 0 was removed|document.*(unloaded|changed)|No frame with id/i.test(String(error)))
      throw error
  }
  // The watched document is gone: the action navigated.
  const tab = await chrome.tabs.get(tabId)
  return {
    result,
    changes: { settledMs: Date.now() - started, quiet: false, navigated: tab.pendingUrl ?? tab.url ?? '' },
  }
}
