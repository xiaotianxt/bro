// Serialized into the target's isolated world. No outer runtime dependencies.
export interface ScrollObservation {
  before: { x: number; y: number }
  after: { x: number; y: number }
  requested: { x: number; y: number }
  delta: { x: number; y: number }
  extent: { x: number; y: number }
  moved: boolean
  boundary: boolean | null
  // The frame's document scroller rather than an element box.
  document: boolean
  renderSynchronized: true
}

// Serialized: the element a user scroll at `this` would move along the axis —
// itself or its nearest composed ancestor that overflows on that axis with a
// scrollable overflow style, else the document scroller, else null.
export function scrollerFor(this: Element, direction: string): Element | null {
  const vertical = direction === 'up' || direction === 'down'
  const doc = this.ownerDocument
  const root = doc.scrollingElement
  const overflows = (n: Element): boolean =>
    vertical ? n.scrollHeight > n.clientHeight : n.scrollWidth > n.clientWidth
  for (
    let n: Element | null = this;
    n && n !== root && n !== doc.documentElement;
    n =
      n.parentElement ??
      (n.getRootNode() instanceof ShadowRoot ? (n.getRootNode() as ShadowRoot).host : null)
  ) {
    const style = getComputedStyle(n)
    const overflow = vertical ? style.overflowY : style.overflowX
    // A visible-overflow <html> propagates body's overflow to the viewport,
    // so body is then not a scroll container of its own.
    if (
      n === doc.body &&
      getComputedStyle(doc.documentElement)[vertical ? 'overflowY' : 'overflowX'] === 'visible'
    )
      continue
    // Ancestors with overflow:hidden often overflow by a pixel without being
    // meant to scroll; only the explicit target may be one.
    const scrollable =
      overflow === 'auto' ||
      overflow === 'scroll' ||
      overflow === 'overlay' ||
      (n === this && overflow === 'hidden')
    if (scrollable && overflows(n)) return n
  }
  return root && overflows(root) ? root : null
}

export async function scrollAndObserve(
  this: Element,
  direction: string,
  amount: number,
): Promise<ScrollObservation> {
  const vertical = direction === 'up' || direction === 'down'
  if (vertical ? this.scrollHeight <= this.clientHeight : this.scrollWidth <= this.clientWidth)
    throw new Error('Target is not scrollable on the requested axis')
  const before = { x: this.scrollLeft, y: this.scrollTop }
  const requested = {
    x: direction === 'left' ? -amount : direction === 'right' ? amount : 0,
    y: direction === 'up' ? -amount : direction === 'down' ? amount : 0,
  }
  this.scrollBy({ left: requested.x, top: requested.y, behavior: 'instant' })

  // Activation/visibility is established by the input owner before this call.
  // Scroll events run with rendering, not synchronously with scrollTop updates.
  // Do not synthesize an event, sleep a guessed duration, or replay the scroll.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  if (!this.isConnected)
    throw new Error(
      'Scroll was delivered but the target was replaced; observe fresh refs before continuing',
    )

  const after = { x: this.scrollLeft, y: this.scrollTop }
  const delta = { x: after.x - before.x, y: after.y - before.y }
  // Measure the extent AFTER event handlers: lazy content can extend the range.
  const extent = {
    x: Math.max(0, this.scrollWidth - this.clientWidth),
    y: Math.max(0, this.scrollHeight - this.clientHeight),
  }
  const style = getComputedStyle(this)
  const reverseY = style.display.includes('flex') && style.flexDirection === 'column-reverse'
  const minX = style.direction === 'rtl' ? -extent.x : 0
  const maxX = style.direction === 'rtl' ? 0 : extent.x
  const minY = reverseY ? -extent.y : 0
  const maxY = reverseY ? 0 : extent.y
  const epsilon = 0.5
  // Do not invent a boundary for an exotic writing-mode scroll origin.
  const boundary =
    style.writingMode !== 'horizontal-tb'
      ? null
      : direction === 'up'
        ? after.y <= minY + epsilon
        : direction === 'down'
          ? after.y >= maxY - epsilon
          : direction === 'left'
            ? after.x <= minX + epsilon
            : after.x >= maxX - epsilon
  const moved = Math.abs(delta.x) > epsilon || Math.abs(delta.y) > epsilon
  if (!moved && boundary === false)
    throw new Error(
      'Scroll made no progress away from a boundary; inspect scroll handlers or snap points. No retry was performed.',
    )
  return {
    before,
    after,
    requested,
    delta,
    extent,
    moved,
    boundary,
    document: this === this.ownerDocument.scrollingElement,
    renderSynchronized: true,
  }
}
