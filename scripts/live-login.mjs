#!/usr/bin/env node
// Credential-transport regression: disposable browser/profile/provider only.
// Build bro with --features credential-test-provider --target-dir target/credential-test.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, chmod, writeFile, readFile, rm, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [extension, chrome, binary = 'target/credential-test/debug/bro'] = process.argv.slice(2)
if (!extension || !chrome) throw new Error('Usage: live-login.mjs EXTENSION_DIR CHROME_BINARY [TEST_BRO_BINARY]')
assert.match(execFileSync(resolve(binary), ['--version'], { encoding: 'utf8' }), /\+credential-test-provider/, 'Refuse a production binary: this test must never access real vaults')
const dir = await mkdtemp(join(tmpdir(), 'bro-login-test-'))
const log = await open(join(dir, 'process.log'), 'w')
const canary = `synthetic-${randomUUID()}`
const username = `synthetic-user-${randomUUID()}`
const itemId = 'a'.repeat(26), vaultId = 'b'.repeat(26)
const children = [], publicResults = []
let socket, client, submissions = 0, submittedCorrectly = false
const pending = new Map()
let sequence = 0
const fixture = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    const values = JSON.parse(body)
    submissions++
    submittedCorrectly = values.username === username && values.password === canary
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ accepted: submittedCorrectly }))
    return
  }
  res.setHeader('Content-Type', 'text/html')
  res.end(`<!doctype html><title>Disposable login fixture</title><label>Username<input id="user" autocomplete="username"></label><label>Password<input id="pass" type="password" autocomplete="current-password"></label><button id="submit" onclick="fetch('/submit',{method:'POST',body:JSON.stringify({username:document.querySelector('#user').value,password:document.querySelector('#pass').value})})">Sign in</button>`)
})
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
  if (value.exceptionDetails) throw new Error('Private test expression failed; expression withheld')
  return value.result.value
}
async function tool(name, args = {}, allowError = false) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  publicResults.push(JSON.stringify({ name, args, result }))
  assert.ok(!JSON.stringify(result).includes(canary) && !JSON.stringify(result).includes(username), 'credential appeared in public result')
  if (result.isError && !allowError) throw new Error(`${name}: ${text}`)
  return { error: result.isError === true, text, json: () => result.structuredContent ?? JSON.parse(text) }
}
async function stopChildren() {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit').catch(() => {}), new Promise(r => setTimeout(r, 3000))])
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}) }
  }
}
try {
  await new Promise(r => fixture.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${fixture.address().port}`
  const foreign = join(dir, 'foreign')
  await mkdir(foreign)
  await writeFile(join(foreign, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Protected iframe fixture', version: '1.0',
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['inject.js'], run_at: 'document_end' }],
    web_accessible_resources: [{ resources: ['frame.html'], matches: ['http://127.0.0.1/*'] }],
  }))
  await writeFile(join(foreign, 'inject.js'), 'const host=document.createElement("div");const root=host.attachShadow({mode:"closed"});const frame=document.createElement("iframe");frame.src=chrome.runtime.getURL("frame.html");root.append(frame);document.body.append(host);')
  await writeFile(join(foreign, 'frame.html'), '<!doctype html><p>Protected test UI</p>')
  const provider = join(dir, 'fake-op.mjs'), mode = join(dir, 'provider-mode')
  await writeFile(mode, 'normal')
  await writeFile(provider, `#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
const mode=readFileSync(process.env.BRO_TEST_MODE,'utf8');
appendFileSync(process.env.BRO_TEST_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');
if(mode==='delayed' && process.argv.includes('get')) await new Promise(r=>setTimeout(r,1200));
if(mode==='failure'){console.error(process.env.BRO_TEST_SECRET);console.log(process.env.BRO_TEST_SECRET);process.exit(1)}
const item={id:'${itemId}',vault:{id:'${vaultId}'},title:'Synthetic login',category:'LOGIN',urls:[{href:mode==='mismatch'?'https://wrong.invalid':process.env.BRO_TEST_ORIGIN}]};
if(process.argv.includes('get'))item.fields=[{id:'username',value:process.env.BRO_TEST_USERNAME},{id:'password',value:process.env.BRO_TEST_SECRET}];
console.log(JSON.stringify(process.argv.includes('list')?[item]:item));
`)
  await chmod(provider, 0o700)
  const probe = createServer()
  await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise(r => probe.close(r))
  const home = join(dir, 'home'); await mkdir(home)
  launch(resolve(binary), ['serve', '--port', String(port)], { HOME: home, RUST_LOG: 'trace',
    BRO_TEST_OP: provider, BRO_TEST_MODE: mode, BRO_TEST_CALLS: join(dir, 'provider-calls'),
    BRO_TEST_SECRET: canary, BRO_TEST_USERNAME: username, BRO_TEST_ORIGIN: origin })
  const token = await wait(async () => { try { return JSON.parse(await readFile(join(home, '.bro/settings.json'), 'utf8')).token } catch { return null } }, 'broker')
  const profile = join(dir, 'profile')
  launch(chrome, [`--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0',
    `--load-extension=${resolve(extension)},${foreign}`, `--disable-extensions-except=${resolve(extension)},${foreign}`,
    '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', 'about:blank'])
  const devtools = await wait(async () => { try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n') } catch { return null } }, 'Chrome')
  socket = new WebSocket(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`)
  await once(socket, 'open')
  socket.addEventListener('message', event => {
    const msg = JSON.parse(event.data), entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id); clearTimeout(entry.timer)
    if (msg.error) entry.reject(new Error(msg.error.message)); else entry.resolve(msg.result)
  })
  const worker = await wait(async () => (await cdp('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/service-worker.js')), 'bro worker')
  const workerSession = (await cdp('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId
  await cdp('Runtime.enable', {}, workerSession); await cdp('Runtime.runIfWaitingForDebugger', {}, workerSession)
  await wait(() => evaluate(workerSession, 'typeof chrome !== "undefined" && !!chrome.storage'), 'extension API initialization')
  await evaluate(workerSession, `chrome.storage.local.set({token:${JSON.stringify(token)}}).then(()=>chrome.storage.sync.set({serverUrl:${JSON.stringify(`ws://127.0.0.1:${port}/ws`)}}))`)
  const options = await cdp('Target.createTarget', { url: new URL('options.html', worker.url).href })
  const optionsSession = (await cdp('Target.attachToTarget', { targetId: options.targetId, flatten: true })).sessionId
  await cdp('Runtime.enable', {}, optionsSession)
  await wait(async () => { try { return await evaluate(optionsSession, 'typeof chrome.runtime?.sendMessage === "function"') } catch { return false } }, 'options')
  await evaluate(optionsSession, 'chrome.runtime.sendMessage({type:"RECONNECT"})')
  const status = await wait(async () => { const s = await (await fetch(`http://127.0.0.1:${port}/status`)).json(); return s.extensionCount === 1 && s }, 'bridge')
  const browserId = status.defaultBrowserId
  client = new Client({ name: 'private-login-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  assert.ok(!(await client.listTools()).tools.some(t => t.name.startsWith('__bro_login')))
  assert.equal((await tool('__bro_login_fill', {}, true)).error, true)
  const flow = (await tool('browser.flow.start', { url: origin, active: false })).json()
  const tabId = flow.tabId
  await wait(async () => (await tool('javascript_tool', { tabId, code: 'location.origin' }, true)).error, 'protected iframe blocks CDP')
  const inspect = async () => (await tool('login_form_inspect', { browserId, tabId })).json()
  let form = await inspect()
  assert.equal(form.fields.length, 2)
  assert.equal(form.origin, origin)
  const setFixture = code => evaluate(workerSession, `chrome.scripting.executeScript({target:{tabId:${tabId}},world:'ISOLATED',func:()=>{${code}}})`)
  await setFixture(`const s=document.createElement('select');s.id='who';s.innerHTML='<option>remembered</option><option value="other">Other User</option>';document.body.prepend(s);document.querySelector('#user').hidden=true`)
  const remembered = await inspect()
  assert.deepEqual(remembered.fields.map(f => f.type), ['password'])
  assert.deepEqual(remembered.hiddenFields, [{ index: 0, type: 'text' }])
  assert.deepEqual(remembered.accountSwitchers, [{ kind: 'select', css: '#who', optionValue: 'other' }])
  assert.ok(remembered.hint, 'remembered-account state must be explained')
  await setFixture(`document.querySelector('#who').remove();document.querySelector('#user').hidden=false`)
  form = await inspect()
  assert.equal(form.hint, undefined)
  const candidates = (await tool('onepassword_find_logins', { url: origin, confirmMetadataSearch: true })).json()
  assert.equal(candidates.candidates.length, 1)
  assert.equal(candidates.candidates[0].match, 'exact-origin')
  assert.equal((await tool('onepassword_find_logins', { url: 'https://wrong.invalid', confirmMetadataSearch: true })).json().candidates.length, 0)
  const args = () => ({ browserId, tabId, documentId: form.documentId, formToken: form.formToken,
    expectedOrigin: origin, itemId, vaultId, usernameIndex: 0, passwordIndex: 1, confirmFill: true })
  await writeFile(mode, 'failure')
  assert.equal((await tool('onepassword_fill_login', args(), true)).error, true)
  await writeFile(mode, 'mismatch')
  assert.equal((await tool('onepassword_fill_login', args(), true)).error, true)
  await writeFile(mode, 'normal')
  await setFixture(`document.querySelector('#pass').autocomplete='section-signup new-password'`)
  assert.equal((await tool('onepassword_fill_login', args(), true)).error, true)
  await setFixture(`document.querySelector('#pass').autocomplete='current-password'`)
  await setFixture(`globalThis.__broLoginState.expiresAt=0`)
  assert.equal((await tool('onepassword_fill_login', args(), true)).error, true)
  form = await inspect()
  const beforeCalls = (await readFile(join(dir, 'provider-calls'), 'utf8')).length
  await writeFile(mode, 'delayed')
  const pendingFill = tool('onepassword_fill_login', args(), true)
  await wait(async () => (await readFile(join(dir, 'provider-calls'), 'utf8')).length > beforeCalls, 'provider wait began')
  await evaluate(optionsSession, 'chrome.runtime.sendMessage({type:"STOP_AGENT"})')
  assert.equal((await pendingFill).error, true)
  const empty = await evaluate(workerSession, `chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>[...document.querySelectorAll('input')].every(e=>e.value==='')}).then(r=>r[0].result)`)
  assert.equal(empty, true, 'Stop during provider authorization must prevent later fill')
  await writeFile(mode, 'normal')
  form = await inspect()
  await setFixture(`document.querySelector('#pass').replaceWith(document.querySelector('#pass').cloneNode())`)
  assert.equal((await tool('onepassword_fill_login', args(), true)).error, true)
  form = await inspect()
  await setFixture(`document.querySelector('#user').value='already-entered'`)
  assert.equal((await tool('onepassword_fill_login', args(), true)).error, true)
  await setFixture(`document.querySelector('#user').value=''`)
  await tool('navigate', { tabId, url: origin })
  assert.equal((await tool('onepassword_fill_login', args(), true)).error, true)
  form = await inspect()
  const filled = (await tool('onepassword_fill_login', args())).json()
  assert.equal(filled.filled, true)
  assert.equal(submissions, 0)
  assert.equal((await tool('onepassword_fill_login', args(), true)).error, true, 'consumed form must reject replay')
  await setFixture(`document.querySelector('#submit').click()`)
  await wait(async () => submissions === 1, 'explicit test submission')
  assert.ok(submittedCorrectly, 'fixture server must verify exact credentials')
  assert.equal((await tool('extensions_status', { browserId })).json().pause, null)
  console.log('PASS exact-origin candidates and remembered-account inspect; private fill works with CDP blocked and no extension pause')
  console.log('PASS provider/origin failure, changed document/element, autocomplete tokens, nonempty field and replay rejected; Stop during provider wait prevented fill')
  console.log('PASS zero automatic submits; server verified one explicitly submitted test login')
  await tool('browser.flow.finish', { sessionId: flow.sessionId })
  await client.close(); client = undefined
  socket.close(); socket = undefined
  await stopChildren()
  const logs = await readFile(join(dir, 'process.log'), 'utf8')
  assert.ok(!logs.includes(canary) && !logs.includes(username), 'credential appeared in TRACE process log')
  assert.ok(!publicResults.join('').includes(canary) && !publicResults.join('').includes(username), 'credential appeared in transcript')
  console.log('PASS synthetic credentials absent from public requests/results and TRACE process log')
} finally {
  await client?.close().catch(() => {})
  socket?.close()
  await stopChildren()
  fixture.closeAllConnections(); await new Promise(r => fixture.close(r))
  await log.close(); await rm(dir, { recursive: true, force: true })
}
