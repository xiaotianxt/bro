// Native JavaScript dialogs (alert, confirm, prompt, beforeunload) block the
// page's main thread: while one is open, input and evaluation on the tab never
// return. bro answers each dialog as it opens and records the answer for the
// action that caused it. By default alerts and beforeunload are accepted (they
// only acknowledge) and confirm/prompt are dismissed (accepting one can commit
// a destructive choice); a caller arms an explicit answer to accept them.
//
// File choosers are the same kind of problem: an OS window no tool can reach.
// Chrome intercepts them on every attached session (cdp.ts), which cancels the
// native window and reports the <input type=file> that asked. A chooser goes
// to file_upload when it is waiting for one; otherwise it is recorded as
// cancelled, so the action that opened it can say how to choose files.

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

export interface FileChooser {
  /** The session of the frame whose input opened it; undefined for the tab itself. */
  sessionId: string | undefined
  /** Absent when the page asked through showOpenFilePicker rather than an input. */
  backendNodeId: number | undefined
  mode: 'selectSingle' | 'selectMultiple'
}

const chooserWaiters = new Map<number, (chooser: FileChooser) => void>()

/**
 * Runs the action and returns the file chooser it opens, or undefined when
 * none opens within timeoutMs of the action finishing.
 */
export async function withFileChooser(
  tabId: number,
  action: () => Promise<unknown>,
  timeoutMs: number,
): Promise<FileChooser | undefined> {
  if (chooserWaiters.has(tabId)) throw new Error('Another file_upload on this tab is waiting for a file chooser')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const opened = new Promise<FileChooser>((resolve) => chooserWaiters.set(tabId, resolve))
    await action()
    const timedOut = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, timeoutMs) })
    return await Promise.race([opened, timedOut])
  } finally {
    clearTimeout(timer)
    chooserWaiters.delete(tabId)
  }
}

/** Answers native dialogs and file choosers on every tab the debugger attaches to. Called once by the service worker. */
export function installDialogAnswers(): void {
  cdpSession.onEveryTab('Page.javascriptDialogOpening', answerDialog)
  cdpSession.onEveryTab('Page.fileChooserOpened', (tabId, params, sessionId) => {
    const { backendNodeId, mode } = params as { backendNodeId?: number; mode: FileChooser['mode'] }
    const waiter = chooserWaiters.get(tabId)
    if (waiter) {
      chooserWaiters.delete(tabId)
      waiter({ sessionId, backendNodeId, mode })
      return
    }
    record(tabId, `file chooser cancelled (bro never opens the OS picker); to choose files, call file_upload on the control you clicked (refId or coordinate)`)
  })
}

function answerDialog(tabId: number, params: unknown, sessionId: string | undefined): void {
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
    .sendToSession(tabId, sessionId, 'Page.handleJavaScriptDialog', {
      accept: answer.accept,
      ...(answer.promptText === undefined ? {} : { promptText: answer.promptText }),
    })
    .catch((error: unknown) => record(tabId, `${label} could not be answered: ${String(error)}`))
}
