// Private, server-owned credential transport. Never register these names in the
// public MCP catalog. No credentials in page source, returned values or errors.
import { registerTool } from '../tool-registry.js'

interface LoginInput {
  expectedOrigin: string
  formToken: string
  usernameIndex?: number
  passwordIndex?: number
  username?: string
  password?: string
  expiresAt: number
  checkOnly: boolean
  nonce?: string
}
interface LoginState {
  token: string
  expiresAt: number
  inputs: HTMLInputElement[]
}

const forms = new Map<number, { documentId: string; formToken: string; nonce?: string }>()
let generation = 0

export function revokeLoginForms(tabIds?: number[]): void {
  generation++
  if (tabIds) { for (const tabId of tabIds) forms.delete(tabId) }
  else forms.clear()
}

// Called at execution time by the isolated script, not at secret retrieval time.
// Stop revokes an authorization that has not yet been consumed. A mutation that
// already received authorization may be in progress; cancellation is not undo.
export function authorizeLoginFill(tabId: number, documentId: string, token: unknown, nonce: unknown): boolean {
  const form = forms.get(tabId)
  if (!form || form.documentId !== documentId || form.formToken !== token ||
      typeof nonce !== 'string' || form.nonce !== nonce) return false
  forms.delete(tabId)
  return true
}

// Serialized into the page by executeScript: must stay self-contained.
export function inspectLoginForm() {
  if (window !== window.top) return { status: 'wrong_frame' }
  const token = crypto.randomUUID()
  const inputs = [...document.querySelectorAll('input')]
  const state: LoginState = { token, expiresAt: Date.now() + 120_000, inputs }
  ;(globalThis as typeof globalThis & { __broLoginState?: LoginState }).__broLoginState = state
  // Same predicate as fillLoginForm, so a reported field is one fill accepts.
  const shown = (node: Element) => {
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' &&
      style.display !== 'none' && style.opacity !== '0'
  }
  const fields: { index: number; type: string }[] = []
  const hiddenFields: { index: number; type: string }[] = []
  inputs.forEach((input, index) => {
    if (!['text', 'email', 'tel', 'password'].includes(input.type)) return
    const usable = shown(input) && !input.disabled && !input.readOnly
    ;(usable ? fields : hiddenFields).push({ index, type: input.type })
  })
  // Remembered-account pages hide the username input until "other user" is
  // chosen. Report the switch control, never its or other options' text: a
  // "Not jane@example.com?" link or remembered option contains the username.
  const switchText = /\b(other|different|another|new|switch|change)\b.{0,20}\b(users?|accounts?|ids?|usernames?)\b|\bnot you\b/i
  const simpleId = (node: Element) => /^[A-Za-z][\w-]{0,99}$/.test(node.id) ? `#${node.id}` : null
  const accountSwitchers: { kind: string; css: string | null; optionValue?: string | undefined }[] = []
  for (const select of document.querySelectorAll('select')) {
    if (!shown(select) || select.disabled) continue
    const option = [...select.options].find(o => switchText.test(o.textContent ?? ''))
    if (!option || option.selected) continue
    const value = /^[\w-]{1,100}$/.test(option.value) ? option.value : undefined
    accountSwitchers.push({ kind: 'select', css: simpleId(select), optionValue: value })
  }
  for (const control of document.querySelectorAll('button, a, [role=button]')) {
    if (shown(control) && switchText.test(control.textContent ?? '')) {
      accountSwitchers.push({ kind: 'button', css: simpleId(control) })
    }
  }
  return { status: 'ready', origin: location.origin, formToken: token, fields, hiddenFields,
    accountSwitchers: accountSwitchers.slice(0, 5) }
}

export async function fillLoginForm(input: LoginInput) {
  try {
    if (!input.checkOnly) {
      const permission = await chrome.runtime.sendMessage({ type: 'BRO_LOGIN_AUTHORIZE', formToken: input.formToken, nonce: input.nonce })
      if (permission?.authorized !== true) return { status: 'cancelled' }
    }
    if (window !== window.top || location.origin !== input.expectedOrigin) return { status: 'origin_changed' }
    const state = (globalThis as typeof globalThis & { __broLoginState?: LoginState }).__broLoginState
    if (!state || state.token !== input.formToken) return { status: 'stale_form' }
    if (Date.now() > input.expiresAt || Date.now() > state.expiresAt) return { status: 'expired' }
    const currentInputs = [...document.querySelectorAll('input')]
    const targets: { node: HTMLInputElement; value: string | undefined }[] = []
    for (const [index, password, value] of [
      [input.usernameIndex, false, input.username],
      [input.passwordIndex, true, input.password],
    ] as const) {
      if (index === undefined) continue
      const node = state.inputs[index]
      if (!node || currentInputs[index] !== node || !node.isConnected) return { status: 'stale_form' }
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      if (node.disabled || node.readOnly || rect.width <= 0 || rect.height <= 0 ||
          style.visibility !== 'visible' || style.display === 'none' || style.opacity === '0') return { status: 'invalid_field' }
      if (password ? node.type !== 'password' : !['text', 'email', 'tel'].includes(node.type)) return { status: 'invalid_field' }
      const autocomplete = node.autocomplete.toLowerCase().split(/\s+/)
      if (autocomplete.includes('new-password') || autocomplete.includes('one-time-code')) return { status: 'invalid_field' }
      // Never silently overwrite a value entered by the user or another agent.
      if (node.value !== '') return { status: 'field_not_empty' }
      if (!input.checkOnly && (typeof value !== 'string' || value.length === 0)) return { status: 'missing_field' }
      targets.push({ node, value })
    }
    if (targets.length === 0 || new Set(targets.map(t => t.node)).size !== targets.length) return { status: 'invalid_field' }
    if (input.checkOnly) return { status: 'ready' }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) return { status: 'fill_failed' }
    // Consume before mutation. No replay even if the response is lost.
    delete (globalThis as typeof globalThis & { __broLoginState?: LoginState }).__broLoginState
    for (const target of targets) setter.call(target.node, target.value)
    for (const target of targets) {
      target.node.dispatchEvent(new Event('input', { bubbles: true }))
      target.node.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const matched = targets.every(target => target.node.isConnected && target.node.value === target.value)
    return { status: matched ? 'filled' : 'fill_unverified' }
  } catch {
    return { status: 'fill_failed' }
  }
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

registerTool('__bro_login_inspect', async (tabId) => {
  const started = generation
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: inspectLoginForm })
    const first = results[0]
    if (!first?.documentId || first.frameId !== 0 || !first.result?.formToken) return result({ status: 'inspect_failed' })
    if (started !== generation) return result({ status: 'cancelled' })
    forms.set(tabId, { documentId: first.documentId, formToken: first.result.formToken })
    return result({ ...first.result, documentId: first.documentId })
  } catch { return result({ status: 'inspect_failed' }) }
})

registerTool('__bro_login_fill', async (tabId, raw) => {
  try {
    const args = raw as LoginInput & { documentId: string }
    const form = forms.get(tabId)
    if (!form || form.documentId !== args.documentId || form.formToken !== args.formToken) return result({ status: 'cancelled' })
    if (!args.checkOnly) {
      if (form.nonce) return result({ status: 'cancelled' })
      form.nonce = crypto.randomUUID()
      args.nonce = form.nonce
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [args.documentId] }, world: 'ISOLATED', func: fillLoginForm, args: [args],
    })
    return result(results[0]?.result ?? { status: 'fill_failed' })
  } catch { return result({ status: 'fill_failed' }) }
})
