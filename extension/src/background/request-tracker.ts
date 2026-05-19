export interface ActiveRequest {
  requestId: string
  requestedTabId?: number
  resolvedTabId?: number
}

export class ActiveRequestTracker {
  private readonly requests = new Map<string, ActiveRequest>()

  start(requestId: string, requestedTabId?: number): ActiveRequest {
    const request: ActiveRequest = { requestId }
    if (requestedTabId !== undefined) {
      request.requestedTabId = requestedTabId
    }
    this.requests.set(requestId, request)
    return request
  }

  setResolvedTabId(requestId: string, resolvedTabId: number): boolean {
    const request = this.requests.get(requestId)
    if (!request) return false
    request.resolvedTabId = resolvedTabId
    return true
  }

  isActive(requestId: string): boolean {
    return this.requests.has(requestId)
  }

  finish(requestId: string): ActiveRequest | undefined {
    const request = this.requests.get(requestId)
    if (!request) return undefined
    this.requests.delete(requestId)
    return request
  }

  cancelAll(): ActiveRequest[] {
    const requests = Array.from(this.requests.values())
    this.requests.clear()
    return requests
  }

  cancelForTabs(tabIds: Iterable<number>): ActiveRequest[] {
    const tabSet = new Set(tabIds)
    const canceled: ActiveRequest[] = []

    for (const [requestId, request] of this.requests) {
      const matchesResolved =
        request.resolvedTabId !== undefined &&
        tabSet.has(request.resolvedTabId)
      const matchesRequested =
        request.requestedTabId !== undefined &&
        tabSet.has(request.requestedTabId)

      if (matchesResolved || matchesRequested) {
        canceled.push(request)
        this.requests.delete(requestId)
      }
    }

    return canceled
  }

  hasActiveRequestForTab(tabId: number): boolean {
    for (const request of this.requests.values()) {
      if (request.resolvedTabId === tabId) return true
    }
    return false
  }
}
