#!/usr/bin/env node
// Opt-in, disposable-profile test for Chromium's cross-extension boundary.
// No user profile, credentials, installed extensions or production broker used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [extension, chrome, binary = 'target/debug/bro'] = process.argv.slice(2)
if (!extension || !chrome) throw new Error('Usage: live-extension-pause.mjs EXTENSION_DIR CHROME_BINARY [BRO_BINARY]')
const dir = await mkdtemp(join(tmpdir(), 'bro-pause-test-'))
const log = await open(join(dir, 'process.log'), 'w')
const children = []
let socket, client
const fixture = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Extension boundary fixture</title><p>No credentials.</p>') })
const pending = new Map()
let sequence = 0
async function wait(test, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await test()
    if (value) return value
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
function launch(command, args, env = {}) {
  const child = spawn(command, args, { stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ...env } })
  children.push(child)
  return child
}
function cdp(method, params = {}, sessionId) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)) }, 10000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
}
async function evaluate(session, expression) {
  const value = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session)
  if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails))
  return value.result.value
}
async function tool(name, args = {}, allowError = false) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  if (result.isError && !allowError) throw new Error(`${name}: ${text}`)
  return { error: result.isError === true, text, json: () => JSON.parse(text) }
}
try {
  await new Promise(r => fixture.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${fixture.address().port}`
  const foreign = join(dir, 'foreign')
  await mkdir(foreign)
  await writeFile(join(foreign, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Boundary fixture', version: '1.0',
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['inject.js'], run_at: 'document_end' }],
    web_accessible_resources: [{ resources: ['frame.html'], matches: ['http://127.0.0.1/*'] }],
  }))
  await writeFile(join(foreign, 'inject.js'), 'const host=document.createElement("div");const root=host.attachShadow({mode:"closed"});const frame=document.createElement("iframe");frame.src=chrome.runtime.getURL("frame.html");root.append(frame);document.body.append(host);')
  await writeFile(join(foreign, 'frame.html'), '<!doctype html><p>Protected test UI</p>')
  const probe = createServer()
  await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise(r => probe.close(r))
  const home = join(dir, 'home')
  await mkdir(home)
  launch(resolve(binary), ['serve', '--port', String(port)], { HOME: home })
  const token = await wait(async () => {
    try { return JSON.parse(await readFile(join(home, '.bro/settings.json'), 'utf8')).token } catch { return null }
  }, 'isolated broker')
  const profile = join(dir, 'profile')
  launch(chrome, [`--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0',
    `--load-extension=${resolve(extension)},${foreign}`, `--disable-extensions-except=${resolve(extension)},${foreign}`,
    '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', 'about:blank'])
  const devtools = await wait(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n') } catch { return null }
  }, 'Chrome')
  socket = new WebSocket(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`)
  await once(socket, 'open')
  socket.addEventListener('message', event => {
    const msg = JSON.parse(event.data)
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) entry.reject(new Error(msg.error.message)); else entry.resolve(msg.result)
  })
  console.log('Connected to isolated Chrome')
  const worker = await wait(async () => (await cdp('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/service-worker.js')), 'bro worker')
  console.log('Found bro worker')
  const workerSession = (await cdp('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId
  await cdp('Runtime.enable', {}, workerSession)
  await cdp('Runtime.runIfWaitingForDebugger', {}, workerSession)
  await wait(() => evaluate(workerSession, 'typeof chrome !== "undefined" && !!chrome.storage'), 'extension APIs')
  await evaluate(workerSession, `chrome.storage.local.set({token:${JSON.stringify(token)}}).then(()=>chrome.storage.sync.set({serverUrl:${JSON.stringify(`ws://127.0.0.1:${port}/ws`)}}))`)
  console.log('Configured isolated worker')
  const options = await cdp('Target.createTarget', { url: new URL('options.html', worker.url).href })
  const optionsSession = (await cdp('Target.attachToTarget', { targetId: options.targetId, flatten: true })).sessionId
  await cdp('Runtime.enable', {}, optionsSession)
  await wait(async () => { try { return await evaluate(optionsSession, 'typeof chrome.runtime?.sendMessage === "function"') } catch { return false } }, 'options')
  console.log('Opened options')
  await evaluate(optionsSession, 'chrome.runtime.sendMessage({type:"RECONNECT"})')
  await wait(async () => (await (await fetch(`http://127.0.0.1:${port}/status`)).json()).extensionCount === 1, 'bridge')
  console.log('Bridge connected')
  client = new Client({ name: 'pause-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  console.log('MCP connected')
  const status = (await tool('extensions_status')).json()
  const target = status.extensions.find(e => e.name === 'Boundary fixture')
  assert.ok(target)
  const flow = (await tool('browser.flow.start', { url, active: false })).json()
  const tabId = flow.tabId
  const blocked = await wait(async () => {
    const value = await tool('javascript_tool', { tabId, code: 'location.origin' }, true)
    return value.error && /Cannot access a chrome-extension/.test(value.text) && value
  }, 'cross-extension rejection')
  assert.equal(blocked.error, true)
  assert.match(blocked.text, /CDP_FOREIGN_EXTENSION/)
  assert.match(blocked.text, /CDP extension recovery/)
  assert.match(blocked.text, /keep it enabled/)
  assert.match(blocked.text, /explicit user authorization/)
  assert.equal((await tool('extensions_status')).json().pause, null, 'attach failure must not auto-pause')
  const inventory = (await tool('debugger_diagnose', { tabId })).json()
  assert.equal(inventory.completeness, 'not-guaranteed')
  assert.ok(inventory.warning)
  console.log('PASS attach rejected; independent diagnostic reports inventory limits')
  const paused = (await tool('extensions_pause', { extensionId: target.id, confirmProfileWide: true, durationSeconds: 30 })).json().pause
  await tool('navigate', { tabId, url }) // Only the disposable fixture is refreshed.
  await tool('javascript_tool', { tabId, code: 'location.origin' })
  console.log('PASS profile pause restores attach after fixture navigation')
  await tool('extensions_resume', { resumeToken: paused.resumeToken })
  assert.equal((await tool('extensions_status')).json().pause, null)
  await tool('navigate', { tabId, url })
  await wait(async () => {
    const value = await tool('javascript_tool', { tabId, code: 'location.origin' }, true)
    return value.error && /Cannot access a chrome-extension/.test(value.text)
  }, 'restored iframe rejects attach')
  console.log('PASS explicit restoration reintroduces boundary')
  await tool('extensions_pause', { extensionId: target.id, confirmProfileWide: true, durationSeconds: 30 })
  await wait(async () => {
    const state = (await tool('extensions_status')).json()
    return state.pause === null && state.extensions.find(e => e.id === target.id).enabled
  }, 'alarm restores extension', 45000)
  console.log('PASS alarm restores extension and clears journal')
  await wait(async () => (await evaluate(optionsSession, 'document.getElementById("pause-status").textContent')).includes('No extensions paused'), 'settings recovery state')
  console.log('PASS settings reflects recovery')
  await tool('browser.flow.finish', { sessionId: flow.sessionId })
} catch (error) {
  console.error('Test failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  console.log('Cleaning isolated test')
  await client?.close().catch(() => {})
  socket?.close()
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit').catch(() => {}), new Promise(r => setTimeout(r, 3000))])
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}) }
  }
  fixture.closeAllConnections()
  await new Promise(r => fixture.close(r))
  await log.close()
  await rm(dir, { recursive: true, force: true })
}
