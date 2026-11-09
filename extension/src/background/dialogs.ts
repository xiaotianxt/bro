// Native JavaScript dialogs (alert, confirm, prompt, beforeunload) block the
// page's main thread: while one is open, input and evaluation on the tab never
// return. bro answers each dialog as it opens and records the answer for the
// action that caused it. By default alerts and beforeunload are accepted (they
// only acknowledge) and confirm/prompt are dismissed (accepting one can commit
// a destructive choice); a caller arms an explicit answer to accept them.

import { cdpSession } from './cdp.js'

export interface DialogAnswer {
  accept: boolean
  promptText?: string
}

interface DialogOpening {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
}

const armed = new Map<number, DialogAnswer>()
const answered = new Map<number, string[]>()

/** Sets how dialogs on the tab are answered until disarmed; undefined disarms. */
export function armDialogs(tabId: number, answer: DialogAnswer | undefined): void {
  if (answer) armed.set(tabId, answer)
  else armed.delete(tabId)
}

/** Returns and forgets the dialogs answered on the tab since the last call. */
export function takeDialogs(tabId: number): string[] {
  const lines = answered.get(tabId) ?? []
  answered.delete(tabId)
  return lines
}

function record(tabId: number, line: string): void {
  answered.set(tabId, [...(answered.get(tabId) ?? []), line])
}

/** Answers native dialogs on every tab the debugger attaches to. Called once by the service worker. */
export function installDialogAnswers(): void {
  cdpSession.onEveryTab('Page.javascriptDialogOpening', answerDialog)
}

function answerDialog(tabId: number, params: unknown): void {
  const { type, message } = params as DialogOpening
  const answer = armed.get(tabId) ?? { accept: type === 'alert' || type === 'beforeunload' }
  const label = `${type} ${JSON.stringify(message.slice(0, 200))}`
  // Recorded before answering: the action that opened the dialog returns as
  // soon as the dialog closes and must find its record.
  record(
    tabId,
    answer.accept || armed.has(tabId)
      ? `${label} ${answer.accept ? 'accepted' : 'dismissed'}`
      : `${label} dismissed by default; to accept, run the action in browser_act after a {"type":"dialog","accept":true} step`,
  )
  cdpSession
    .send(tabId, 'Page.handleJavaScriptDialog', {
      accept: answer.accept,
      ...(answer.promptText === undefined ? {} : { promptText: answer.promptText }),
    })
    .catch((error: unknown) => record(tabId, `${label} could not be answered: ${String(error)}`))
}
