#!/usr/bin/env node
// Opt-in real-browser contract test. Uses an isolated Chrome profile and bro
// process; never reloads the user's installed extension or copies login state.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile, open, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flags = process.argv.slice(2)
const option = (name, fallback) =>
  flags.includes(name) ? flags[flags.indexOf(name) + 1] : fallback
assert.equal(typeof WebSocket, 'function', 'This opt-in test requires Node.js 22 or newer')
const output = resolve(option('--output', resolve(tmpdir(), `bro-refs-${Date.now()}`)))
const extension = option('--extension')
const chromeBinary = option('--chrome', process.env.CHROME_BIN)
const broBinary = option('--bro', resolve(repo, 'target/debug/bro'))
if (!extension || !chromeBinary)
  throw new Error(
    'Usage: live-refs.mjs --extension DIR --chrome CHROME_BINARY [--output DIR] [--serve]',
  )
const port = Number(option('--port', '3501'))
assert.ok(
  Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3500,
  'Use a non-production test port between 1024 and 65535 (not 3500)',
)
const profile = resolve(output, 'chrome-profile')
await mkdir(output, { recursive: true, mode: 0o700 })
await mkdir(resolve(output, 'events'), { recursive: true, mode: 0o700 })
await rm(resolve(output, 'results.json'), { force: true })
await rm(resolve(output, 'control.json'), { force: true })
const brokerHome = resolve(output, 'bro-home')
const settingsPath = resolve(brokerHome, '.bro/settings.json')
await mkdir(brokerHome, { recursive: true, mode: 0o700 })
let token = ''
const log = await open(resolve(output, 'processes.log'), 'a')
const processes = []
let rootUrl, crossUrl, socket, client, resetFixture
const checks = []
const cancellation = new AbortController()
let interrupted = false
const stopped = new Promise((resolve) => {
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      interrupted = true
      cancellation.abort(new Error('Interrupted'))
      resolve()
    })
})
const fixture = (req, res) => {
  const url = new URL(req.url, rootUrl ?? 'http://127.0.0.1')
  const run = url.searchParams.get('run') ?? ''
  if (run && !/^[a-z0-9_-]{1,80}$/.test(run)) {
    res.writeHead(400).end()
    return
  }
  if (url.pathname === '/__events') {
    if (req.method !== 'POST' || !run) {
      res.writeHead(405).end()
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 16000) req.destroy()
    })
    req.on('end', async () => {
      try {
        const event = JSON.parse(body)
        await appendFile(
          resolve(output, 'events', `${run}.jsonl`),
          JSON.stringify({ at: Date.now(), event }) + '\n',
        )
        res.writeHead(204).end()
      } catch {
        res.writeHead(400).end()
      }
    })
    return
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  const suffix = run ? `&run=${encodeURIComponent(run)}` : ''
  const send = (html) => {
    if (run)
      html += `<script>(()=>{let last='';const report=()=>{const state=JSON.stringify({url:location.href,outputs:Object.fromEntries([...document.querySelectorAll('output')].map(e=>[e.id,e.textContent]))});if(state===last)return;last=state;fetch('/__events?run=${run}',{method:'POST',headers:{'Content-Type':'application/json'},body:state,keepalive:true}).catch(()=>{});};new MutationObserver(report).observe(document.body,{subtree:true,childList:true,characterData:true});document.addEventListener('input',report);report();})();</script>`
    res.end(html)
  }
  if (url.pathname === '/blank') {
    send('<!doctype html><title>Benchmark ready</title><p>Ready</p>')
    return
  }
  if (url.pathname === '/stale') {
    send(`<!doctype html><title>Ref replacement</title><label>Editor <input id="editor"></label><button id="replace">Replace editor</button><button id="save">Save editor</button><output id="replacement">original</output><output id="probe">WRONG_WRITES:0</output><output id="result">not saved</output><script>
    let wrong=0;document.addEventListener('input',e=>{if(e.target.id==='editor' && e.target.value==='WRONG_REF_PROBE'){wrong++;document.querySelector('#probe').textContent='WRONG_WRITES:'+wrong;}});
    document.querySelector('#replace').onclick=()=>{const old=document.querySelector('#editor');const next=old.cloneNode();next.value='';old.replaceWith(next);document.querySelector('#replacement').textContent='Editor replaced';};
    document.querySelector('#save').onclick=()=>document.querySelector('#result').textContent='RECOVERY_OK:'+document.querySelector('#editor').value;
    </script>`)
    return
  }
  if (url.pathname === '/scroll') {
    send(
      '<!doctype html><title>Scroll contract</title><div id="panel" role="region" aria-label="Scroll panel" style="width:300px;height:80px;overflow:auto"><div style="height:1000px">Scrollable content</div></div><output id="scroll-state">SCROLL_TOP:0</output><script>document.querySelector("#panel").addEventListener("scroll",e=>document.querySelector("#scroll-state").textContent="SCROLL_TOP:"+Math.round(e.target.scrollTop));</script>',
    )
    return
  }
  if (url.pathname === '/nested') {
    send(
      `<title>Nested frame container</title><iframe title="Nested editor" src="${rootUrl}/form?kind=Nested${suffix}" style="width:650px;height:360px"></iframe>`,
    )
    return
  }
  if (url.pathname === '/form') {
    const kind = ['Same', 'Cross', 'Nested', 'New'].includes(url.searchParams.get('kind'))
      ? url.searchParams.get('kind')
      : 'Same'
    send(`<!doctype html><title>${kind} editor</title><h2>${kind} editor</h2><div id="host"></div><output id="result" aria-live="polite">not submitted</output><script>
    const outer=document.querySelector('#host').attachShadow({mode:'open'});outer.innerHTML='<div id="inner"></div>';
    const inner=outer.querySelector('#inner').attachShadow({mode:'open'});
    inner.innerHTML='<label>${kind} Name <input id="name"></label><label>${kind} Mode <select><option value="alpha">Alpha</option><option value="gamma">Gamma</option></select></label><button>${kind} Commit</button><label>${kind} File <input type="file"></label>';
    if ('${kind}' === 'Cross') { const button=inner.querySelector('button'); button.setAttribute('aria-label','Cross Commit'); button.style.cssText='width:14px;height:14px;padding:0;font-size:0'; }
    let inputEvents=0;document.addEventListener('input',()=>inputEvents++);
    inner.querySelector('button').onclick=e=>document.querySelector('#result').textContent='${kind}_OK:'+inner.querySelector('#name').value+':'+inner.querySelector('select').value+':trusted='+e.isTrusted+':input='+inputEvents;
    inner.querySelector('input[type=file]').onchange=async e=>document.querySelector('#result').textContent=e.target.files[0].name+':'+await e.target.files[0].text();
    </script>`)
    return
  }
  send(`<!doctype html><title>bro ref contract</title><h1>bro ref contract</h1>
    <label>Root Name <input id="root-name" aria-label="Root Name"></label><button id="commit">Root Commit</button><button disabled>Disabled</button><input aria-label="Read only" readonly value="locked"><output id="root-result" aria-live="polite">not clicked</output>
    <iframe id="same" title="Same editor" src="${rootUrl}/form?kind=Same${suffix}" style="display:block;width:700px;height:360px;margin-top:30px"></iframe>
    <iframe title="Cross editor" src="${crossUrl}/form?kind=Cross${suffix}" style="display:block;width:700px;height:360px;margin:30px 0 0 45px;border:5px solid;padding:9px"></iframe>
    <iframe title="Nested container" src="${crossUrl}/nested?run=${run}" style="display:block;width:750px;height:420px;margin-top:30px"></iframe>
    <script>document.querySelector('#commit').onclick=e=>document.querySelector('#root-result').textContent='ROOT_OK:'+e.isTrusted;</script>`)
}
const rootServer = createServer(fixture),
  crossServer = createServer(fixture)
const launch = (binary, args, env = {}) => {
  const p = spawn(binary, args, {
    stdio: ['ignore', log.fd, log.fd],
    detached: true,
    env: { ...process.env, ...env },
  })
  processes.push(p)
  p.once('error', (error) => cancellation.abort(error))
  return p
}
async function waitUntil(test, label, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    cancellation.signal.throwIfAborted()
    const value = await test()
    if (value) return value
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
const text = (result) =>
  result.content
    ?.filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n') ?? ''
async function tool(name, args = {}, errorExpected = false) {
  cancellation.signal.throwIfAborted()
  const result = await client.callTool({ name, arguments: args }, undefined, {
    signal: cancellation.signal,
  })
  if (!errorExpected && result.isError) throw new Error(`${name}: ${text(result)}`)
  if (errorExpected) {
    assert.equal(result.isError, true, `${name} should fail, not act on another node`)
    if (errorExpected instanceof RegExp) assert.match(text(result), errorExpected)
  }
  return result
}
const refFor = (snapshot, role, name) => {
  const line = snapshot
    .split('\n')
    .find((line) => line.includes(`] ${role} ${JSON.stringify(name)}`))
  assert.ok(line, `Missing ${role} ${name}: ${snapshot}`)
  return line.match(/\[(ref_[\w]+)\]/)[1]
}
async function withBackgroundPanel(test) {
  const foreground = JSON.parse(
    text(await tool('browser.flow.start', { url: rootUrl + '/blank', active: true })),
  )
  const background = JSON.parse(
    text(await tool('browser.flow.start', { url: rootUrl + '/scroll', active: false })),
  )
  try {
    await waitUntil(
      async () =>
        text(
          await tool('javascript_tool', { tabId: background.tabId, code: 'document.readyState' }),
        ).includes('complete'),
      'background fixture',
    )
    assert.equal(
      text(
        await tool('javascript_tool', {
          tabId: background.tabId,
          code: 'document.visibilityState',
        }),
      ),
      '"hidden"',
    )
    const tree = text(await tool('read_page', { tabId: background.tabId }))
    await test(background, refFor(tree, 'region', 'Scroll panel'))
  } finally {
    await tool('browser.flow.finish', { sessionId: background.sessionId })
    await tool('browser.flow.finish', { sessionId: foreground.sessionId })
  }
}

async function check(name, test) {
  const selected = option('--checks', '')
  if (selected && !name.includes(selected)) return
  const start = performance.now()
  try {
    // Each contract starts from a fresh document; failures cannot poison the
    // next contract's field values, event counters, or overlay state.
    await resetFixture?.()
    await test()
    checks.push({ name, pass: true, seconds: (performance.now() - start) / 1000 })
    console.log('PASS', name)
  } catch (error) {
    if (cancellation.signal.aborted) throw error
    checks.push({ name, pass: false, error: String(error).replaceAll(token, '[redacted]') })
    console.log('FAIL', name, String(error).replaceAll(token, '[redacted]'))
  }
}

try {
  rootServer.listen(0, '127.0.0.1')
  await once(rootServer, 'listening')
  crossServer.listen(0, '127.0.0.1')
  await once(crossServer, 'listening')
  rootUrl = `http://127.0.0.1:${rootServer.address().port}`
  crossUrl = `http://refs-cross.test:${crossServer.address().port}`
  // Fail on an occupied port before starting Chrome or configuring credentials.
  const portProbe = createServer()
  portProbe.listen(port, '127.0.0.1')
  await once(portProbe, 'listening')
  await new Promise((resolve) => portProbe.close(resolve))
  const broker = launch(broBinary, ['serve', '--port', String(port)], { HOME: brokerHome })
  await waitUntil(async () => {
    if (broker.exitCode !== null) throw new Error('Isolated bro process exited')
    try {
      return (await fetch(`http://127.0.0.1:${port}/status`, { signal: cancellation.signal })).ok
    } catch {
      return false
    }
  }, 'isolated bro')
  token = JSON.parse(await readFile(settingsPath, 'utf8')).token
  assert.equal(typeof token, 'string', 'isolated bro settings must contain a token')
  assert.ok(token.length > 0, 'isolated token must not be empty')
  // This disposable profile has no user login state. On macOS it must not
  // block on or access the user's real Safe Storage Keychain item.
  launch(chromeBinary, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    `--load-extension=${resolve(extension)}`,
    `--disable-extensions-except=${resolve(extension)}`,
    '--use-mock-keychain',
    '--no-first-run',
    '--no-default-browser-check',
    '--host-resolver-rules=MAP refs-cross.test 127.0.0.1',
    '--window-size=1280,1000',
    'about:blank',
  ])
  const devtools = await waitUntil(async () => {
    try {
      return (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
    } catch {
      return false
    }
  }, 'isolated Chrome')
  socket = new WebSocket(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`)
  await once(socket, 'open', { signal: cancellation.signal })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(msg.params.type))
      console.warn(
        '[isolated extension]',
        msg.params.type,
        ...msg.params.args.map((a) =>
          String(a.value ?? a.description ?? '')
            .replaceAll(token, '[redacted]')
            .slice(0, 500),
        ),
      )
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      clearTimeout(p.timer)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  })
  const cdp = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 10000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  const worker = await waitUntil(
    async () =>
      (await cdp('Target.getTargets')).targetInfos.find(
        (t) =>
          t.type === 'service_worker' &&
          t.url.startsWith('chrome-extension://') &&
          t.url.endsWith('/service-worker.js'),
      ),
    'extension worker',
  )
  const attached = await cdp('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
  await cdp('Runtime.enable', {}, attached.sessionId)
  await cdp('Runtime.runIfWaitingForDebugger', {}, attached.sessionId)
  await waitUntil(
    async () =>
      (
        await cdp(
          'Runtime.evaluate',
          { expression: 'typeof chrome !== "undefined" && !!chrome.storage', returnByValue: true },
          attached.sessionId,
        )
      ).result?.value === true,
    'extension API initialization',
  )
  const configured = await cdp(
    'Runtime.evaluate',
    {
      expression: `chrome.storage.sync.set({serverUrl:'ws://127.0.0.1:${port}/ws'}).then(()=>chrome.storage.local.set({token:${JSON.stringify(token)}}))`,
      awaitPromise: true,
      returnByValue: true,
    },
    attached.sessionId,
  )
  if (configured.exceptionDetails) {
    const message = (
      configured.exceptionDetails.exception?.description ??
      configured.exceptionDetails.text ??
      ''
    )
      .split('\n')[0]
      .replaceAll(token, '[redacted]')
    throw new Error(`Could not configure isolated extension: ${message}`)
  }
  const optionsPage = await cdp('Target.createTarget', {
    url: worker.url.replace('/service-worker.js', '/options.html'),
    background: true,
  })
  const optionsSession = await cdp('Target.attachToTarget', {
    targetId: optionsPage.targetId,
    flatten: true,
  })
  await cdp('Runtime.enable', {}, optionsSession.sessionId)
  await waitUntil(
    async () =>
      (
        await cdp(
          'Runtime.evaluate',
          {
            expression: 'typeof chrome !== "undefined" && !!chrome.runtime?.id',
            returnByValue: true,
          },
          optionsSession.sessionId,
        )
      ).result?.value === true,
    'extension options context',
  )
  await waitUntil(async () => {
    const r = await cdp(
      'Runtime.evaluate',
      {
        expression:
          'chrome.runtime.sendMessage({type:"GET_STATUS"}).then(r=>r.type==="STATUS").catch(()=>false)',
        awaitPromise: true,
        returnByValue: true,
      },
      optionsSession.sessionId,
    )
    return r.result?.value === true
  }, 'extension message handler')
  const reconnect = await cdp(
    'Runtime.evaluate',
    {
      expression: 'chrome.runtime.sendMessage({type:"RECONNECT"})',
      awaitPromise: true,
      returnByValue: true,
    },
    optionsSession.sessionId,
  )
  assert.equal(reconnect.result?.value?.ok, true, 'Reconnect message must be acknowledged')
  const stored = await cdp(
    'Runtime.evaluate',
    {
      expression:
        'Promise.all([chrome.storage.sync.get("serverUrl"),chrome.storage.local.get("token")]).then(([s,l])=>({url:s.serverUrl,tokenPresent:!!l.token}))',
      awaitPromise: true,
      returnByValue: true,
    },
    optionsSession.sessionId,
  )
  console.log('Isolated settings:', stored.result?.value)
  const status = await waitUntil(async () => {
    const s = await (
      await fetch(`http://127.0.0.1:${port}/status`, { signal: cancellation.signal })
    ).json()
    return s.extensionCount === 1 ? s : false
  }, 'isolated extension connection')
  await cdp('Target.closeTarget', { targetId: optionsPage.targetId })
  await cdp('Target.detachFromTarget', { sessionId: attached.sessionId })
  socket.close()
  socket = undefined
  client = new Client({ name: 'bro-live-refs', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  await writeFile(
    resolve(output, 'control.json'),
    JSON.stringify(
      {
        mcpUrl: `http://127.0.0.1:${port}/mcp`,
        settingsPath,
        rootUrl,
        crossUrl,
        browserId: status.defaultBrowserId,
      },
      null,
      2,
    ),
  )
  const flow = JSON.parse(text(await tool('browser.flow.start', { url: rootUrl, active: false })))
  const tabId = flow.tabId
  resetFixture = async () => {
    await tool('navigate', { tabId, url: rootUrl })
    await waitUntil(
      async () =>
        text(
          await tool('javascript_tool', {
            tabId,
            code: 'document.readyState === "complete" && document.querySelectorAll("iframe").length === 3',
          }),
        ).includes('true'),
      'fresh fixture document',
    )
  }
  // Navigation/load readiness belongs to fixture setup, not a hidden action retry.
  await waitUntil(
    async () =>
      text(
        await tool('javascript_tool', {
          tabId,
          code: 'document.readyState === "complete" && document.querySelectorAll("iframe").length === 3',
        }),
      ).includes('true'),
    'fixture frames',
  )
  let snapshot
  await check('fresh background scroll delivers its event-driven UI before returning', () =>
    withBackgroundPanel(async (background, refId) => {
      const result = JSON.parse(
        text(
          await tool('scroll_element', {
            tabId: background.tabId,
            refId,
            direction: 'down',
            amount: 100,
          }),
        ),
      )
      assert.equal(result.after.y, 100)
      assert.equal(result.moved, true)
      assert.equal(result.boundary, false)
      const state = text(
        await tool('javascript_tool', {
          tabId: background.tabId,
          code: 'document.querySelector("#scroll-state").textContent',
        }),
      )
      assert.equal(
        state,
        '"SCROLL_TOP:100"',
        'offset alone is not the application state; no screenshot or manual foreground workaround allowed',
      )
    }),
  )
  await check(
    'flow batches background scroll and intermediate visible reads without replacing refs',
    () =>
      withBackgroundPanel(async (background, refId) => {
        const result = JSON.parse(
          text(
            await tool('browser.flow.act', {
              sessionId: background.sessionId,
              steps: [
                { type: 'scroll', refId, direction: 'down', amount: 100 },
                { type: 'read_text' },
                { type: 'scroll', refId, direction: 'down', amount: 10000 },
                { type: 'read_text' },
                { type: 'scroll', refId, direction: 'down', amount: 100 },
                { type: 'read_text' },
              ],
            }),
          ),
        )
        assert.equal(result.status, 'ok')
        const reads = result.results
          .filter((r) => r.type === 'read_text')
          .map((r) => r.text.match(/SCROLL_TOP:(\d+)/)?.[1])
        assert.deepEqual(reads, ['100', '920', '920'])
        const scrolls = result.results
          .filter((r) => r.type === 'scroll')
          .map((r) => JSON.parse(text(r.result)))
        assert.deepEqual(
          scrolls.map((r) => r.moved),
          [true, true, false],
        )
        assert.deepEqual(
          scrolls.map((r) => r.boundary),
          [false, true, true],
        )
      }),
  )
  await check('inline same-site, cross-site and nested frame AX labels', async () => {
    snapshot = text(await tool('read_page', { tabId, filter: 'all', maxChars: 24000 }))
    for (const kind of ['Same', 'Cross', 'Nested']) {
      refFor(snapshot, 'textbox', `${kind} Name`)
      refFor(snapshot, 'button', `${kind} Commit`)
    }
    assert.match(snapshot, /unavailable: 0/)
  })
  await check(
    'native ref input/select/click across frame and nested shadow boundaries',
    async () => {
      for (const kind of ['Same', 'Cross', 'Nested']) {
        snapshot = text(await tool('read_page', { tabId, filter: 'all', maxChars: 24000 }))
        await tool('form_input', {
          tabId,
          refId: refFor(snapshot, 'textbox', `${kind} Name`),
          value: 'Luna',
        })
        await tool('form_input', {
          tabId,
          refId: refFor(snapshot, 'combobox', `${kind} Mode`),
          value: kind === 'Same' ? 'Gamma' : 'gamma',
        })
        await tool('click_element', { tabId, refId: refFor(snapshot, 'button', `${kind} Commit`) })
        const observed = text(await tool('read_page', { tabId, filter: 'all', maxChars: 24000 }))
        assert.match(observed, new RegExp(`${kind}_OK:Luna:gamma:trusted=true:input=2`))
      }
    },
  )
  await check('snapshot refs cannot escape their tab or alias a later snapshot', async () => {
    snapshot = text(await tool('read_page', { tabId }))
    const ref = refFor(snapshot, 'textbox', 'Root Name')
    const other = JSON.parse(
      text(await tool('browser.flow.start', { url: rootUrl, active: false })),
    )
    await tool('form_input', { tabId: other.tabId, refId: ref, value: 'wrong' }, true)
    await tool('browser.flow.finish', { sessionId: other.sessionId })
    await tool('read_page', { tabId })
    await tool('form_input', { tabId, refId: ref, value: 'wrong' }, true)
  })
  await check('detached/clone replacement refs fail instead of silently retargeting', async () => {
    snapshot = text(await tool('read_page', { tabId }))
    const ref = refFor(snapshot, 'textbox', 'Root Name')
    await tool('javascript_tool', {
      tabId,
      code: '(()=>{const old=document.querySelector("#root-name");old.replaceWith(old.cloneNode(true));return true})()',
    })
    await tool('form_input', { tabId, refId: ref, value: 'wrong' }, true)
    const state = text(
      await tool('javascript_tool', { tabId, code: 'document.querySelector("#root-name").value' }),
    )
    assert.equal(state, '""')
  })
  await check('covered/disabled clicks and invalid selects fail before action', async () => {
    snapshot = text(await tool('read_page', { tabId, filter: 'all', maxChars: 24000 }))
    await tool(
      'click_element',
      { tabId, refId: refFor(snapshot, 'button', 'Disabled') },
      /disabled/i,
    )
    await tool(
      'form_input',
      { tabId, refId: refFor(snapshot, 'textbox', 'Read only'), value: 'wrong' },
      /read.only/i,
    )
    await tool(
      'form_input',
      { tabId, refId: refFor(snapshot, 'combobox', 'Same Mode'), value: 'missing' },
      /enabled option/i,
    )
    await tool('javascript_tool', {
      tabId,
      code: '(()=>{const el=document.createElement("div");el.id="overlay";el.style="position:fixed;inset:0;z-index:999999;background:white";document.body.append(el);return true})()',
    })
    await tool(
      'click_element',
      { tabId, refId: refFor(snapshot, 'button', 'Root Commit') },
      /covered/i,
    )
    await tool('javascript_tool', { tabId, code: 'document.querySelector("#overlay").remove()' })
    assert.match(
      text(
        await tool('javascript_tool', {
          tabId,
          code: 'document.querySelector("#root-result").textContent',
        }),
      ),
      /not clicked/,
    )
  })
  await check('navigation invalidates refs to the old iframe document', async () => {
    snapshot = text(await tool('read_page', { tabId, filter: 'all', maxChars: 24000 }))
    const ref = refFor(snapshot, 'textbox', 'Same Name')
    await tool('javascript_tool', {
      tabId,
      code: 'document.querySelector("#same").src="/form?kind=New"',
    })
    await waitUntil(
      async () => text(await tool('frames_list', { tabId })).includes('kind=New'),
      'iframe navigation',
    )
    await tool('form_input', { tabId, refId: ref, value: 'wrong' }, true)
  })
  await check('file upload uses the same cross-site document-bound refs', async () => {
    snapshot = text(await tool('read_page', { tabId, filter: 'all', maxChars: 24000 }))
    await tool('file_upload', {
      tabId,
      refId: refFor(snapshot, 'button', 'Cross File'),
      fileName: 'ref.txt',
      mimeType: 'text/plain',
      data: Buffer.from('REF_UPLOAD_OK').toString('base64'),
    })
    assert.match(
      text(await tool('read_page', { tabId, filter: 'all', maxChars: 24000 })),
      /ref.txt:REF_UPLOAD_OK/,
    )
  })
  await check(
    'default flow observation and ref steps work without frame IDs; failures stop the flow',
    async () => {
      const observe = JSON.parse(
        text(await tool('browser.flow.observe', { sessionId: flow.sessionId })),
      )
      assert.equal(observe.mode, 'a11y')
      await tool('browser.flow.act', {
        sessionId: flow.sessionId,
        steps: [
          { type: 'fill', refId: refFor(observe.content, 'textbox', 'Cross Name'), value: 'Flow' },
          {
            type: 'select',
            refId: refFor(observe.content, 'combobox', 'Cross Mode'),
            value: 'Gamma',
          },
          { type: 'click', refId: refFor(observe.content, 'button', 'Cross Commit') },
        ],
      })
      let next = JSON.parse(text(await tool('browser.flow.observe', { sessionId: flow.sessionId })))
      assert.match(next.content, /Cross_OK:Flow:gamma:trusted=true/)
      const failed = JSON.parse(
        text(
          await tool(
            'browser.flow.act',
            {
              sessionId: flow.sessionId,
              steps: [
                { type: 'click', refId: 'ref_deliberately_stale' },
                {
                  type: 'fill',
                  refId: refFor(next.content, 'textbox', 'Cross Name'),
                  value: 'WRONG',
                },
              ],
            },
            true,
          ),
        ),
      )
      assert.equal(failed.stoppedAt, 0)
      assert.equal(failed.results.length, 1)
      await tool(
        'browser.flow.act',
        {
          sessionId: flow.sessionId,
          steps: [
            { type: 'fill', refId: refFor(next.content, 'textbox', 'Cross Name'), value: 'WRONG' },
            { type: 'click', refId: 'ref_invalid', css: 'button' },
          ],
        },
        true,
      )
      next = JSON.parse(text(await tool('browser.flow.observe', { sessionId: flow.sessionId })))
      assert.match(next.content, /textbox "Cross Name" value="Flow"/)
    },
  )
  await check(
    'find, info, wait and scroll use the same refs and report actual scroll boundaries',
    async () => {
      await tool('navigate', { tabId, url: `${rootUrl}/scroll` })
      await waitUntil(
        async () =>
          text(await tool('javascript_tool', { tabId, code: 'document.readyState' })).includes(
            'complete',
          ),
        'scroll fixture',
      )
      const found = text(await tool('find', { tabId, description: 'Scroll panel' }))
      const refId = found.match(/\[(ref_[\w]+)\]/)?.[1]
      assert.ok(refId, found)
      await tool('wait_for_element', { tabId, refId })
      const info = () => tool('get_element_info', { tabId, refId }).then((r) => JSON.parse(text(r)))
      assert.equal((await info()).scroll.top, 0)
      await tool('scroll_element', { tabId, refId, direction: 'down', amount: 100 })
      assert.equal((await info()).scroll.top, 100)
      await tool('scroll_element', { tabId, refId, direction: 'down', amount: 10000 })
      assert.match(
        text(await tool('scroll_element', { tabId, refId, direction: 'down', amount: 100 })),
        /boundary/,
      )
    },
  )
  await tool('browser.flow.finish', { sessionId: flow.sessionId })
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify({ checks, pass: checks.every((c) => c.pass) }, null, 2),
  )
  console.log(`RESULTS ${resolve(output, 'results.json')}`)
  if (checks.some((c) => !c.pass)) process.exitCode = 1
  if (flags.includes('--serve')) {
    console.log('Serving isolated fixtures for subagent validation; SIGTERM cleans up.')
    await stopped
  }
} catch (error) {
  if (!interrupted) throw error
  process.exitCode = 130
} finally {
  socket?.close()
  try {
    await client?.close()
  } catch (error) {
    process.exitCode = 1
    console.error('MCP teardown failed:', String(error).replaceAll(token, '[redacted]'))
  }
  rootServer.closeAllConnections()
  crossServer.closeAllConnections()
  await Promise.all([
    new Promise((r) => rootServer.close(r)),
    new Promise((r) => crossServer.close(r)),
  ])
  for (const child of processes.reverse()) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    process.kill(-child.pid, 'SIGTERM')
    const guard = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL')
    }, 5000)
    await exited
    clearTimeout(guard)
  }
  await log.close()
  await rm(profile, { recursive: true, force: true })
  await rm(brokerHome, { recursive: true, force: true })
}
