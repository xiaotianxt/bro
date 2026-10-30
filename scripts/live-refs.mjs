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
let rootUrl, crossUrl, socket, client, resetFixture, heldScript, heldFrame
const correctionCheck = 'navigation correction: internal sources and same-document readiness'
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
  if (url.pathname === '/held-script.js') {
    res.setHeader('Content-Type', 'application/javascript')
    heldScript = res
    return
  }
  if (url.pathname === '/g-held-frame') {
    heldFrame = res
    return
  }
  if (url.pathname === '/g-long') {
    // A11y output well past the 12000 cap, with sections after the cut.
    send(`<!doctype html><title>G long</title><header><nav aria-label="Top">Top</nav></header>
    <main><h1>Catalog</h1><ul>${Array.from({ length: 300 }, (_, i) => `<li><a href="#i${i}">Item ${i} with a descriptive product title</a></li>`).join('')}</ul></main>
    <section aria-label="Reviews"><h2>Reviews</h2><p>REVIEW_OK</p></section>
    <footer>Footer</footer><output id="late">pending</output>`)
    return
  }
  if (url.pathname === '/h-delayed') {
    // Content that arrives 1.5 s after a click. The delay is server-side,
    // because background tabs align page timers to about 1 s.
    send(`<!doctype html><title>H delayed</title><div role="alert" aria-label="Promo">Promo <button id="dismiss">Dismiss</button></div>
    <button id="go">Load results</button><p id="status"></p><button id="submit" disabled>Submit</button><div id="out"></div>
    <script>
    dismiss.onclick=()=>document.querySelector('[role=alert]').remove();
    go.onclick=async()=>{status.textContent='Loading results';out.textContent=await (await fetch('/h-data')).text();status.textContent='';submit.disabled=false};
    </script>`)
    return
  }
  if (url.pathname === '/h-data') {
    setTimeout(() => res.end('RESULTS_READY with enough words to read'), 1500).unref()
    return
  }
  if (url.pathname === '/h-slow') {
    // A slow document whose content arrives after DOMContentLoaded: the shell
    // alone is not readable text.
    setTimeout(() => send(`<!doctype html><title>H slow</title><main><p id="shell">Loading…</p></main><script>
    fetch('/h-slow-data').then(r=>r.text()).then(t=>{document.querySelector('main').innerHTML='<h1>Slow page</h1><p>'+t+'</p>'});
    </script>`), 1200).unref()
    return
  }
  if (url.pathname === '/h-slow-data') {
    setTimeout(() => res.end('SLOW_CONTENT_OK. ' + 'This paragraph arrived after the document loaded and is long enough to read. '.repeat(3)), 800).unref()
    return
  }
  if (url.pathname === '/g-churn') {
    // A large main document keeps collection busy while an iframe commits a
    // held navigation, so the frame inventory changes mid-observation.
    send(`<!doctype html><title>G churn</title><iframe id="f" title="Churn" src="/blank"></iframe>
    <ul>${Array.from({ length: 20000 }, (_, i) => `<li><button>Row ${i}</button></li>`).join('')}</ul>`)
    return
  }
  if (url.pathname === '/held-document') {
    send('<!doctype html><title>Deferred readiness</title><script defer src="/held-script.js"></script><p>Waiting for deferred script</p>')
    return
  }
  if (url.pathname === '/redirect') {
    res.writeHead(302, { Location: `${rootUrl}/blank` }).end()
    return
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
  if (url.pathname === '/overlay') {
    // Storefront pattern: visually hidden radios behind visible labels, under a
    // fixed newsletter dialog that covers the option group.
    send(`<!doctype html><title>Covered options</title><style>.vh{position:absolute;width:1px;height:1px;clip:rect(0,0,0,0);overflow:hidden}label{display:inline-block;padding:12px;border:1px solid}</style>
    <fieldset><legend>Memory</legend><input class="vh" type="radio" name="mem" id="m8" value="8" checked><label for="m8">8GB</label><input class="vh" type="radio" name="mem" id="m16" value="16"><label for="m16">16GB</label></fieldset><input type="checkbox" id="gift" aria-label="Gift wrap"><output id="choice">mem=8 gift=false</output>
    <div role="dialog" aria-label="Newsletter" style="position:fixed;inset:0;background:rgba(255,255,255,.9)"><input placeholder="Enter your email" style="width:100%;height:100%"><button>Close newsletter</button></div>
    <script>const show=()=>document.querySelector('#choice').textContent='mem='+document.querySelector('input[name=mem]:checked').value+' gift='+document.querySelector('#gift').checked;document.addEventListener('change',show);</script>`)
    return
  }
  if (url.pathname === '/slow-ready') {
    // DOMContentLoaded waits on a parser-blocking script held past bro's 10 s bound.
    send('<!doctype html><title>Slow readiness</title><p>Loading</p><script src="/slow-ready.js"></script>')
    return
  }
  if (url.pathname === '/slow-ready.js') {
    res.setHeader('Content-Type', 'application/javascript')
    setTimeout(() => res.end('document.title="Slow ready"'), 12_000).unref()
    return
  }
  if (url.pathname === '/f-contract') {
    // Eval-derived shapes: a non-scrollable comment region inside a shadow host
    // on a long document; a non-scrollable item in an inner feed; a checkbox
    // whose label receives the hit; a slotted shadow button; an option group
    // that re-renders on change; and long plain text.
    send(`<!doctype html><title>F contract</title><style>body{margin:0}</style>
    <comment-host></comment-host>
    <div id="feed" role="region" aria-label="Feed" style="height:120px;overflow:auto"><article aria-label="Feed item" style="height:60px">One</article><div style="height:900px"></div></div>
    <label id="sub" style="position:relative;display:inline-block;padding:12px">Subscribe<input type="checkbox" aria-label="Subscribe" style="position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;pointer-events:none"></label>
    <fancy-button><span>Slotted action</span></fancy-button>
    <div id="opts" role="group" aria-label="Options"><input type="radio" name="o" aria-label="Option A"><input type="radio" name="o" aria-label="Option B"></div>
    <output id="state">none</output>
    <p id="long">TEXT_START ${'word '.repeat(80)}TEXT_END</p>
    <div style="height:3000px"></div>
    <script>
    customElements.define('comment-host',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<section role="region" aria-label="Comments" style="height:80px">Comments</section>'}});
    customElements.define('fancy-button',class extends HTMLElement{connectedCallback(){const r=this.attachShadow({mode:'open'});r.innerHTML='<button><slot></slot></button>';r.querySelector('button').onclick=()=>document.querySelector('#state').textContent='SLOTTED_OK'}});
    document.querySelector('#sub input').onchange=e=>document.querySelector('#state').textContent='SUB:'+e.target.checked;
    document.querySelector('#opts').onchange=()=>{const old=document.querySelector('#opts');old.replaceWith(old.cloneNode(true));document.querySelector('#state').textContent='OPTS_REPLACED'};
    </script>`)
    return
  }
  if (url.pathname === '/token-form') {
    // Shaped like GitHub's token page: menus re-render with fresh ids on every
    // open, labels update on a later task (React schedules with MessageChannel,
    // which background tabs do not throttle like timers), and validation
    // arrives over the network.
    send(`<!doctype html><title>Token form</title><h1>New token</h1>
    <label>Token name <input id="name"></label>
    <button id="exp">Expiration: 30 days</button><div id="exp-menu"></div>
    <button id="access">Access: Read-only</button><div id="access-menu"></div>
    <button id="generate">Generate token</button><div id="status"></div>
    <script>
    let renders=0;const state={exp:'30 days',access:'Read-only'};
    const later=f=>{const c=new MessageChannel();c.port1.onmessage=()=>f();c.port2.postMessage(0)};
    const menu=(root,label,items,pick)=>{renders++;root.innerHTML='<div role="menu" aria-label="'+label+'">'+items.map((t,i)=>'<div role="menuitemradio" id="_r_'+renders+'_'+i+'" style="padding:4px">'+t+'</div>').join('')+'</div>';
      root.querySelectorAll('[role=menuitemradio]').forEach(item=>item.onclick=()=>{root.innerHTML='';later(()=>pick(item.textContent))})};
    document.querySelector('#exp').onclick=()=>menu(document.querySelector('#exp-menu'),'Expiration',['7 days','30 days','90 days'],v=>{state.exp=v;document.querySelector('#exp').textContent='Expiration: '+v});
    document.querySelector('#access').onclick=()=>menu(document.querySelector('#access-menu'),'Access',['Read-only','Read and write'],v=>{state.access=v;document.querySelector('#access').textContent='Access: '+v});
    document.querySelector('#generate').onclick=()=>fetch('/blank').then(()=>{document.querySelector('#status').innerHTML=state.access==='Read and write'?'<p>TOKEN_CREATED '+document.querySelector('#name').value+' '+state.exp+'</p>':'<p role="alert">Contents needs read and write access</p>'});
    </script>`)
    return
  }
  if (url.pathname === '/scroll-page') {
    res.end('<!doctype html><title>Page wheel contract</title><main role="region" aria-label="Scroll panel" style="height:3000px">Long document</main><output id="scroll-state" style="position:fixed;top:0;right:0">SCROLL_TOP:0</output><script>document.addEventListener("scroll",()=>document.querySelector("#scroll-state").textContent="SCROLL_TOP:"+Math.round(scrollY));</script>')
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
  return line.match(/\[([a-z]{3}\d+)\]/)[1]
}
async function withBackgroundPanel(test, path = '/scroll') {
  const foreground = JSON.parse(
    text(await tool('browser.flow.start', { url: rootUrl + '/blank', active: true })),
  )
  const background = JSON.parse(
    text(await tool('browser.flow.start', { url: rootUrl + path, active: false })),
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
    const initialTabs = text(await tool('tabs_context', { tabId: foreground.tabId, all: true }))
    assert.match(initialTabs, new RegExp(`Active tab: .*\\(ID: ${foreground.tabId}\\)`),
      `foreground fixture must be selected before input: ${initialTabs}`)
    await test(background, refFor(tree, 'region', 'Scroll panel'))
    assert.equal(
      text(await tool('javascript_tool', { tabId: background.tabId, code: 'document.visibilityState' })),
      '"hidden"',
      'background input must restore page visibility and must not activate its tab',
    )
    const finalTabs = text(await tool('tabs_context', { tabId: foreground.tabId, all: true }))
    assert.match(
      finalTabs,
      new RegExp(`Active tab: .*\\(ID: ${foreground.tabId}\\)`),
      `input must preserve the selected tab even if its window is occluded: ${finalTabs}`,
    )
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
    // A contract may return measurements worth keeping with its result.
    const measured = await test()
    checks.push({ name, pass: true, seconds: (performance.now() - start) / 1000, ...(measured && { measured }) })
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
  let internalTabId
  if (correctionCheck.includes(option('--checks', ''))) {
    const created = await cdp('Runtime.evaluate', {
      expression: 'chrome.tabs.create({url:"chrome://newtab/",active:false}).then(tab=>tab.id)',
      awaitPromise: true, returnByValue: true,
    }, attached.sessionId)
    internalTabId = created.result.value
    assert.equal(typeof internalTabId, 'number')
    await waitUntil(async () => (await cdp('Runtime.evaluate', {
      expression: `chrome.tabs.get(${internalTabId}).then(tab=>tab.url)`,
      awaitPromise: true, returnByValue: true,
    }, attached.sessionId)).result.value === 'chrome://newtab/', 'internal source fixture')
  }
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
  await check('computer wheel scroll renders background panels and pages without activation', async () => {
    for (const path of ['/scroll', '/scroll-page']) {
      await withBackgroundPanel(async (background) => {
        const wheel = () => tool('computer', {
          tabId: background.tabId, action: 'scroll',
          coordinate: [100, 40], direction: 'down', amount: 1,
        })
        const state = async () => JSON.parse(text(await tool('javascript_tool', {
          tabId: background.tabId,
          code: '({top: (document.querySelector("#panel") || document.scrollingElement).scrollTop, text: document.querySelector("#scroll-state").textContent})',
        })))
        await wheel()
        const moved = await state()
        assert.equal(moved.top, 120, `${path}: wheel must actually move the background scroller`)
        assert.equal(moved.text, 'SCROLL_TOP:120')
        // A page may intentionally consume the wheel. Dispatch is not a claim
        // of movement, and must never fall back to DOM scrolling or replay.
        await tool('javascript_tool', {
          tabId: background.tabId,
          code: 'document.addEventListener("wheel", e => e.preventDefault(), {passive:false})',
        })
        assert.match(text(await wheel()), /Dispatched wheel/)
        assert.deepEqual(await state(), moved)
      }, path)
    }
  })

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
    assert.match(snapshot, /^Frames: 5\n/)
    assert.doesNotMatch(snapshot, /unavailable/)
  })
  await check(
    'native ref input/select/click across frame and nested shadow boundaries',
    async () => {
      const foreground = JSON.parse(
        text(await tool('browser.flow.start', { url: rootUrl + '/blank', active: true })),
      )
      try {
        assert.equal(
          text(await tool('javascript_tool', { tabId, code: 'document.visibilityState' })),
          '"hidden"',
        )
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
          assert.equal(
            text(await tool('javascript_tool', { tabId, code: 'document.visibilityState' })),
            '"hidden"',
          )
          assert.match(
            text(await tool('tabs_context', { tabId: foreground.tabId, all: true })),
            new RegExp(`Active tab: .*\\(ID: ${foreground.tabId}\\)`),
          )
        }
      } finally {
        await tool('browser.flow.finish', { sessionId: foreground.sessionId })
      }
    },
  )
  await check('refs cannot escape their tab and survive same-node rereads', async () => {
    snapshot = text(await tool('read_page', { tabId }))
    const ref = refFor(snapshot, 'textbox', 'Root Name')
    const other = JSON.parse(
      text(await tool('browser.flow.start', { url: rootUrl, active: false })),
    )
    await tool('form_input', { tabId: other.tabId, refId: ref, value: 'wrong' }, true)
    await tool('browser.flow.finish', { sessionId: other.sessionId })
    const reread = text(await tool('read_page', { tabId }))
    assert.equal(refFor(reread, 'textbox', 'Root Name'), ref)
    await tool('form_input', { tabId, refId: ref, value: 'reread success' })
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
      /covered by [a-z]{3}\d+ <div id=\\?"overlay\\?">; no click dispatched/,
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
      const refId = found.match(/\[([a-z]{3}\d+)\]/)?.[1]
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
  await check('modern target composition observes intended documents and stable scoped refs', async () => {
    const opened = JSON.parse(text(await tool('browser.open', { url: `${rootUrl}/redirect` })))
    try {
      const actResult = await tool('browser.act', { targetId: opened.targetId, steps: [
        { type: 'evaluate', code: 'document.title' },
        { type: 'navigate', url: `${rootUrl}/scroll` },
        { type: 'evaluate', code: 'document.title' },
        { type: 'observe' },
      ] })
      const acted = actResult.structuredContent
      assert.equal(acted.results[0].result, 'Benchmark ready')
      assert.equal(acted.results[2].result, 'Scroll contract')
      assert.deepEqual(acted.results[1], { type: 'navigate', url: `${rootUrl}/scroll` })
      assert.match(text(actResult), new RegExp(`^targetId: ${opened.targetId}\nevaluated: Benchmark ready\nnavigated: `))
      assert.doesNotMatch(text(actResult), /browserId|acknowledgement|cleanup/)
      const refId = refFor(acted.results[3].content, 'region', 'Scroll panel')
      const scoped = await tool('browser.observe', { targetId: opened.targetId, refId, depth: 1 })
      assert.equal(refFor(text(scoped), 'region', 'Scroll panel'), refId)
      const scrolled = (await tool('browser.act', { targetId: opened.targetId, steps: [
        { type: 'scroll', refId, amount: 100 },
        { type: 'observe' },
      ] })).structuredContent
      assert.match(scrolled.results[1].content, /SCROLL_TOP:100/)
    } finally {
      await tool('browser.close', { targetId: opened.targetId })
    }
  })
  await check('covered options name the overlay; check sets them without a pointer click', async () => {
    const opened = JSON.parse(text(await tool('browser.open', { url: `${rootUrl}/overlay` })))
    try {
      const page = text(await tool('browser.observe', { targetId: opened.targetId }))
      const option = refFor(page, 'radio', '16GB')
      const gift = refFor(page, 'checkbox', 'Gift wrap')
      const covered = await tool('browser.act', { targetId: opened.targetId, steps: [
        { type: 'click', refId: option },
      ] }, true)
      assert.match(text(covered), new RegExp(`^failed at step 1 \\(click ${option}\\): Target ${option} is covered by [a-z]{3}\\d+ <input placeholder="Enter your email"> inside overlay ([a-z]{3}\\d+) <div role="dialog" aria-label="Newsletter">`))
      const overlay = /inside overlay ([a-z]{3}\d+)/.exec(text(covered))[1]
      assert.match(text(await tool('browser.observe', { targetId: opened.targetId, refId: overlay })), /button "Close newsletter"/)
      const checked = await tool('browser.act', { targetId: opened.targetId, steps: [
        { type: 'check', refId: option },
        { type: 'check', refId: gift },
        { type: 'evaluate', code: "document.querySelector('#choice').textContent" },
      ] })
      // Each check reports the text it changed once the page settled.
      assert.match(text(checked), new RegExp(`^targetId: ${opened.targetId}\\nchecked ${option} → text "mem=16 gift=false" \\(settled \\d+ms\\)\\nchecked ${gift} → text "mem=16 gift=true" \\(settled \\d+ms\\)\\nevaluated: mem=16 gift=true$`))
      await tool('browser.act', { targetId: opened.targetId, steps: [{ type: 'check', refId: option, checked: false }] }, /cannot be unchecked directly/)
    } finally {
      await tool('browser.close', { targetId: opened.targetId })
    }
  })
  await check('T: role/name targets and change reports chain a form without waits', async () => {
    const opened = JSON.parse(text(await tool('browser.open', { url: `${rootUrl}/token-form` })))
    const targetId = opened.targetId
    try {
      const started = performance.now()
      const result = text(await tool('browser.act', { targetId, steps: [
        { type: 'fill', role: 'textbox', name: 'Token name', value: 'rss-dispatch' },
        { type: 'click', role: 'button', name: 'Expiration' },
        { type: 'click', role: 'menuitemradio', name: '90 days' },
        { type: 'click', role: 'button', name: 'Generate token' },
        { type: 'click', role: 'button', name: 'Access' },
        { type: 'click', role: 'menuitemradio', name: 'Read and write' },
        { type: 'click', role: 'button', name: 'Generate token' },
      ] }))
      const elapsed = Math.round(performance.now() - started)
      const lines = result.split('\n')
      assert.equal(lines.length, 8, result)
      assert.match(lines[1], /^filled \w+ \(textbox "Token name"\)$/)
      assert.match(lines[2], /^clicked \w+ \(button "Expiration"\) → opened menu "Expiration"/)
      // The menu item re-rendered with a fresh id; resolution happens at click.
      assert.match(lines[3], /^clicked \w+ \(menuitemradio "90 days"\) → closed menu "Expiration".*text "Expiration: 90 days"/)
      assert.match(lines[4], /→ alert Contents needs read and write access/)
      assert.match(lines[6], /text "Access: Read and write"/)
      assert.match(lines[7], /text "TOKEN_CREATED rss-dispatch 90 days"/)
      assert.ok(elapsed < 8000, `${elapsed}ms`)
      await tool('browser.act', { targetId, steps: [{ type: 'click', role: 'menuitemradio', name: 'Read and write' }] }, /No visible menuitemradio named "Read and write"/)
      await tool('browser.act', { targetId, steps: [{ type: 'click', role: 'button', name: 'e' }] }, /visible button elements match "e"/)
      await tool('browser.act', { targetId, steps: [{ type: 'click', role: 'button', name: 'Generate', refId: 'kqx1' }] }, /exactly one target/)
    } finally {
      await tool('browser.close', { targetId })
    }
  })
  await check('F: scroll, hit acceptance, scope replacement and text cursor', async () => {
    const opened = JSON.parse(text(await tool('browser.open', { url: `${rootUrl}/f-contract` })))
    const targetId = opened.targetId
    const act = async (steps, errorExpected) => text(await tool('browser.act', { targetId, steps }, errorExpected))
    try {
      assert.equal(opened.ready, undefined)
      const page = text(await tool('browser.observe', { targetId }))
      const comments = refFor(page, 'region', 'Comments')
      const feed = refFor(page, 'region', 'Feed')
      const item = refFor(page, 'article', 'Feed item')
      assert.match(await act([{ type: 'scroll', refId: comments, amount: 400 }]), new RegExp(`\\nscrolled document \\(from ${comments}\\) dy=400$`))
      assert.equal(await act([{ type: 'evaluate', code: 'Math.round(scrollY)' }]), `targetId: ${targetId}\nevaluated: 400`)
      assert.match(await act([{ type: 'scroll', refId: item, amount: 100 }]), new RegExp(`\\nscrolled ${feed} <div role="region" aria-label="Feed"> \\(from ${item}\\) dy=100$`))
      await act([{ type: 'scroll', refId: item, direction: 'right' }], /Nothing scrolls right from/)
      await act([{ type: 'evaluate', code: '(()=>{scrollTo(0,0);return 1})()' }])

      const fresh = text(await tool('browser.observe', { targetId }))
      const subscribe = refFor(fresh, 'checkbox', 'Subscribe')
      const slotted = refFor(fresh, 'button', 'Slotted action')
      assert.match(await act([{ type: 'click', refId: subscribe }]), new RegExp(`\\nclicked ${subscribe} → text "SUB:true" \\(settled \\d+ms\\)$`))
      assert.match(await act([{ type: 'click', refId: slotted }]), new RegExp(`\\nclicked ${slotted} → text "SLOTTED_OK" \\(settled \\d+ms\\)$`))

      const group = refFor(fresh, 'group', 'Options')
      const optionB = refFor(fresh, 'radio', 'Option B')
      const replaced = await act([{ type: 'check', refId: optionB }, { type: 'observe', refId: group, filter: 'interactive' }])
      assert.match(replaced, new RegExp(`^targetId: ${targetId}\\nchecked ${optionB} → text "OPTS_REPLACED" \\(settled \\d+ms\\)\\nobserved:\\nscope ${group} was replaced; observed page\\nFrames: 1`))
      await tool('browser.observe', { targetId, refId: group }, new RegExp(`Scoped ref ${group} is gone`))

      const head = text(await tool('browser.observe', { targetId, mode: 'text', maxChars: 40 }))
      const cursor = Number(/continue with cursor=(\d+)/.exec(head)[1])
      assert.equal(cursor, 40)
      const tail = text(await tool('browser.observe', { targetId, mode: 'text', maxChars: 20000, cursor }))
      assert.ok(!tail.includes('continue with cursor') && tail.includes('TEXT_END'), tail)
      await tool('browser.observe', { targetId, mode: 'text', filter: 'interactive' }, /refId\/filter\/depth\/compact require mode a11y/)
    } finally {
      await tool('browser.close', { targetId })
    }
  })
  await check('H2: open returns at dispatch; the first observe settles readiness', async () => {
    let started = performance.now()
    const opened = JSON.parse(text(await tool('browser.open', { url: `${rootUrl}/h-slow` })))
    const openMs = Math.round(performance.now() - started)
    assert.deepEqual(Object.keys(opened).sort(), ['tabId', 'targetId', 'url'])
    let observeMs
    try {
      started = performance.now()
      const first = text(await tool('browser.observe', { targetId: opened.targetId }))
      observeMs = Math.round(performance.now() - started)
      assert.ok(first.includes('SLOW_CONTENT_OK') && !first.includes('Loading…'), first)
      assert.ok(openMs < 100, `open took ${openMs}ms`)
    } finally {
      await tool('browser.close', { targetId: opened.targetId })
    }
    // A document whose DOMContentLoaded is held past the cap: open still
    // returns at once, the first read proceeds after about 4 s, close works.
    started = performance.now()
    const held = JSON.parse(text(await tool('browser.open', { url: `${rootUrl}/slow-ready` })))
    const heldOpenMs = Math.round(performance.now() - started)
    assert.ok(held.ready === undefined && heldOpenMs < 100, `${heldOpenMs}ms ${JSON.stringify(held)}`)
    started = performance.now()
    const shell = text(await tool('browser.observe', { targetId: held.targetId }))
    const heldObserveMs = Math.round(performance.now() - started)
    assert.ok(heldObserveMs >= 3500 && heldObserveMs < 6000, `${heldObserveMs}ms`)
    assert.match(shell, /Loading/)
    const closed = await tool('browser.close', { targetId: held.targetId })
    assert.equal((closed.structuredContent ?? JSON.parse(text(closed))).closed, true)
    return { openMs, observeMs, heldOpenMs, heldObserveMs }
  })
  await check('G: truncation footer lists scoped refs; ceilings', async () => {
    const opened = JSON.parse(text(await tool('browser.open', { url: `${rootUrl}/g-long` })))
    const targetId = opened.targetId
    try {
      const page = text(await tool('browser.observe', { targetId, maxChars: 20000 }))
      assert.ok(page.length <= 12000, `a11y is capped at 12000: ${page.length}`)
      const [body, footer] = page.split('\n[Truncated at 12000 chars; continue with cursor=')
      assert.ok(footer, page.slice(-600))
      assert.match(footer, /^\d+, or scope with refId to an unread section:\]\n/)
      const sections = footer.split('\n').slice(1)
      const reviews = refFor(sections.join('\n'), 'region', 'Reviews')
      assert.deepEqual(sections.map((line) => line.replace(/\[[a-z]{3}\d+\] /, '')), ['  region "Reviews"', '  heading "Reviews"', '  contentinfo ""'])
      assert.ok(!body.includes('REVIEW_OK') && !body.includes(`[${reviews}]`))
      const scoped = text(await tool('browser.observe', { targetId, refId: reviews }))
      assert.ok(scoped.includes('REVIEW_OK') && !scoped.includes('Truncated'), scoped)

      const content = text(await tool('browser.observe', { targetId, mode: 'text', maxChars: 20000 }))
      assert.ok(content.includes('REVIEW_OK') && content.length <= 20000, content.slice(-300))
      await tool('browser.observe', { targetId, maxChars: 20001 }, /maxChars is at most 20000/)
    } finally {
      await tool('browser.close', { targetId })
    }
  })
  await check('H1: act wait returns when its condition holds; a timeout continues', async () => {
    const opened = JSON.parse(text(await tool('browser.open', { url: `${rootUrl}/h-delayed` })))
    const targetId = opened.targetId
    try {
      const page = text(await tool('browser.observe', { targetId, filter: 'interactive' }))
      const [go, submit, dismiss] = [['button', 'Load results'], ['button', 'Submit'], ['button', 'Dismiss']].map(([role, name]) => refFor(page, role, name))
      const promo = refFor(text(await tool('browser.observe', { targetId })), 'alert', 'Promo')
      const loaded = text(await tool('browser.act', { targetId, steps: [
        { type: 'click', refId: go },
        // Case- and whitespace-insensitive, like an accessible name.
        { type: 'wait', text: 'results_ready  with' },
        { type: 'wait', textGone: 'Loading results' },
        { type: 'wait', refId: submit, state: 'enabled' },
        { type: 'click', refId: dismiss },
        { type: 'wait', refId: promo, state: 'hidden' },
      ] }))
      const lines = loaded.split('\n')
      assert.match(lines[1], new RegExp(`^clicked ${go} → `))
      // The click step already waited for its own changes to settle.
      const ms = Number(/^waited (\d+)ms until text "results_ready  with" appears$/.exec(lines[2])?.[1])
      assert.ok(ms >= 300 && ms <= 2500, loaded)
      assert.match(lines[3], /^waited \d+ms until text "Loading results" is gone$/)
      assert.match(lines[4], new RegExp(`^waited \\d+ms until ${submit} is enabled$`))
      assert.match(lines[6], new RegExp(`^waited \\d+ms until ${promo} is hidden$`))

      const started = performance.now()
      const timedOut = await tool('browser.act', { targetId, steps: [
        { type: 'wait', text: 'NEVER_THERE', timeoutMs: 600 },
        { type: 'evaluate', code: "document.querySelector('#out').textContent" },
      ] })
      assert.equal((timedOut.structuredContent ?? {}).status, 'ok')
      assert.match(text(timedOut), /\nwait not met after (6\d\d|7\d\d)ms: text "NEVER_THERE" appears; continuing\nevaluated: RESULTS_READY/)
      assert.ok(performance.now() - started < 3000)
      await tool('browser.act', { targetId, steps: [{ type: 'wait', ms: 500 }] }, /act wait takes a condition, not a delay/)
      await tool('browser.act', { targetId, steps: [{ type: 'wait', text: 'x', timeoutMs: 15001 }] }, true)
      return { textWaitMs: ms }
    } finally {
      await tool('browser.close', { targetId })
    }
  })
  await check('G: observe rereads once when the document changes mid-read', async () => {
    const opened = JSON.parse(text(await tool('browser.open', { url: `${rootUrl}/g-churn` })))
    const targetId = opened.targetId
    try {
      await tool('browser.act', { targetId, steps: [{ type: 'evaluate', code: "(()=>{document.querySelector('#f').src='/g-held-frame';return 1})()" }] })
      await waitUntil(() => heldFrame, 'held iframe navigation')
      const started = performance.now()
      const observing = tool('browser.observe', { targetId, maxChars: 2000 })
      // Commit the iframe's new document while the main tree is being collected.
      setTimeout(() => {
        heldFrame.end('<!doctype html><title>Late frame</title><p>LATE_FRAME</p>')
        heldFrame = undefined
      }, 150)
      const first = text(await observing)
      const elapsed = Math.round(performance.now() - started)
      assert.equal(first.split('\n')[0], 'document changed during observe; reread', `${elapsed}ms: ${first.slice(0, 200)}`)
      assert.equal(first.split('\n')[1], 'Frames: 2')
      assert.ok(first.length <= 2000)
      const again = text(await tool('browser.observe', { targetId, maxChars: 2000 }))
      assert.match(again, /^Frames: 2\n/)
      assert.equal(refFor(first, 'button', 'Row 0'), refFor(again, 'button', 'Row 0'))
    } finally {
      heldFrame?.end('')
      heldFrame = undefined
      await tool('browser.close', { targetId })
    }
  })
  await check(correctionCheck, async () => {
    try {
      const escaped = await tool('navigate', { tabId: internalTabId, url: rootUrl + '/redirect' })
      assert.ok(text(escaped).includes(rootUrl + '/blank'))
      await tool('navigate', { tabId: internalTabId, url: rootUrl + '/blank#ready' })
      await tool('javascript_tool', {
        tabId: internalTabId,
        code: `setTimeout(()=>location.href=${JSON.stringify(rootUrl + '/held-document')},0); 'scheduled'`,
      })
      await waitUntil(() => heldScript, 'held deferred script')
      let settled = false
      const pending = tool('navigate', { tabId: internalTabId, url: rootUrl + '/held-document#loading' })
        .then(result => { settled = true; return { result } }, error => { settled = true; return { error } })
      await waitUntil(async () => text(await tool('javascript_tool', {
        tabId: internalTabId, code: 'location.hash',
      })).includes('#loading'), 'same-document commitment while DOMContentLoaded is pending')
      assert.equal(settled, false, 'fragment commitment is not DOMContentLoaded')
      heldScript.end('window.deferredComplete = true')
      heldScript = undefined
      const outcome = await pending
      if (outcome.error) throw outcome.error
      assert.equal(text(outcome.result), `Navigated to ${rootUrl}/held-document#loading`)
      assert.equal(text(await tool('javascript_tool', { tabId: internalTabId, code: 'window.deferredComplete' })), 'true')
    } finally {
      heldScript?.end('window.deferredComplete = true')
      heldScript = undefined
      await tool('tabs_close', { tabId: internalTabId })
    }
  })

  await check('batch flow evaluates only after the intended document is ready', async () => {
    const batch = JSON.parse(text(await tool('browser.batch.flow', {
      urls: [`${rootUrl}/blank`, `${rootUrl}/scroll`], concurrency: 2,
      steps: [{ type: 'evaluate', code: 'document.title' }],
    })))
    assert.equal(batch.results[0].status, 'ok')
    assert.equal(batch.results[1].status, 'ok')
    assert.match(JSON.stringify(batch.results[0].results), /Benchmark ready/)
    assert.match(JSON.stringify(batch.results[1].results), /Scroll contract/)
  })
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
