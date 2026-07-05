// ChatGPT conversation search — injected into chatgpt.com pages via bro userscripts.
//
// API:
//   window.__broSearch.preload(limit=30)  — start fetching first N conversations in background
//   window.__broSearch.ready()            — check if cache is built
//   window.__broSearch.sync(query, opts)  — sync search (returns null if not cached)
//   window.__broSearch.search(query, opts) — async search (awaits cache if loading)
//   window.__broSearch.fetchRange(start, count) — extend cache to [start, start+count)
//   window.__broSearch.status()           — cache info
//   window.__broSearch.open(conversationId) — navigate current tab to a conversation
//
// Design: range-bounded fetching. preload(30) fetches the 30 most recent
// conversations' full content. sync() searches only what's cached. This
// avoids hammering the server with 169 simultaneous requests.

(function () {
  if (window.__broSearch) return

  // cache.conversations: array of { id, title, createTime, updateTime, text }
  // cache.meta: array of { id, title, create_time, update_time } from list API
  // cache.fetchedIds: Set of conversation IDs already fetched
  // cache.listComplete: true when all metadata has been fetched
  let cache = null
  let fetching = null // Promise for current fetchRange operation

  async function getToken() {
    const r = await fetch('/api/auth/session', { credentials: 'include' })
    const j = await r.json()
    if (!j.accessToken) throw new Error('No accessToken — not logged in?')
    return j.accessToken
  }

  async function fetchConversationList(token, offset, limit) {
    const r = await fetch(
      `/backend-api/conversations?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: 'Bearer ' + token } },
    )
    if (!r.ok) throw new Error(`list failed: ${r.status}`)
    const j = await r.json()
    return j.items || []
  }

  const DELAY_MS = 500 // delay between conversation fetches to avoid 429

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
  }

  async function fetchFullConversation(token, id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`/backend-api/conversation/${id}`, {
        headers: { Authorization: 'Bearer ' + token },
      })
      if (r.ok) return r.json()
      if (r.status === 429) {
        // Rate limited — wait with exponential backoff
        await sleep(DELAY_MS * Math.pow(2, attempt + 1))
        continue
      }
      return null // other errors: skip this conversation
    }
    return null
  }

  function extractText(mapping) {
    if (!mapping) return ''
    let text = ''
    for (const k in mapping) {
      const msg = mapping[k]?.message
      if (!msg?.content) continue
      const ct = msg.content
      if (typeof ct === 'string') text += ' ' + ct
      else if (ct.parts) text += ' ' + ct.parts.filter(p => typeof p === 'string').join(' ')
      else if (ct.text) text += ' ' + ct.text
    }
    return text.trim()
  }

  function ensureCache() {
    if (cache) return
    cache = {
      conversations: [],
      meta: [],
      fetchedIds: new Set(),
      listComplete: false,
      fetchedAt: 0,
    }
  }

  // Fetch conversation metadata list up to [0, totalLimit).
  // Stores into cache.meta. Returns the slice requested.
  async function ensureMetaList(token, totalLimit) {
    if (cache.listComplete) return
    const limit = 100
    while (cache.meta.length < totalLimit) {
      const offset = cache.meta.length
      const items = await fetchConversationList(token, offset, limit)
      if (items.length === 0) {
        cache.listComplete = true
        break
      }
      cache.meta.push(...items)
      if (items.length < limit) {
        cache.listComplete = true
        break
      }
    }
  }

  // Fetch full content for conversations in range [start, start+count).
  // Only fetches IDs not already in cache.fetchedIds.
  // Adds delay between requests to avoid 429 rate limiting.
  async function fetchRange(start, count) {
    if (fetching) return fetching
    ensureCache()

    fetching = (async () => {
      try {
        const token = await getToken()
        await ensureMetaList(token, start + count)
        const slice = cache.meta.slice(start, start + count)
        for (const c of slice) {
          if (cache.fetchedIds.has(c.id)) continue
          const full = await fetchFullConversation(token, c.id)
          cache.fetchedIds.add(c.id)
          if (full) {
            cache.conversations.push({
              id: c.id,
              title: c.title,
              createTime: c.create_time,
              updateTime: c.update_time,
              text: (c.title || '') + ' ' + extractText(full.mapping),
            })
          }
          await sleep(DELAY_MS)
        }
        cache.fetchedAt = Date.now()
      } finally {
        fetching = null
      }
    })()

    return fetching
  }

  function search(query, opts) {
    if (!cache || cache.conversations.length === 0) return null
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (keywords.length === 0) return []
    const limit = opts?.limit || 20
    const results = []
    for (const c of cache.conversations) {
      const lower = c.text.toLowerCase()
      const matched = keywords.filter(kw => lower.includes(kw))
      if (matched.length === 0) continue
      const idx = lower.indexOf(matched[0])
      const snippetStart = Math.max(0, idx - 80)
      const snippet = c.text.slice(snippetStart, snippetStart + 200).replace(/\s+/g, ' ').trim()
      results.push({
        id: c.id,
        title: c.title,
        url: 'https://chatgpt.com/c/' + c.id,
        matched,
        score: matched.length,
        snippet,
      })
    }
    results.sort((a, b) => b.score - a.score || (b.updateTime || 0) - (a.updateTime || 0))
    return results.slice(0, limit)
  }

  const broSearch = {
    // Start fetching the first `limit` conversations in background.
    // Default 30 to avoid hammering the server.
    preload(limit = 30) {
      if (fetching) return { status: 'already loading' }
      void fetchRange(0, limit).catch(e =>
        console.error('[bro-search] preload error:', e),
      )
      return { status: 'preload started', limit }
    },

    // Check if cache is ready.
    ready() {
      return {
        cached: !!cache && cache.conversations.length > 0,
        loading: !!fetching,
        count: cache?.conversations?.length || 0,
        metaCount: cache?.meta?.length || 0,
      }
    },

    // Sync search — returns null if cache not ready, results array otherwise.
    sync(query, opts) {
      return search(query, opts)
    },

    // Async search — awaits any in-progress fetch, then searches.
    async search(query, opts) {
      if (fetching) await fetching
      return search(query, opts)
    },

    // Extend cache: fetch conversations [start, start+count).
    async fetchRange(start, count) {
      await fetchRange(start, count)
      return { fetched: cache.conversations.length }
    },

    // Cache status.
    status() {
      return {
        cached: !!cache,
        conversations: cache?.conversations?.length || 0,
        metaListed: cache?.meta?.length || 0,
        listComplete: cache?.listComplete || false,
        loading: !!fetching,
        ageMs: cache?.fetchedAt ? Date.now() - cache.fetchedAt : null,
      }
    },

    // Navigate current tab to a conversation.
    open(conversationId) {
      const url = 'https://chatgpt.com/c/' + conversationId
      location.href = url
      return url
    },
  }

  window.__broSearch = broSearch
  console.log('[bro-search] injected. Use window.__broSearch.preload(30) then window.__broSearch.sync("query")')
})()