// User script management via chrome.userScripts API (Chrome 120+).
// Provides register, unregister, and list operations for persistent
// user scripts that auto-inject on matching pages.

import type { ToolResult } from '@bro/shared'
import { registerTool } from '../tool-registry.js'

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

function ensureUserScriptsAvailable(): void {
  if (!chrome.userScripts) {
    throw new Error(
      'chrome.userScripts is not available. The "userScripts" permission ' +
        'must be declared in manifest.json and the "Allow User Scripts" toggle ' +
        'must be enabled in chrome://extensions for the bro extension.',
    )
  }
  try {
    chrome.userScripts.getScripts()
  } catch {
    throw new Error(
      'chrome.userScripts API is not enabled. Enable the "Allow User Scripts" toggle ' +
        'in chrome://extensions for the bro extension.',
    )
  }
}

// ---------------------------------------------------------------------------
// Script source validation
// ---------------------------------------------------------------------------

interface ScriptSource {
  code?: string
  file?: string
}

function validateScriptSource(source: unknown): ScriptSource {
  if (typeof source !== 'object' || source === null) {
    throw new Error('userscripts: each js entry must be an object')
  }
  const s = source as Record<string, unknown>
  if (typeof s['code'] === 'string') return { code: s['code'] }
  if (typeof s['file'] === 'string') return { file: s['file'] }
  throw new Error(
    'userscripts: each js entry must have either "code" (inline string) or "file" (path)',
  )
}

// ---------------------------------------------------------------------------
// userscripts_register
// ---------------------------------------------------------------------------

interface UserscriptsRegisterArgs {
  scripts: Array<{
    id: string
    matches: string[]
    js: Array<{ code?: string; file?: string }>
    runAt?: 'document_start' | 'document_end' | 'document_idle'
    allFrames?: boolean
    excludeMatches?: string[]
    world?: 'USER_SCRIPT' | 'MAIN'
  }>
}

function validateRegisterArgs(args: unknown): UserscriptsRegisterArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('userscripts_register: args must be an object')
  }
  const a = args as Record<string, unknown>
  if (!Array.isArray(a['scripts']) || a['scripts'].length === 0) {
    throw new Error(
      'userscripts_register: "scripts" must be a non-empty array',
    )
  }
  for (let i = 0; i < (a['scripts'] as unknown[]).length; i++) {
    const script = (a['scripts'] as unknown[])[i]
    if (typeof script !== 'object' || script === null) {
      throw new Error(
        `userscripts_register: scripts[${i}] must be an object`,
      )
    }
    const s = script as Record<string, unknown>
    if (typeof s['id'] !== 'string' || s['id'] === '') {
      throw new Error(
        `userscripts_register: scripts[${i}].id must be a non-empty string`,
      )
    }
    if (!Array.isArray(s['matches']) || s['matches'].length === 0) {
      throw new Error(
        `userscripts_register: scripts[${i}].matches must be a non-empty array of URL patterns`,
      )
    }
    if (!Array.isArray(s['js']) || s['js'].length === 0) {
      throw new Error(
        `userscripts_register: scripts[${i}].js must be a non-empty array`,
      )
    }
    for (let j = 0; j < (s['js'] as unknown[]).length; j++) {
      validateScriptSource((s['js'] as unknown[])[j])
    }
    if (
      s['runAt'] !== undefined &&
      s['runAt'] !== 'document_start' &&
      s['runAt'] !== 'document_end' &&
      s['runAt'] !== 'document_idle'
    ) {
      throw new Error(
        `userscripts_register: scripts[${i}].runAt must be one of: document_start, document_end, document_idle`,
      )
    }
    if (
      s['world'] !== undefined &&
      s['world'] !== 'USER_SCRIPT' &&
      s['world'] !== 'MAIN'
    ) {
      throw new Error(
        `userscripts_register: scripts[${i}].world must be one of: USER_SCRIPT, MAIN`,
      )
    }
  }
  return a as unknown as UserscriptsRegisterArgs
}

async function executeUserscriptsRegister(
  _tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  ensureUserScriptsAvailable()
  const args = validateRegisterArgs(rawArgs)
  await chrome.userScripts.register(
    args.scripts.map((s) => ({
      id: s.id,
      matches: s.matches,
      js: s.js.map((j) => (j.code ? { code: j.code } : { file: j.file! })),
      runAt: s.runAt,
      allFrames: s.allFrames,
      excludeMatches: s.excludeMatches,
      world: s.world,
    })),
  )
  const ids = args.scripts.map((s) => s.id).join(', ')
  return {
    content: [
      { type: 'text', text: `Registered ${args.scripts.length} user script(s): ${ids}` },
    ],
  }
}

// ---------------------------------------------------------------------------
// userscripts_unregister
// ---------------------------------------------------------------------------

interface UserscriptsUnregisterArgs {
  ids?: string[]
}

function validateUnregisterArgs(args: unknown): UserscriptsUnregisterArgs {
  if (typeof args !== 'object' || args === null) {
    return {} // unregister all
  }
  const a = args as Record<string, unknown>
  if (a['ids'] === undefined) return {}
  if (!Array.isArray(a['ids'])) {
    throw new Error('userscripts_unregister: "ids" must be an array of strings')
  }
  return { ids: a['ids'] as string[] }
}

async function executeUserscriptsUnregister(
  _tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  ensureUserScriptsAvailable()
  const args = validateUnregisterArgs(rawArgs)
  const filter = args.ids ? { ids: args.ids } : undefined
  await chrome.userScripts.unregister(filter)
  const desc = args.ids ? args.ids.join(', ') : 'all'
  return {
    content: [{ type: 'text', text: `Unregistered user script(s): ${desc}` }],
  }
}

// ---------------------------------------------------------------------------
// userscripts_list
// ---------------------------------------------------------------------------

interface UserscriptsListArgs {
  ids?: string[]
}

function validateListArgs(args: unknown): UserscriptsListArgs {
  if (typeof args !== 'object' || args === null) return {}
  const a = args as Record<string, unknown>
  if (a['ids'] === undefined) return {}
  if (!Array.isArray(a['ids'])) {
    throw new Error('userscripts_list: "ids" must be an array of strings')
  }
  return { ids: a['ids'] as string[] }
}

async function executeUserscriptsList(
  _tabId: number,
  rawArgs: unknown,
): Promise<ToolResult> {
  ensureUserScriptsAvailable()
  const args = validateListArgs(rawArgs)
  const scripts = await chrome.userScripts.getScripts(
    args.ids ? { ids: args.ids } : undefined,
  )
  if (scripts.length === 0) {
    return { content: [{ type: 'text', text: 'No user scripts registered.' }] }
  }
  const summary = scripts
    .map((s) => `${s.id}: matches=${JSON.stringify(s.matches)}, runAt=${s.runAt ?? 'document_idle'}`)
    .join('\n')
  return { content: [{ type: 'text', text: summary }] }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerTool('userscripts_register', executeUserscriptsRegister)
registerTool('userscripts_unregister', executeUserscriptsUnregister)
registerTool('userscripts_list', executeUserscriptsList)
