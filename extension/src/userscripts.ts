import { restrictLocalStorageAccess } from './settings.js'

export type InlineUserScriptInput = {
  id: string
  description: string
  matches: string[]
  excludeMatches: string[]
  code: string
  runAt: 'document_start' | 'document_end' | 'document_idle'
  world: 'USER_SCRIPT' | 'MAIN'
  allFrames: boolean
}

export type ManagedUserScript = chrome.userScripts.RegisteredUserScript & {
  description?: string
  enabled?: boolean
}

// Chrome persists dynamic user scripts across browser restarts, but extension
// updates can clear that registry. Keep the source definitions separately so
// a newly loaded service worker can restore them.
const REGISTERED_USER_SCRIPTS_KEY = 'registeredUserScripts'

function userScriptsApi(): typeof chrome.userScripts {
  if (!chrome.userScripts) {
    throw new Error(
      'User scripts are unavailable. Enable Allow User Scripts in the extension settings.',
    )
  }
  return chrome.userScripts
}

function nonEmptyLines(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean)
}

async function loadStoredUserScripts(): Promise<
  ManagedUserScript[] | null
> {
  const items = await chrome.storage.local.get({
    [REGISTERED_USER_SCRIPTS_KEY]: null,
  })
  const scripts = items[REGISTERED_USER_SCRIPTS_KEY]
  if (scripts === null) return null
  if (!Array.isArray(scripts)) {
    throw new Error('Stored user script registry is invalid')
  }
  return scripts as ManagedUserScript[]
}

async function saveStoredUserScripts(
  scripts: ManagedUserScript[],
): Promise<void> {
  await chrome.storage.local.set({ [REGISTERED_USER_SCRIPTS_KEY]: scripts })
}

function mergeUserScripts(
  existing: ManagedUserScript[],
  replacements: ManagedUserScript[],
): ManagedUserScript[] {
  const merged = new Map(existing.map((script) => [script.id, script]))
  for (const script of replacements) {
    const previous = merged.get(script.id)
    merged.set(
      script.id,
      script.description === undefined && previous?.description !== undefined
        ? { ...script, description: previous.description }
        : script,
    )
  }
  return [...merged.values()]
}

function chromeUserScript(
  script: ManagedUserScript,
): chrome.userScripts.RegisteredUserScript {
  const { description, enabled, ...registered } = script
  void description
  void enabled
  return registered
}

export async function restoreUserScripts(): Promise<void> {
  await restrictLocalStorageAccess()
  const stored = await loadStoredUserScripts()
  // A fresh profile has no scripts to restore and needs no optional permission.
  // Still report a real inability to restore a nonempty saved registry.
  if (!chrome.userScripts && (stored === null || stored.length === 0)) return
  const api = userScriptsApi()
  const registered = await api.getScripts()

  if (stored === null) {
    await saveStoredUserScripts(registered)
    return
  }

  const registeredIds = new Set(registered.map((script) => script.id))
  const disabledIds = stored
    .filter((script) => script.enabled === false && registeredIds.has(script.id))
    .map((script) => script.id)
  if (disabledIds.length > 0) await api.unregister({ ids: disabledIds })
  const missing = stored.filter((script) => script.enabled !== false && !registeredIds.has(script.id))
  if (missing.length === 0) return

  try {
    await api.register(missing.map(chromeUserScript))
  } catch (error) {
    const restored = await api.getScripts({ ids: missing.map((script) => script.id) })
    const restoredIds = new Set(restored.map((script) => script.id))
    if (missing.some((script) => !restoredIds.has(script.id))) throw error
  }
}

export function createInlineUserScript(
  input: InlineUserScriptInput,
): ManagedUserScript {
  const id = input.id.trim()
  const description = input.description.trim()
  const matches = nonEmptyLines(input.matches)
  const excludeMatches = nonEmptyLines(input.excludeMatches)
  const code = input.code.trim()

  if (id === '') throw new Error('Script ID is required')
  if (id.startsWith('_')) throw new Error('Script ID cannot start with an underscore')
  if (description === '') throw new Error('Description is required')
  if (matches.length === 0) throw new Error('At least one match pattern is required')
  if (code === '') throw new Error('JavaScript code is required')

  return {
    id,
    description,
    matches,
    excludeMatches,
    js: [{ code }],
    runAt: input.runAt,
    world: input.world,
    allFrames: input.allFrames,
  }
}

export async function listUserScripts(
  ids?: string[],
): Promise<ManagedUserScript[]> {
  await restoreUserScripts()
  const [registered, stored] = await Promise.all([
    userScriptsApi().getScripts(ids === undefined ? undefined : { ids }),
    loadStoredUserScripts(),
  ])
  const descriptions = new Map(
    (stored ?? []).map((script) => [script.id, script.description]),
  )
  return [
    ...registered.map((script) => {
      const description = descriptions.get(script.id)
      return description === undefined ? script : { ...script, description }
    }),
    ...(stored ?? []).filter((script) => script.enabled === false && (ids === undefined || ids.includes(script.id))),
  ]
}

export async function registerUserScripts(
  scripts: ManagedUserScript[],
): Promise<void> {
  await restoreUserScripts()
  const stored = await loadStoredUserScripts()
  for (const script of scripts) {
    if (stored?.some((saved) => saved.id === script.id && saved.enabled === false)) {
      throw new Error(`Script already exists: ${script.id}`)
    }
  }
  const active = scripts.filter((script) => script.enabled !== false)
  if (active.length > 0) await userScriptsApi().register(active.map(chromeUserScript))
  await saveStoredUserScripts(mergeUserScripts(stored ?? [], scripts))
}

export async function updateUserScripts(
  scripts: ManagedUserScript[],
): Promise<void> {
  await restoreUserScripts()
  const stored = await loadStoredUserScripts()
  const updates = scripts.map((script) => {
    const previous = stored?.find((saved) => saved.id === script.id)
    if (!previous) throw new Error(`Unknown script: ${script.id}`)
    const updated = { ...previous, ...script }
    if (previous.enabled === undefined) delete updated.enabled
    else updated.enabled = previous.enabled
    return updated
  })
  const active = updates.filter((script) => script.enabled !== false)
  if (active.length > 0) await userScriptsApi().update(active.map(chromeUserScript))
  await saveStoredUserScripts(mergeUserScripts(stored ?? [], updates))
}

export async function setUserScriptEnabled(id: string, enabled: boolean): Promise<void> {
  await restoreUserScripts()
  const stored = (await loadStoredUserScripts()) ?? []
  const script = stored.find((item) => item.id === id)
  if (!script) throw new Error(`Unknown script: ${id}`)
  if ((script.enabled !== false) === enabled) return

  // Persist intent first: restoration reconciles the browser registry even if
  // the worker stops between storage and the Chrome API call.
  await saveStoredUserScripts(mergeUserScripts(stored, [{ ...script, enabled }]))
  try {
    if (enabled) await userScriptsApi().register([chromeUserScript(script)])
    else await userScriptsApi().unregister({ ids: [id] })
  } catch (error) {
    await saveStoredUserScripts(stored)
    throw error
  }
}

export async function unregisterUserScripts(ids?: string[]): Promise<void> {
  await restoreUserScripts()
  await userScriptsApi().unregister(ids === undefined ? undefined : { ids })
  const stored = await loadStoredUserScripts()
  await saveStoredUserScripts(
    ids === undefined
      ? []
      : (stored ?? []).filter((script) => !ids.includes(script.id)),
  )
}
