export const DEFAULT_SERVER_URL = 'ws://127.0.0.1:3500/ws'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function normalizeServerUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim() || DEFAULT_SERVER_URL)
  } catch {
    throw new Error('Server URL must be a valid WebSocket URL')
  }

  if (
    url.protocol !== 'ws:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Server URL must use ws:// with localhost, 127.0.0.1, or [::1]')
  }

  return url.toString()
}

export async function loadServerUrl(): Promise<string> {
  try {
    const items = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL })
    const value = typeof items['serverUrl'] === 'string'
      ? items['serverUrl']
      : DEFAULT_SERVER_URL
    return normalizeServerUrl(value)
  } catch (error) {
    console.warn('[Settings] Invalid stored server URL; using the default:', error)
    return DEFAULT_SERVER_URL
  }
}

export async function loadToken(): Promise<string> {
  const localItems = await chrome.storage.local.get({ token: '' })
  const localToken = typeof localItems['token'] === 'string' ? localItems['token'] : ''

  let syncedToken = ''
  try {
    const syncItems = await chrome.storage.sync.get({ token: '' })
    syncedToken = typeof syncItems['token'] === 'string' ? syncItems['token'] : ''
  } catch (error) {
    console.warn('[Settings] Failed to read the legacy synced token:', error)
  }

  if (localToken !== '') {
    if (syncedToken !== '') {
      await chrome.storage.sync.remove('token')
    }
    return localToken
  }

  if (syncedToken !== '') {
    await chrome.storage.local.set({ token: syncedToken })
    await chrome.storage.sync.remove('token')
  }
  return syncedToken
}

export async function saveSettings(serverUrl: string, token: string): Promise<void> {
  const normalizedUrl = normalizeServerUrl(serverUrl)
  await chrome.storage.local.set({ token })
  await chrome.storage.sync.set({ serverUrl: normalizedUrl })
  await chrome.storage.sync.remove('token')
}

export async function restrictLocalStorageAccess(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
}

// NATIVE_HOST is the native messaging host `bro setup` registers.
export const NATIVE_HOST = 'com.xiaotianxt.bro'

/**
 * Asks bro's native host for the local token, so the user never pastes it.
 * Returns '' when pairing is unavailable — bro predates it, or `bro setup`
 * did not register this browser — leaving the token typed in Options.
 */
export async function pairToken(): Promise<string> {
  let reply: unknown
  try {
    reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'pair' })
  } catch (error) {
    console.info('[Settings] bro native pairing is unavailable:', error)
    return ''
  }
  const token = reply !== null && typeof reply === 'object' && 'token' in reply ? reply.token : undefined
  if (typeof token === 'string' && token !== '') return token
  const message = reply !== null && typeof reply === 'object' && 'error' in reply ? reply.error : reply
  console.warn('[Settings] bro native host did not pair:', message)
  return ''
}

export async function saveToken(token: string): Promise<void> {
  await chrome.storage.local.set({ token })
}

/**
 * Reloads the extension when its folder on disk holds another version than
 * the code running. bro rewrites ~/.bro/extension in place on upgrade, and an
 * unpacked extension runs its old code until it reloads. A folder that was
 * removed reads as no version, which never triggers a reload.
 */
export async function reloadIfUpdatedOnDisk(): Promise<boolean> {
  let onDisk: unknown
  try {
    const response = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })
    onDisk = ((await response.json()) as { version?: unknown }).version
  } catch {
    return false
  }
  if (typeof onDisk !== 'string' || onDisk === chrome.runtime.getManifest().version) return false
  console.log(`[Settings] extension files updated to ${onDisk}; reloading`)
  chrome.runtime.reload()
  return true
}
