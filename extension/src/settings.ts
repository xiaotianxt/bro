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
