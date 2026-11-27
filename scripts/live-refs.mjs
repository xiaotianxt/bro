#!/usr/bin/env node
// Opt-in real-browser contract test. Uses an isolated Chrome profile and bro
// process; never reloads the user's installed extension or copies login state.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const broBinary = option('--bro', resolve(repo, 'bin/bro'))
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
// Mirrors 1Password 8's in-page UI: a closed shadow host holding an iframe of
// the extension's own page, drawn at load and on username focus, erased on
// blur, and reusing the same iframe element on every redraw.
const passwordManager = resolve(output, 'password-manager-extension')
await mkdir(passwordManager, { recursive: true, mode: 0o700 })
await writeFile(resolve(passwordManager, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Password manager fixture', version: '1',
  content_scripts: [{ matches: ['http://127.0.0.1/password-manager*'], js: ['inline.js'], run_at: 'document_end' }],
  web_accessible_resources: [{ resources: ['menu.html'], matches: ['http://127.0.0.1/*'] }],
}))
await writeFile(resolve(passwordManager, 'menu.html'), '<!doctype html><p>Fixture menu</p>')
await writeFile(resolve(passwordManager, 'inline.js'), `let root, menu
function draw() {
  root ??= document.createElement('fixture-password-menu').attachShadow({ mode: 'closed' })
  if (!menu) { menu = document.createElement('iframe'); root.appendChild(menu) }
  menu.src = chrome.runtime.getURL('menu.html')
  if (!root.host.parentElement) document.body.appendChild(root.host)
}
draw()
document.addEventListener('focusin', (event) => { if (event.target.id === 'username') draw() })
document.addEventListener('focusout', (event) => { if (event.target.id === 'username') root?.host.remove() })`)
let token = ''
const log = await open(resolve(output, 'processes.log'), 'a')
const processes = []
let rootUrl, crossUrl, socket, client, heldScript, heldFrame
// Watch fixtures change only once the test releases their key, after it has
// seen the watch start; a change before the start would race the watch.
// A key holds the pending /watch-release response or, once released, true.
const watchGates = new Map()
const releaseWatch = (key) => {
  const held = watchGates.get(key)
  if (held && held !== true) held.end('released')
  watchGates.set(key, true)
}
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
// /h-data answers held until their page's /h-go, by page key.
const heldResults = new Map()
// /frozen-hold answers, by key: `arrived` resolves when the page asks, and
// release() answers it, whichever comes first.
const holds = new Map()
const hold = (key) => {
  let entry = holds.get(key)
  if (!entry) {
    let arrive
    entry = { arrived: new Promise((resolve) => (arrive = resolve)), arrive, res: undefined, released: false }
    entry.release = () => {
      entry.released = true
      entry.res?.end('ok')
    }
    holds.set(key, entry)
  }
  return entry
}
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
  if (url.pathname === '/watch') {
    // Watch shapes. Each changes after the test releases its key. Delays are
    // server-side unless the shape is about page timers, which Chrome
    // throttles in background tabs.
    const shape = url.searchParams.get('shape') ?? ''
    const key = url.searchParams.get('key') ?? ''
    send(`<!doctype html><title>Watch</title><main><h1>Jobs</h1>
    <ul id="jobs"><li class="job"><span role="status" aria-label="Job 1" class="state">Running</span></li></ul>
    <p id="toast"></p></main>
    <script>
    const shape=${JSON.stringify(shape)};
    // Chrome freezes no page that holds a Web Lock. A watch reports a tab
    // Chrome froze instead of its changes, so these pages hold one: what is
    // tested here is what a watch sees on a page that runs.
    navigator.locks.request('bro-watch-fixture-'+Math.random(),()=>new Promise(()=>{}));
    const data=(ms)=>fetch('/watch-data?ms='+ms).then(r=>r.text());
    const released=fetch('/watch-release?key='+${JSON.stringify(encodeURIComponent(key))}).then(()=>'Status Done');
    const state=()=>document.querySelector('.state');
    if(shape==='late')released.then(t=>{state().textContent=t});
    // The whole row is replaced: a pinned node is gone.
    if(shape==='rerender')released.then(t=>{jobs.innerHTML='<li class="job"><span role="status" aria-label="Job 1" class="state">'+t+'</span></li>'});
    if(shape==='navigate')released.then(()=>{location.href='/watch-next'});
    if(shape==='timer')released.then(()=>setTimeout(()=>{state().textContent='Status Done'},1000));
    // Shown for one task only, so no poll can see it; the page's latch can.
    // It repeats until the tab closes: the wait step gives no start signal
    // to release on, and one flash before its latch is installed is missed.
    const flash=()=>{toast.textContent='Saved Done';const c=new MessageChannel();c.port1.onmessage=()=>{toast.textContent=''};c.port2.postMessage(0);data(300).then(flash)};
    if(shape==='transient')released.then(flash);
    // Ten mutations a task, a task every 50 ms, and the page text never
    // changes: a watch must check once a task and report nothing.
    window.churnTasks=0;
    const churn=()=>{churnTasks++;for(let i=0;i<10;i++){toast.classList.toggle('on');toast.textContent=i%2?'':'tick'}data(50).then(churn)};
    if(shape==='churn')churn();
    </script>`)
    return
  }
  if (url.pathname === '/watch-chat') {
    // A support chat in a cross-site iframe, as on carrier support pages.
    send(`<!doctype html><title>Watch chat</title><main><h1>Account</h1>
    <iframe title="Support chat" src="${crossUrl}/watch-chat-frame?key=${encodeURIComponent(url.searchParams.get('key') ?? '')}" style="width:400px;height:300px"></iframe></main>`)
    return
  }
  if (url.pathname === '/watch-chat-frame') {
    // Each reply arrives when the test releases KEY/1, then KEY/2.
    const key = encodeURIComponent(url.searchParams.get('key') ?? '')
    send(`<!doctype html><title>Chat</title><ul id="msgs" aria-label="Messages"><li class="msg">Agent: Hi, how can I help?</li></ul>
    <script>
    const say=(t)=>{const li=document.createElement('li');li.className='msg';li.textContent=t;msgs.append(li)};
    const reply=(n)=>fetch('/watch-release?key=${key}%2F'+n);
    reply(1).then(()=>say('Agent: first reply')).then(()=>reply(2)).then(()=>say('Agent: renewal Done'));
    </script>`)
    return
  }
  if (url.pathname === '/watch-release') {
    const key = url.searchParams.get('key') ?? ''
    if (watchGates.get(key) === true) res.end('released')
    else watchGates.set(key, res)
    return
  }
  if (url.pathname === '/watch-next') {
    send(`<!doctype html><title>Watch next</title><main><p class="state">Loading</p></main>
    <script>fetch('/watch-data?ms=800').then(r=>r.text()).then(t=>{document.querySelector('.state').textContent=t})</script>`)
    return
  }
  if (url.pathname === '/watch-data') {
    const ms = Math.min(5000, Number(url.searchParams.get('ms')) || 0)
    setTimeout(() => res.end('Status Done'), ms).unref()
    return
  }
  if (url.pathname === '/frozen') {
    // Records the page's own freeze and resume events, so a cell can show the
    // tab was frozen. Each entry point's effect waits on a held request.
    const key = JSON.stringify(url.searchParams.get('key') ?? '')
    const controls = url.searchParams.has('read') ? '' : '<button id="go">Go</button><label>Note <input id="note"></label><div id="status"></div>'
    send(`<!doctype html><title>Frozen</title><main><p id="out">Loading…</p>${controls}</main>
    <script>
    window.ev=[];document.addEventListener('freeze',()=>ev.push('freeze'));document.addEventListener('resume',()=>ev.push('resume'));
    const held=(what)=>fetch('/frozen-hold?key='+encodeURIComponent(${key}+'/'+what)).then(r=>r.text());
    held('load').then(()=>{out.textContent='LOADED '+'the held content arrived and is long enough to read. '.repeat(3)});
    const status=()=>document.querySelector('#status');
    if(window.go)go.onclick=()=>held('click').then(()=>{status().innerHTML='<p role="alert">DONE click</p>'});
    if(window.note)note.oninput=()=>held('fill').then(()=>{status().innerHTML='<p role="alert">DONE fill</p>'});
    </script>`)
    return
  }
  if (url.pathname === '/frozen-hold') {
    const entry = hold(url.searchParams.get('key') ?? '')
    entry.res = res
    entry.arrive()
    if (entry.released) res.end('ok')
    return
  }
  if (url.pathname === '/h-delayed') {
    // Content that arrives 1.5 s after a click, on a request that was already
    // out before it: an act step does not wait for that, so a wait step must.
    // The delay is server-side, because background tabs align page timers to
    // about 1 s.
    send(`<!doctype html><title>H delayed</title><div role="alert" aria-label="Promo">Promo <button id="dismiss">Dismiss</button></div>
    <button id="go">Load results</button><p id="status"></p><button id="submit" disabled>Submit</button><div id="out"></div>
    <script>
    const key=Math.random().toString(36).slice(2);
    const results=fetch('/h-data?key='+key).then(r=>r.text());
    dismiss.onclick=()=>document.querySelector('[role=alert]').remove();
    go.onclick=async()=>{status.textContent='Loading results';fetch('/h-go?key='+key);out.textContent=await results;status.textContent='';submit.disabled=false};
    </script>`)
    return
  }
  if (url.pathname === '/h-data') {
    heldResults.set(url.searchParams.get('key'), res)
    return
  }
  if (url.pathname === '/h-go') {
    const held = heldResults.get(url.searchParams.get('key'))
    heldResults.delete(url.searchParams.get('key'))
    setTimeout(() => held?.end('RESULTS_READY with enough words to read'), 1500).unref()
    res.end('ok')
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
    // Trailing sections verify that incremental large-page reads still surface
    // unread landmarks and headings after 20,000 rows.
    send(`<!doctype html><title>G churn</title><iframe id="f" title="Churn" src="/blank"></iframe>
    <ul>${Array.from({ length: 20000 }, (_, i) => `<li><button>Row ${i}</button></li>`).join('')}</ul>
    <section aria-label="Trailing"><h2>Trailing</h2><p>TRAILING_OK</p></section>
    <footer>End</footer>`)
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
  if (url.pathname === '/popup-opener') {
    send(`<!doctype html><title>Popup opener</title><button onclick="window._popup=window.open('/popup', 'bro-popup', 'popup,width=420,height=320')">Open popup</button>`)
    return
  }
  if (url.pathname === '/popup') {
    send('<!doctype html><title>Popup</title><p>Popup window</p><script>setTimeout(() => window.close(), 4000)</script>')
    return
  }
  if (url.pathname === '/lazy-feed') {
    // Cards render only after IntersectionObserver and requestAnimationFrame
    // fire, which Chrome withholds from tabs that are not shown.
    send(`<!doctype html><title>Lazy feed</title><nav>Home Shorts Subscriptions</nav><main id="grid"><div id="sentinel" style="height:10px"></div></main>
    <script>
      new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return
        requestAnimationFrame(() => {
          for (let i = 0; i < 12; i++) {
            const card = document.createElement('article')
            card.textContent = 'LAZY_CARD_' + i + ' video title'
            grid.insertBefore(card, sentinel)
          }
        })
      }).observe(sentinel)
    </script>`)
    return
  }
  if (url.pathname === '/app-feed') {
    // A single-page app: the document completes with only its chrome (enough
    // words to pass a length check), then the post arrives from a slow API.
    // ?spinner=1 shows an indeterminate progressbar meanwhile; a determinate
    // one (a video's) stays after load. A widget's shadow root carries a
    // <style> and a hidden panel that are not page text.
    const spinner = url.searchParams.get('spinner') === '1'
    send(`<!doctype html><title>App feed</title>
    <nav aria-label="Primary">Explore Bookmarks Communities Premium Profile Lists Topics Settings Help Shortcuts Accessibility Display Languages Ads info</nav>
    <main>${spinner ? '<div id="spinner" role="progressbar" aria-label="Loading timeline" style="width:24px;height:24px"></div>' : ''}<div id="feed"></div></main>
    <div id="widget"></div>
    <script>
    const shadow = document.querySelector('#widget').attachShadow({ mode: 'open' })
    shadow.innerHTML = '<style>:host { position: fixed; z-index: 2147483647 }</style><button>GUARD_WIDGET</button><div style="display:none">HIDDEN_SHADOW_TEXT</div>'
    fetch('/app-post' + location.search).then((r) => r.text()).then((post) => {
      document.querySelector('#feed').innerHTML = '<article>' + post + '</article><div role="progressbar" aria-valuenow="0" aria-valuemax="100" style="width:80px;height:4px"></div>'
      document.querySelector('#spinner')?.remove()
    })
    </script>`)
    return
  }
  if (url.pathname === '/app-post') {
    // Server-side delay: background tabs align page timers to about 1 s, and
    // the gap must outlast several of bro's stable-text polls. Each page asks
    // with its own query: Chrome's cache lock serializes identical URLs.
    setTimeout(() => res.end('APP_POST_BODY ' + 'The post body arrived from the API after the shell had settled. '.repeat(8)), 2000).unref()
    return
  }
  if (url.pathname === '/slow-post') {
    setTimeout(() => send('<!doctype html><title>Posted</title><p>POSTED</p>'), 1200)
    return
  }
  if (url.pathname === '/blank') {
    send('<!doctype html><title>Benchmark ready</title><p>Ready</p>')
    return
  }
  if (url.pathname === '/net-echo') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ bro: url.searchParams.get('bro') }))
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
    // arrives over the network. Submit posts and answers after more than the
    // settle quiet period.
    send(`<!doctype html><title>Token form</title><h1>New token</h1>
    <label>Token name <input id="name"></label>
    <button id="exp">Expiration: 30 days</button><div id="exp-menu"></div>
    <button id="access">Access: Read-only</button><div id="access-menu"></div>
    <button id="generate">Generate token</button><div id="status"></div>
    <form method="post" action="/slow-post"><button>Submit post</button></form>
    <label>Expires <input type="date" id="expires"></label>
    <button id="perms">Permissions</button><div id="perm-panel"></div>
    <script>
    let renders=0;const state={exp:'30 days',access:'Read-only'};
    const later=f=>{const c=new MessageChannel();c.port1.onmessage=()=>f();c.port2.postMessage(0)};
    const menu=(root,label,items,pick)=>{renders++;root.innerHTML='<div role="menu" aria-label="'+label+'">'+items.map((t,i)=>'<div role="menuitem" id="_r_'+renders+'_'+i+'" style="padding:4px">'+t+'</div>').join('')+'</div>';
      root.querySelectorAll('[role=menuitem]').forEach(item=>item.onclick=()=>{root.innerHTML='';later(()=>pick(item.textContent))})};
    document.querySelector('#exp').onclick=()=>menu(document.querySelector('#exp-menu'),'Expiration',['7 days','30 days','90 days'],v=>{state.exp=v;document.querySelector('#exp').textContent='Expiration: '+v});
    document.querySelector('#access').onclick=()=>menu(document.querySelector('#access-menu'),'Access',['Read-only','Read and write'],v=>{state.access=v;document.querySelector('#access').textContent='Access: '+v});
    document.querySelector('#perms').onclick=()=>{document.querySelector('#perm-panel').innerHTML='<div role="dialog" aria-label="Permissions"><label><input type="checkbox">Contents</label></div>'};
    // Like GitHub's multi-select panel: no close button, only Escape closes it.
    document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('#perm-panel').innerHTML=''});
    document.querySelector('#generate').onclick=()=>fetch('/blank').then(()=>{document.querySelector('#status').innerHTML=state.access==='Read and write'?'<p>TOKEN_CREATED '+document.querySelector('#name').value+' '+state.exp+'</p>':'<p role="alert">Contents needs read and write access</p>'});
    </script>`)
    return
  }
  if (url.pathname === '/req-form') {
    // One page per cell of check R. Every trigger (click, Enter, select) runs
    // the page's shape. Request URLs are unique: Chrome's cache lock
    // serializes identical URLs.
    const shape = url.searchParams.get('shape')
    send(`<!doctype html><title>Request form</title>
    <button id="run">Run</button>
    <label>Query <input id="query"></label>
    <label>Mode <select id="mode"><option value="idle">Idle</option><option value="go">Go</option></select></label>
    <div id="status"></div>
    <script>
    const shape=${JSON.stringify(shape)};let n=0;
    const req=(q)=>'/req?'+q+'&k='+Math.random().toString(36).slice(2)+(n++);
    const done=()=>{document.querySelector('#status').innerHTML='<p role="alert">DONE '+shape+'</p>'};
    // A request already in flight before the action is not the action's.
    if(shape==='inflight')fetch(req('hang=1'));
    const run=()=>{
      if(shape==='fast')fetch(req('ms=30')).then(r=>r.text()).then(done);
      if(shape==='slow')fetch(req('ms=1500')).then(r=>r.text()).then(done);
      if(shape==='chained')fetch(req('ms=700')).then(r=>r.text()).then(()=>fetch(req('ms=700'))).then(r=>r.text()).then(done);
      if(shape==='unread')fetch(req('ms=600')).then(done);
      // Its own host: Chrome retries a GET dropped on a reused connection,
      // and every connection to this host is dropped, so none is reused.
      if(shape==='failed')fetch('//localhost:'+location.port+req('fail=1&ms=900')).catch(done);
      if(shape==='hang')fetch(req('hang=1'));
      if(shape==='beacon'){navigator.sendBeacon(req('beacon=1'),'x');done()}
      if(shape==='inflight')done();
    };
    document.querySelector('#run').onclick=run;
    document.querySelector('#query').onkeydown=e=>{if(e.key==='Enter')run()};
    document.querySelector('#mode').onchange=run;
    </script>`)
    return
  }
  if (url.pathname === '/req') {
    // hang never answers within a cell; fail drops the connection after ms.
    if (url.searchParams.has('hang')) {
      setTimeout(() => res.end('late'), 20_000).unref()
      return
    }
    const ms = Number(url.searchParams.get('ms') ?? 0)
    setTimeout(() => (url.searchParams.has('fail') ? res.destroy() : res.end('ok')), ms).unref()
    return
  }
  if (url.pathname === '/scroll-page') {
    res.end('<!doctype html><title>Page wheel contract</title><main role="region" aria-label="Scroll panel" style="height:3000px">Long document</main><output id="scroll-state" style="position:fixed;top:0;right:0">SCROLL_TOP:0</output><script>document.addEventListener("scroll",()=>document.querySelector("#scroll-state").textContent="SCROLL_TOP:"+Math.round(scrollY));</script>')
    return
  }
  if (url.pathname === '/password-manager') {
    res.end('<!doctype html><title>Password manager contract</title><form onsubmit="event.preventDefault();out.textContent=\'SIGNED_IN:\'+username.value+\'/\'+password.value.length"><label>Username <input id="username" autocomplete="username"></label><label>Password <input id="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form><output id="out">SIGNED_OUT</output>')
    return
  }
  if (url.pathname === '/uploads') {
    // The upload patterns of real pages: an input hidden behind a button, one
    // created on click and never attached, a single-file input, an input under
    // its own drop label (FilePond), a button that ignores untrusted clicks
    // (plupload), a role-less menu item (canvas apps), showOpenFilePicker, and
    // a drop-only zone.
    send(`<!doctype html><title>Upload patterns</title><style>button,.zone{display:block;margin:4px}</style>
    <button id="hidden">Pick hidden</button><input id="hidden-input" type="file" multiple style="display:none">
    <button id="created">Pick created</button><button id="single">Pick single</button><input id="single-input" type="file" hidden>
    <div style="position:relative;width:240px;height:40px"><input id="covered" type="file" aria-label="Covered input" style="width:100%;height:100%"><div id="covered-label" style="position:absolute;inset:0;background:#eee">Drop or browse</div></div>
    <button id="trusted">Pick trusted</button><span id="menu" style="display:inline-block;padding:6px">Open from computer</span>
    <button id="inert">No chooser</button><button id="fsa">Pick system</button>
    <div class="zone" role="region" aria-label="Drop zone" style="width:240px;height:60px;border:1px dashed">Drop files here</div>
    <output id="upload-result" aria-live="polite">none</output><script>
    const show=async (label,files)=>document.querySelector('#upload-result').textContent=label+':'+(await Promise.all([...files].map(async f=>f.name+'='+await f.text()))).join(',');
    const $=s=>document.querySelector(s),hidden=$('#hidden-input'),single=$('#single-input'),covered=$('#covered');
    $('#hidden').onclick=()=>hidden.click();hidden.onchange=()=>show('HIDDEN',hidden.files);
    $('#single').onclick=()=>single.click();single.onchange=()=>show('SINGLE',single.files);
    $('#created').onclick=()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.onchange=()=>show('CREATED',i.files);i.click()};
    $('#covered-label').onclick=()=>covered.click();covered.onchange=()=>show('COVERED',covered.files);
    $('#trusted').onclick=e=>{if(e.isTrusted)hidden.click()};
    $('#menu').onclick=()=>single.click();
    $('#fsa').onclick=()=>showOpenFilePicker().then(()=>show('FSA',[]),e=>$('#upload-result').textContent='FSA_ERROR:'+e.name);
    const zone=$('.zone');zone.ondragover=e=>e.preventDefault();zone.ondrop=e=>{e.preventDefault();show('DROPPED',e.dataTransfer.files)};
    </script>`)
    return
  }
  if (url.pathname === '/upload-form') {
    // One file per form post, as report and ticket intake forms take them:
    // every Upload navigates, so refs from the previous document are gone.
    const name = url.searchParams.get('UploadedFile'), count = Number(url.searchParams.get('count') ?? 0) + (name ? 1 : 0)
    const done = name ? `<output id="uploaded">${name} uploaded: ${url.searchParams.get('Description')} (files ${count})</output>` : ''
    send(`<!doctype html><title>Upload form</title>${done}<form action="/upload-form">
    <input type="file" name="UploadedFile" aria-label="Attachment"><textarea name="Description" aria-label="Description"></textarea>
    <input type="hidden" name="count" value="${count}"><button>Upload</button></form>`)
    return
  }
  if (url.pathname === '/dialogs') {
    res.end('<!doctype html><title>Dialog contract</title><button onclick="out.textContent=confirm(\'Proceed?\')?\'OK\':\'CANCEL\'">Confirm</button><button onclick="out.textContent=\'PROMPT:\'+prompt(\'Name?\')">Prompt</button><button onclick="alert(\'Saved\');out.textContent=\'ALERTED\'">Alert</button><output id="out">NONE</output>')
    return
  }
  if (url.pathname === '/console') {
    res.end('<!doctype html><title>Console contract</title><script>let pageOwned = 1</script><button onclick="this.textContent=\'PRESSED\'">Press me</button>')
    return
  }
  if (url.pathname === '/bands') {
    res.end('<!doctype html><title>Screenshot bands</title><style>body{margin:0}</style><div style="height:1500px;background:#f00"></div><div style="height:3000px;background:#00f"></div>')
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
const connectClient = async () => {
  const connected = new Client({ name: 'bro-live-refs', version: '1.0.0' })
  await connected.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  return connected
}
// Checks share one MCP session, as an agent's parallel calls do. A check that
// relies on session state (the last target) calls on a session of its own.
const toolOn = (session) => async (name, args = {}, errorExpected = false) => {
  cancellation.signal.throwIfAborted()
  const result = await session.callTool({ name, arguments: args }, undefined, {
    signal: cancellation.signal,
  })
  if (!errorExpected && result.isError) throw new Error(`${name}: ${text(result)}`)
  if (errorExpected) {
    assert.equal(result.isError, true, `${name} should fail, not act on another node`)
    if (errorExpected instanceof RegExp) assert.match(text(result), errorExpected)
  }
  return result
}
const tool = (...call) => toolOn(client)(...call)
// Targets on the published surface: an opened tab, or an attached one for a
// tab the fixture navigates itself. Element actions on raw read_page refs go
// through browser.act on the tab's target.
const targets = new Map()
async function openTarget(url, active) {
  const opened = (await tool('browser.open', { url, active, observe: false })).structuredContent
  targets.set(opened.tabId, opened.targetId)
  return opened
}
async function closeTarget(opened) {
  targets.delete(opened.tabId)
  await tool('browser.close', { targetId: opened.targetId })
}
async function act(tabId, steps, errorExpected = false) {
  if (!targets.has(tabId)) {
    const attached = await tool('browser.attach', { tabId, observe: false })
    targets.set(tabId, attached.structuredContent.targetId)
  }
  return tool('browser.act', { targetId: targets.get(tabId), steps }, errorExpected)
}
// The test's own DevTools connection to the browser, beside bro's: it changes
// a page's state (freezes it) the way Chrome would, without going through bro.
async function browserSession() {
  const [port, path] = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await once(ws, 'open')
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result)
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject, method })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
    })
  return {
    send,
    // A session on the page target showing this URL.
    async page(url) {
      const { targetInfos } = await send('Target.getTargets')
      const target = targetInfos.find((t) => t.type === 'page' && t.url === url)
      assert.ok(target, `no page target at ${url}`)
      return (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
    },
    close: () => ws.close(),
  }
}
const refFor = (snapshot, role, name) => {
  const line = snapshot
    .split('\n')
    .find((line) => line.includes(`] ${role} ${JSON.stringify(name)}`))
  assert.ok(line, `Missing ${role} ${name}: ${snapshot}`)
  return line.match(/\[([a-z]{3}\d+)\]/)[1]
}
async function withBackgroundPanel(test, path = '/scroll') {
  const foreground = await openTarget(rootUrl + '/blank', true)
  const background = await openTarget(rootUrl + path, false)
  try {
    // open returns at dispatch, and the tab's first document is a complete
    // about:blank: readiness is the fixture's own document loaded.
    await waitUntil(
      async () =>
        text(
          await tool('javascript_tool', {
            tabId: background.tabId,
            code: `location.pathname === ${JSON.stringify(path)} && document.readyState === "complete"`,
          }),
        ).includes('true'),
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
    await closeTarget(background)
    await closeTarget(foreground)
  }
}

// Checks register here and run after setup: those that need the whole browser
// one at a time, then the rest concurrently on the shared MCP session, then
// the last. A check is exclusive when it activates or closes a tab, takes
// window focus, or asserts which tab is active or visible: any of these
// changes what concurrent checks' background tabs are.
const registered = []
function check(name, options, test) {
  if (!test) [options, test] = [{}, options]
  // A substring of the name, or several separated by |.
  const selected = option('--checks', '')
  if (selected && !selected.split('|').some((part) => name.includes(part))) return
  registered.push({ name, test, index: registered.length, ...options })
}
// A fresh fixture document of its own for each check that reads it: failures
// cannot poison another contract's field values, event counters, or overlay
// state, and concurrent checks cannot navigate each other's tab.
async function openFixture() {
  const opened = await openTarget(rootUrl, false)
  // Navigation/load readiness belongs to fixture setup, not a hidden action retry.
  await waitUntil(
    () =>
      tool('javascript_tool', {
        tabId: opened.tabId,
        code: 'document.readyState === "complete" && document.querySelectorAll("iframe").length === 3',
      }).then(
        (probed) => text(probed).includes('true'),
        (error) => {
          // A document that has only just committed has no script context yet.
          if (/Cannot find default execution context/.test(error.message)) return false
          throw error
        },
      ),
    'fresh fixture document',
  )
  return opened
}
const suiteStart = performance.now()
async function run({ name, test, index, fixture }) {
  const start = performance.now()
  const startedAt = Math.round((start - suiteStart) / 100) / 10
  try {
    const opened = fixture && (await openFixture())
    let measured
    try {
      // A contract may return measurements worth keeping with its result.
      measured = await test(opened)
    } finally {
      if (opened) await closeTarget(opened)
    }
    checks.push({ name, index, startedAt, pass: true, seconds: (performance.now() - start) / 1000, ...(measured && { measured }) })
    console.log('PASS', name)
  } catch (error) {
    if (cancellation.signal.aborted) throw error
    checks.push({ name, index, startedAt, pass: false, seconds: (performance.now() - start) / 1000, error: String(error).replaceAll(token, '[redacted]') })
    console.log('FAIL', name, String(error).replaceAll(token, '[redacted]'))
  }
}
async function runPool(items, limit, fn) {
  const queue = items.map((item, index) => ({ item, index }))
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const next = queue.shift()
        await fn(next.item, next.index)
      }
    }),
  )
}
async function runChecks() {
  const concurrency = Number(option('--concurrency', '4'))
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1, '--concurrency takes a positive integer')
  const phases = {}
  const timed = async (phase, work) => {
    const start = performance.now()
    await work()
    phases[phase] = Math.round((performance.now() - start) / 100) / 10
  }
  await timed('exclusive', async () => {
    for (const c of registered.filter((c) => c.exclusive && !c.last)) await run(c)
  })
  // The pool takes at least as long as its longest check, so long ones start first.
  const queue = registered.filter((c) => !c.exclusive).sort((a, b) => Number(!!b.long) - Number(!!a.long))
  await timed('pool', () =>
    Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) await run(queue.shift())
    })),
  )
  await timed('last', async () => {
    for (const c of registered.filter((c) => c.last)) await run(c)
  })
  checks.sort((a, b) => a.index - b.index)
  for (const c of checks) delete c.index
  console.log(`Phases (s, pool of ${concurrency}):`, JSON.stringify(phases))
  return { concurrency, phases }
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
  // chrome://discards discards a tab on demand, as Chrome's own policy does;
  // Chromium builds that hide debug pages show them with this preference.
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await writeFile(resolve(profile, 'Local State'), JSON.stringify({ internal_only_uis_enabled: true }))
  // The extension pairs itself through bro's native host, as after
  // `bro setup`: Chrome looks for hosts in the profile's NativeMessagingHosts.
  // The wrapper points the host at the isolated settings, not the user's.
  const nativeHost = resolve(output, 'native-host.sh')
  const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`
  await writeFile(nativeHost, `#!/bin/sh\nHOME=${shellQuote(brokerHome)} exec ${shellQuote(broBinary)} "$@"\n`, { mode: 0o755 })
  await mkdir(resolve(profile, 'NativeMessagingHosts'), { recursive: true, mode: 0o700 })
  // Chrome derives an extension's ID from its manifest key.
  const { key } = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'))
  assert.ok(key, 'the extension manifest must pin its ID with a key')
  const extensionId = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)))
  await writeFile(resolve(profile, 'NativeMessagingHosts', 'com.xiaotianxt.bro.json'), JSON.stringify({
    name: 'com.xiaotianxt.bro', description: 'bro live-refs pairing', path: nativeHost, type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }))
  // This disposable profile has no user login state. On macOS it must not
  // block on or access the user's real Safe Storage Keychain item.
  launch(chromeBinary, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    `--load-extension=${resolve(extension)},${passwordManager}`,
    `--disable-extensions-except=${resolve(extension)},${passwordManager}`,
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
      // No token: the extension must get it by pairing.
      expression: `chrome.storage.sync.set({serverUrl:'ws://127.0.0.1:${port}/ws'})`,
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
  if (option('--checks', '').split('|').some((part) => correctionCheck.includes(part))) {
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
  client = await connectClient()
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
  // The browser's first act takes seconds (process and debugger start-up);
  // load the fixture once so no contract's latency bound measures that.
  await closeTarget(await openFixture())
  check('background scroll: wheel and batched ref scroll render without activation', { exclusive: true }, async () => {
    await withBackgroundPanel(async (background, refId) => {
      const wheel = () => tool('computer', {
        tabId: background.tabId, action: 'scroll',
        coordinate: [100, 40], direction: 'down', amount: 1,
      })
      const state = async () => JSON.parse(text(await tool('javascript_tool', {
        tabId: background.tabId,
        code: '({top: document.querySelector("#panel").scrollTop, text: document.querySelector("#scroll-state").textContent})',
      })))
      await wheel()
      const moved = await state()
      assert.equal(moved.top, 120, '/scroll: wheel must actually move the background scroller')
      assert.equal(moved.text, 'SCROLL_TOP:120')
      await tool('wait_for_element', { tabId: background.tabId, refId })
      const info = () => tool('get_element_info', { tabId: background.tabId, refId }).then((r) => JSON.parse(text(r)))
      assert.equal((await info()).scroll.top, 120)
      const read = { type: 'observe', mode: 'text' }
      const batched = (
        await act(background.tabId, [
          { type: 'scroll', refId, direction: 'down', amount: 100 },
          read,
          { type: 'scroll', refId, direction: 'down', amount: 10000 },
          read,
          { type: 'scroll', refId, direction: 'down', amount: 100 },
          read,
        ])
      ).structuredContent
      assert.equal(batched.status, 'ok')
      assert.deepEqual(
        batched.results.filter((r) => r.type === 'observe').map((r) => r.content.match(/SCROLL_TOP:(\d+)/)?.[1]),
        ['220', '920', '920'],
      )
      const scrolls = batched.results.filter((r) => r.type === 'scroll').map((r) => r.result)
      assert.deepEqual(scrolls.map((r) => r.moved), [true, true, false])
      assert.deepEqual(scrolls.map((r) => r.boundary), [false, true, true])
      assert.equal((await info()).scroll.top, 920)
      // A page may intentionally consume the wheel. Dispatch is not a claim
      // of movement, and must never fall back to DOM scrolling or replay.
      const beforePrevent = await state()
      await tool('javascript_tool', {
        tabId: background.tabId,
        code: 'document.addEventListener("wheel", e => e.preventDefault(), {passive:false})',
      })
      assert.match(text(await wheel()), /Dispatched wheel/)
      assert.deepEqual(await state(), beforePrevent)
    }, '/scroll')
    await withBackgroundPanel(async (background) => {
      const wheel = () => tool('computer', {
        tabId: background.tabId, action: 'scroll',
        coordinate: [100, 40], direction: 'down', amount: 1,
      })
      const state = async () => JSON.parse(text(await tool('javascript_tool', {
        tabId: background.tabId,
        code: '({top: document.scrollingElement.scrollTop, text: document.querySelector("#scroll-state").textContent})',
      })))
      await wheel()
      const moved = await state()
      assert.equal(moved.top, 120, '/scroll-page: wheel must actually move the background scroller')
      assert.equal(moved.text, 'SCROLL_TOP:120')
      await tool('javascript_tool', {
        tabId: background.tabId,
        code: 'document.addEventListener("wheel", e => e.preventDefault(), {passive:false})',
      })
      assert.match(text(await wheel()), /Dispatched wheel/)
      assert.deepEqual(await state(), moved)
    }, '/scroll-page')
  })
  check('refs: cross-frame AX labels, isolation, staleness, occlusion, upload and act failure semantics', { fixture: true }, async ({ tabId, targetId }) => {
    const snapshot = text(await tool('read_page', { tabId, filter: 'all', maxChars: 24000 }))
    for (const kind of ['Same', 'Cross', 'Nested']) {
      refFor(snapshot, 'textbox', `${kind} Name`)
      refFor(snapshot, 'button', `${kind} Commit`)
    }
    assert.match(snapshot, /^Frames: 5\n/)
    assert.doesNotMatch(snapshot, /unavailable/)

    // Default target observation and ref steps work without frame IDs; failures stop the act.
    const observeTarget = async () => (await tool('browser.observe', { targetId })).structuredContent.content
    const observed = await observeTarget()
    await tool('browser.act', {
      targetId,
      steps: [
        { type: 'fill', refId: refFor(observed, 'textbox', 'Cross Name'), value: 'Flow' },
        { type: 'select', refId: refFor(observed, 'combobox', 'Cross Mode'), value: 'Gamma' },
        { type: 'click', refId: refFor(observed, 'button', 'Cross Commit') },
      ],
    })
    let next = await observeTarget()
    assert.match(next, /Cross_OK:Flow:gamma:trusted=true/)
    const failed = (
      await tool('browser.act', {
        targetId,
        steps: [
          { type: 'click', refId: 'ref_deliberately_stale' },
          { type: 'fill', refId: refFor(next, 'textbox', 'Cross Name'), value: 'WRONG' },
        ],
      }, true)
    ).structuredContent
    assert.equal(failed.stoppedAt, 0)
    assert.equal(failed.results.length, 1)
    await tool('browser.act', {
      targetId,
      steps: [
        { type: 'fill', refId: refFor(next, 'textbox', 'Cross Name'), value: 'WRONG' },
        { type: 'click', refId: 'ref_invalid', css: 'button' },
      ],
    }, true)
    assert.match(await observeTarget(), /textbox "Cross Name" value="Flow"/)

    // Cross-site document-bound ref file upload.
    const local = resolve(output, 'upload-ref.txt')
    await writeFile(local, 'REF_PATH_UPLOAD_OK')
    await tool('file_upload', { tabId, refId: refFor(snapshot, 'button', 'Cross File'), paths: [local] })
    await waitUntil(
      async () => /upload-ref.txt:REF_PATH_UPLOAD_OK/.test(text(await tool('read_page', { tabId, filter: 'all', maxChars: 24000 }))),
      'cross-site upload result',
    )
    await tool('file_upload', { tabId, refId: refFor(snapshot, 'button', 'Cross File'), paths: ['relative.txt'] }, /must be absolute/)

    // Refs cannot escape their tab and survive same-node rereads.
    const rootRef = refFor(snapshot, 'textbox', 'Root Name')
    const other = await openTarget(rootUrl + '/blank', false)
    try {
      await act(other.tabId, [{ type: 'fill', refId: rootRef, value: 'wrong' }], true)
    } finally {
      await closeTarget(other)
    }
    const reread = text(await tool('read_page', { tabId }))
    assert.equal(refFor(reread, 'textbox', 'Root Name'), rootRef)
    await act(tabId, [{ type: 'fill', refId: rootRef, value: 'reread success' }])

    // Covered/disabled clicks and invalid selects fail before action.
    await act(tabId, [{ type: 'click', refId: refFor(snapshot, 'button', 'Disabled') }], /disabled/i)
    await act(tabId, [{ type: 'fill', refId: refFor(snapshot, 'textbox', 'Read only'), value: 'wrong' }], /read.only/i)
    await act(tabId, [{ type: 'select', refId: refFor(snapshot, 'combobox', 'Same Mode'), value: 'missing' }], /enabled option/i)
    await tool('javascript_tool', {
      tabId,
      code: '(()=>{const el=document.createElement("div");el.id="overlay";el.style="position:fixed;inset:0;z-index:999999;background:white";document.body.append(el);return true})()',
    })
    await act(tabId, [{ type: 'click', refId: refFor(snapshot, 'button', 'Root Commit') }], /covered by [a-z]{3}\d+ <div id=\\?"overlay\\?">; no click dispatched/)
    await tool('javascript_tool', { tabId, code: 'document.querySelector("#overlay").remove()' })
    assert.match(text(await tool('javascript_tool', { tabId, code: 'document.querySelector("#root-result").textContent' })), /not clicked/)

    // Detached/clone replacement refs fail instead of silently retargeting.
    await tool('javascript_tool', {
      tabId,
      code: '(()=>{const old=document.querySelector("#root-name");const c=old.cloneNode(true);c.value="";old.replaceWith(c);return true})()',
    })
    await act(tabId, [{ type: 'fill', refId: rootRef, value: 'wrong' }], true)
    assert.equal(text(await tool('javascript_tool', { tabId, code: 'document.querySelector("#root-name").value' })), '""')

    // Navigation invalidates refs to the old iframe document.
    const sameRef = refFor(snapshot, 'textbox', 'Same Name')
    await tool('javascript_tool', { tabId, code: 'document.querySelector("#same").src="/form?kind=New"' })
    await waitUntil(async () => text(await tool('frames_list', { tabId })).includes('kind=New'), 'iframe navigation')
    await act(tabId, [{ type: 'fill', refId: sameRef, value: 'wrong' }], true)
  })
  // Input lands, or is reported failed, whatever the tab's render state. The
  // browser routes input into a cross-site frame by hit-test data that follows
  // composited frames; a tab that is not painting (a background or unowned tab,
  // or a document with no frame drawn yet) has none until one is drawn, and a
  // silent miss lands in the parent instead. Each cell starts from a fresh
  // document; background/unowned cells run concurrently while a foreground tab
  // stays active.
  check('P: input lands in every render state across same-document, cross-site and nested frames', { exclusive: true }, async () => {
    const devtools = await browserSession()
    const js = async (id, code, frameId) => text(await tool('javascript_tool', { tabId: id, code, ...(frameId && { frameId }) }))
    const fresh = async (id, url) => {
      await tool('navigate', { tabId: id, url })
      await waitUntil(
        async () => (await js(id, 'document.readyState === "complete" && document.querySelectorAll("iframe").length === 3')).includes('true'),
        'matrix fixture',
      )
    }
    const unowned = async (url) => {
      await devtools.send('Target.createTarget', { url, background: true })
      const listed = await waitUntil(async () => {
        const tabs = text(await tool('tabs_context', { all: true }))
        return tabs.includes(url) && tabs
      }, 'unowned tab')
      const id = Number(listed.split('\n').find((line) => line.includes(url) && /\[\d+\]/.test(line)).match(/\[(\d+)\]/)[1])
      return { tabId: id, close: async () => { targets.delete(id); await tool('tabs_close', { tabId: id }) } }
    }
    const states = {
      'active, visible': async (url) => {
        const opened = await openTarget(url, true)
        return { tabId: opened.tabId, close: () => closeTarget(opened) }
      },
      background: async (url) => {
        const opened = await openTarget(url, false)
        return { tabId: opened.tabId, close: () => closeTarget(opened) }
      },
      unowned: async (url) => unowned(url),
      'unowned, just navigated': async (url) => unowned(url),
    }
    const crossFrame = async (id) =>
      JSON.parse(text(await tool('frames_list', { tabId: id }))).find((frame) => frame.url.includes('kind=Cross')).frameId
    const entries = {
      'same-document click': {
        act: async (id, snap) => act(id, [{ type: 'click', refId: refFor(snap, 'button', 'Root Commit') }]),
        landed: async (id) => /ROOT_OK:true/.test(await js(id, 'document.querySelector("#root-result").textContent')),
      },
      'cross-site click': {
        act: async (id, snap) => act(id, [{ type: 'click', refId: refFor(snap, 'button', 'Cross Commit') }]),
        landed: async (id) => /Cross_OK:/.test(await js(id, 'document.querySelector("#result").textContent', await crossFrame(id))),
      },
      'cross-site coordinate click': {
        act: async (id) => {
          const inner = 'document.querySelector("#host").shadowRoot.querySelector("#inner").shadowRoot.querySelector("button")'
          const local = JSON.parse(JSON.parse(await js(id, `JSON.stringify((r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))(${inner}.getBoundingClientRect()))`, await crossFrame(id))))
          const frame = JSON.parse(JSON.parse(await js(id, 'JSON.stringify((f => { const r = f.getBoundingClientRect(), s = getComputedStyle(f); return { x: r.left + f.clientLeft + parseFloat(s.paddingLeft), y: r.top + f.clientTop + parseFloat(s.paddingTop) } })(document.querySelectorAll("iframe")[1]))')))
          return tool('computer', { tabId: id, action: 'left_click', coordinate: [Math.round(frame.x + local.x), Math.round(frame.y + local.y)] })
        },
        landed: async (id) => /Cross_OK:/.test(await js(id, 'document.querySelector("#result").textContent', await crossFrame(id))),
      },
      'cross-site fill': {
        act: async (id, snap) => act(id, [{ type: 'fill', refId: refFor(snap, 'textbox', 'Cross Name'), value: 'Matrix' }]),
        landed: async (id) => (await js(id, 'document.querySelector("#host").shadowRoot.querySelector("#inner").shadowRoot.querySelector("#name").value', await crossFrame(id))) === '"Matrix"',
      },
      'nested shadow fill/select/click': {
        act: async (id, snap) => {
          for (const kind of ['Same', 'Cross', 'Nested']) {
            await act(id, [
              { type: 'fill', refId: refFor(snap, 'textbox', `${kind} Name`), value: 'Luna' },
              { type: 'select', refId: refFor(snap, 'combobox', `${kind} Mode`), value: kind === 'Same' ? 'Gamma' : 'gamma' },
              { type: 'click', refId: refFor(snap, 'button', `${kind} Commit`) },
            ])
          }
          return { isError: false }
        },
        landed: async (id) => {
          const observed = text(await tool('read_page', { tabId: id, filter: 'all', maxChars: 24000 }))
          return ['Same', 'Cross', 'Nested'].every((k) => new RegExp(`${k}_OK:Luna:gamma:trusted=true:input=2`).test(observed))
        },
      },
    }
    // Orthogonal matrix: active tests cross-site clicks; background and unowned
    // states test cross-site/coordinate/fill/same-doc/nested shadow paths.
    const fgCells = [
      ['active, visible', 'cross-site click'],
      ['active, visible', 'cross-site coordinate click'],
    ]
    const bgCells = [
      ['background', 'same-document click'],
      ['background', 'cross-site click'],
      ['background', 'cross-site coordinate click'],
      ['background', 'nested shadow fill/select/click'],
      ['unowned', 'cross-site click'],
      ['unowned', 'cross-site coordinate click'],
      ['unowned', 'cross-site fill'],
      ['unowned, just navigated', 'same-document click'],
      ['unowned, just navigated', 'cross-site click'],
      ['unowned, just navigated', 'cross-site coordinate click'],
    ]
    const repeats = Number(option('--repeats', '1'))
    const misses = []
    const visibility = {}
    let serial = 0
    const runCell = async ([state, entry]) => {
      const url = `${rootUrl}/?matrix=${serial++}`
      const tab = await states[state](url)
      try {
        if (state === 'unowned')
          await waitUntil(async () => (await js(tab.tabId, 'document.readyState === "complete" && document.querySelectorAll("iframe").length === 3')).includes('true'), 'unowned fixture')
        else await fresh(tab.tabId, url)
        const shown = JSON.parse(await js(tab.tabId, 'document.visibilityState'))
        ;(visibility[state] ??= new Set()).add(shown)
        const snap = text(await tool('read_page', { tabId: tab.tabId, filter: 'all', maxChars: 24000 }))
        const { act: run, landed } = entries[entry]
        const outcome = await run(tab.tabId, snap).then(
          (result) => (result.isError ? `reported failure: ${text(result).slice(0, 200)}` : undefined),
          (error) => `reported failure: ${String(error).slice(0, 200)}`,
        )
        if (outcome) misses.push(`${state} (${shown}) / ${entry}: ${outcome}`)
        else if (!(await landed(tab.tabId))) misses.push(`${state} (${shown}) / ${entry}: reported success, but the input did not land`)
      } finally {
        await tab.close()
      }
    }
    try {
      for (let round = 0; round < repeats; round++) {
        for (const cell of fgCells) await runCell(cell)
        const foreground = await openTarget(rootUrl + '/blank', true)
        try {
          await runPool(bgCells, 4, runCell)
          assert.match(
            text(await tool('tabs_context', { tabId: foreground.tabId, all: true })),
            new RegExp(`Active tab: .*\\(ID: ${foreground.tabId}\\)`),
          )
        } finally {
          await closeTarget(foreground)
        }
      }
    } finally {
      devtools.close()
    }
    const uncovered = Object.entries({ 'active, visible': 'visible', background: 'hidden', unowned: 'hidden', 'unowned, just navigated': 'hidden' })
      .filter(([state, shown]) => [...(visibility[state] ?? [])].join() !== shown)
      .map(([state, shown]) => `${state} was ${[...(visibility[state] ?? [])].join('/')}, not ${shown}`)
    assert.deepEqual([...misses, ...uncovered], [], `${misses.length} of ${repeats * (fgCells.length + bgCells.length)} cells missed:\n${[...misses, ...uncovered].join('\n')}`)
    return { visibility: Object.fromEntries(Object.entries(visibility).map(([k, v]) => [k, [...v]])) }
  })
  check('javascript_tool evaluates like a console and computer clicks a ref', async () => {
    const opened = await openTarget(`${rootUrl}/console`, false)
    const { tabId } = opened
    try {
      await waitUntil(async () => text(await tool('javascript_tool', { tabId, code: 'document.readyState === "complete" && typeof pageOwned === "number"' })).includes('true'), 'console fixture')
      const js = async (code) => text(await tool('javascript_tool', { tabId, code }))
      // Top-level await without awaitPromise, as the DevTools console allows.
      assert.equal(await js('await new Promise((r) => setTimeout(() => r(7), 50))'), '7')
      const awaited = text(await tool('javascript_tool', { tabId, code: 'Promise.resolve("done")', awaitPromise: true }))
      assert.equal(awaited, '"done"')
      // Caller declarations stay scoped: they neither collide with the page's own
      // top-level `let` nor with the same name in the next call.
      assert.equal(await js('const pageOwned = 2; pageOwned'), '2')
      assert.equal(await js('const pageOwned = 3; pageOwned'), '3')
      assert.equal(await js('pageOwned'), '1')
      const thrown = await tool('javascript_tool', { tabId, code: "document.querySelector('nope').x" }, true)
      assert.equal(text(thrown), "Cannot read properties of null (reading 'x')")
      const found = text(await tool('find', { tabId, description: 'Press me button' }))
      const refId = found.match(/\[([a-z]{3}\d+)\]/)?.[1]
      assert.ok(refId, found)
      await tool('computer', { tabId, action: 'left_click', refId })
      assert.equal(await js("document.querySelector('button').textContent"), '"PRESSED"')
    } finally {
      await closeTarget(opened)
    }
  })
  check('password manager iframe neither blocks CDP nor drops it mid-login', async () => {
    // browser.open waits for complete load before attaching, so the password
    // manager's document_end overlay is already drawn when bro first attaches.
    const opened = (await tool('browser.open', { url: `${rootUrl}/password-manager` })).structuredContent
    const { tabId } = opened
    try {
      const js = async (code) => text(await tool('javascript_tool', { tabId, code }))
      // The overlay drawn at load would reject attach; bro removes its iframe.
      assert.equal(await js('out.textContent'), '"SIGNED_OUT"')
      const ref = async (description) => {
        const found = text(await tool('find', { tabId, description }))
        const refId = found.match(/\[([a-z]{3}\d+)\]/)?.[1]
        assert.ok(refId, found)
        return refId
      }
      const username = await ref('Username textbox'), password = await ref('Password textbox')
      // Focusing the username redraws the overlay, the blur erases it and the
      // next focus re-adds it; none of these may close the session mid-input.
      await tool('computer', { tabId, action: 'left_click', refId: username })
      await tool('computer', { tabId, action: 'type', text: 'luna' })
      await tool('computer', { tabId, action: 'left_click', refId: password })
      await tool('computer', { tabId, action: 'left_click', refId: username })
      await tool('computer', { tabId, action: 'left_click', refId: password })
      await tool('computer', { tabId, action: 'type', text: 'secret' })
      await tool('computer', { tabId, action: 'left_click', refId: await ref('Sign in button') })
      assert.equal(await js('out.textContent'), '"SIGNED_IN:luna/6"')
    } finally {
      await tool('browser.close', { targetId: opened.targetId })
    }
  })
  check('native dialogs are answered, reported, and never hang the tab', async () => {
    const opened = (await tool('browser.open', { url: `${rootUrl}/dialogs`, observe: false })).structuredContent
    const act = async (steps) => text(await tool('browser.act', { targetId: opened.targetId, steps }))
    const output = async () => (await act([{ type: 'evaluate', code: 'out.textContent' }])).match(/evaluated: (.*)/)?.[1]
    try {
      const dismissed = await act([{ type: 'click', role: 'button', name: 'Confirm' }])
      assert.match(dismissed, /dialog confirm "Proceed\?" dismissed by default/)
      assert.equal(await output(), 'CANCEL')
      const accepted = await act([{ type: 'dialog', accept: true }, { type: 'click', role: 'button', name: 'Confirm' }])
      assert.match(accepted, /dialog confirm "Proceed\?" accepted/)
      assert.equal(await output(), 'OK')
      // The armed answer ended with its act call.
      await act([{ type: 'click', role: 'button', name: 'Confirm' }])
      assert.equal(await output(), 'CANCEL')
      await act([{ type: 'dialog', accept: true, promptText: 'Luna' }, { type: 'click', role: 'button', name: 'Prompt' }])
      assert.equal(await output(), 'PROMPT:Luna')
      // A low-level click reports the dialog in its own result and the tab stays usable.
      const found = text(await tool('find', { tabId: opened.tabId, description: 'Alert button' }))
      const refId = found.match(/\[([a-z]{3}\d+)\]/)?.[1]
      const clicked = text(await tool('computer', { tabId: opened.tabId, action: 'left_click', refId }))
      assert.match(clicked, /Native dialogs answered: alert "Saved" accepted/)
      assert.equal(await output(), 'ALERTED')
    } finally {
      await tool('browser.close', { targetId: opened.targetId })
    }
  })
  check('U: file_upload clicks the visible control; stray choosers are cancelled', async () => {
    const opened = (await tool('browser.open', { url: `${rootUrl}/uploads`, observe: false })).structuredContent
    const tabId = opened.tabId
    const one = resolve(output, 'upload-one.txt'), two = resolve(output, 'upload-two.txt')
    await writeFile(one, 'ONE')
    await writeFile(two, 'TWO')
    const page = async () => text(await tool('read_page', { tabId, filter: 'all', maxChars: 8000 }))
    const shows = (pattern, label) => waitUntil(async () => pattern.test(await page()), label)
    try {
      const snapshot = await page()
      const ref = (name, role = 'button') => refFor(snapshot, role, name)
      await tool('file_upload', { tabId, refId: ref('Pick hidden'), paths: [one, two] })
      await shows(/HIDDEN:upload-one.txt=ONE,upload-two.txt=TWO/, 'hidden input upload')
      await tool('file_upload', { tabId, refId: ref('Pick created'), paths: [two] })
      await shows(/CREATED:upload-two.txt=TWO/, 'created input upload')
      await tool('file_upload', { tabId, refId: ref('Covered input'), paths: [one] })
      await shows(/COVERED:upload-one.txt=ONE/, 'input under its own drop label')
      await tool('file_upload', { tabId, refId: ref('Pick trusted'), paths: [two] })
      await shows(/HIDDEN:upload-two.txt=TWO/, 'trusted-click-only button')
      const menu = JSON.parse(text(await tool('javascript_tool', {
        tabId,
        code: 'const r=document.querySelector("#menu").getBoundingClientRect();[r.x+r.width/2,r.y+r.height/2]',
      })))
      await tool('file_upload', { tabId, coordinate: menu, paths: [one] })
      await shows(/SINGLE:upload-one.txt=ONE/, 'coordinate-targeted menu item')
      await tool('file_upload', { tabId, refId: ref('Drop zone', 'region'), paths: [one, two], drop: true })
      await shows(/DROPPED:upload-one.txt=ONE,upload-two.txt=TWO/, 'drop zone')
      await tool('file_upload', { tabId, refId: ref('Pick single'), paths: [one, two] }, /asked for one file, got 2/)
      await tool('file_upload', { tabId, refId: ref('No chooser'), paths: [one] }, /opened no file chooser within 3s/)
      await tool('file_upload', { tabId, refId: ref('Pick system'), paths: [one] }, /showOpenFilePicker[\s\S]*drop: true/)
      await tool('file_upload', { tabId, paths: [one] }, /exactly one of .*refId.* or .*coordinate/)
      // A plain click never opens the OS picker; its result says how to choose files.
      const clicked = text(await tool('computer', { tabId, action: 'left_click', refId: ref('Pick hidden') }))
      assert.match(clicked, /file chooser cancelled/)
    } finally {
      await tool('browser.close', { targetId: opened.targetId })
    }
  })
  check('A: an attached tab takes one act of upload/fill/click per file across form posts; release keeps it open', async () => {
    // A tab bro did not open, as a user's tab or a page's popup is.
    const tabId = Number(text(await tool('tabs_create', { url: `${rootUrl}/upload-form` })).match(/Created tab: (\d+)/)[1])
    const files = ['a', 'b'].map((name) => resolve(output, `attach-${name}.txt`))
    for (const file of files) await writeFile(file, 'FILE')
    try {
      const attached = await tool('browser.attach', { tabId, observe: { filter: 'interactive' } })
      const { targetId } = attached.structuredContent
      assert.match(text(attached), /button "Attachment"/)
      const steps = files.flatMap((path, index) => [
        { type: 'upload', role: 'button', name: 'Attachment', paths: [path] },
        { type: 'fill', role: 'textbox', name: 'Description', value: `file ${index + 1}` },
        { type: 'click', role: 'button', name: 'Upload' },
      ])
      const report = text(await tool('browser.act', { targetId, steps, close: true }))
      assert.match(report, /uploaded attach-a\.txt to \w+ \(button "Attachment"\)/)
      assert.equal(report.match(/→ navigated to /g)?.length, 2, report)
      assert.match(report, new RegExp(`\nreleased ${targetId}; its tab stays open$`))
      assert.match(text(await tool('get_page_text', { tabId })), /attach-b\.txt uploaded: file 2 \(files 2\)/)
      await tool('browser.observe', { targetId }, /unknown flow session/)
      // Closing an attached target only releases it.
      const again = (await tool('browser.attach', { tabId, observe: false })).structuredContent
      assert.deepEqual((await tool('browser.close', { targetId: again.targetId })).structuredContent,
        { targetId: again.targetId, closed: false, status: 'ok', released: true })
      assert.match(text(await tool('get_page_text', { tabId })), /files 2/)
      await tool('browser.act', { targetId: 'unused', steps: [{ type: 'upload', role: 'button', name: 'Attachment', paths: ['relative.txt'] }] }, /must be absolute/)
    } finally {
      await tool('tabs_close', { tabId })
    }
  })

  check('screenshot captures the scrolled viewport at CSS pixel size', async () => {
    const opened = await openTarget(`${rootUrl}/bands`, false)
    const { tabId } = opened
    try {
      await waitUntil(async () => text(await tool('javascript_tool', { tabId, code: 'document.readyState === "complete" && document.body.scrollHeight > 2000' })).includes('true'), 'bands fixture')
      await tool('javascript_tool', { tabId, code: 'scrollTo(0, 1600); scrollY' })
      const shot = await tool('computer', { tabId, action: 'screenshot' })
      const image = shot.content.find((c) => c.type === 'image')
      assert.ok(image, text(shot))
      // Decode in the page: the image must be the viewport in CSS pixels and
      // show the blue band below the scroll offset, not the red top of the page.
      // javascript_tool returns a string result as its JSON literal.
      const probe = JSON.parse(JSON.parse(text(await tool('javascript_tool', {
        tabId,
        awaitPromise: true,
        code: `new Promise((ok, fail) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const [r, , b] = g.getImageData(img.width >> 1, img.height >> 1, 1, 1).data; ok(JSON.stringify({ size: [img.width, img.height], viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, r, b })) }; img.onerror = fail; img.src = 'data:image/jpeg;base64,${image.data}' })`,
      }))))
      assert.deepEqual(probe.size, probe.viewport)
      assert.ok(probe.b > 200 && probe.r < 60, `expected the scrolled blue band: ${JSON.stringify(probe)}`)
      // Chrome shrinks the viewport while a scaled capture runs, and a capture
      // that starts meanwhile restores the shrunk one: overlapping captures of
      // a tab (an agent's own, or the render pump's) must leave the page as it was.
      await Promise.all(Array.from({ length: 6 }, () => tool('computer', { tabId, action: 'screenshot' })))
      const after = JSON.parse(JSON.parse(text(await tool('javascript_tool', { tabId, code: 'JSON.stringify([innerWidth, innerHeight])' }))))
      assert.deepEqual(after, probe.viewport, 'concurrent screenshots changed the viewport')
      return { dpr: probe.dpr, base64Bytes: image.data.length }
    } finally {
      await closeTarget(opened)
    }
  })
  check('covered options name the overlay; check sets them without a pointer click', async () => {
    const opened = (await tool('browser.open', { url: `${rootUrl}/overlay`, observe: false })).structuredContent
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
  check('R: a change report waits for the requests its action started, and only those', { long: true }, async () => {
    // Orthogonal matrix in background tabs: click-by-name covers every request
    // shape, while the other input entries cover representative request shapes
    // to prove they wire into the same request-aware settle path.
    const shapes = Object.fromEntries([
      // Every answered shape has an upper bound: waiting past the answer to
      // the cap is a miss too.
      { name: 'fast', want: /alert DONE fast/, maxMs: 1500 },
      // Longer than the quiet period: the report must wait for the answer.
      { name: 'slow', want: /alert DONE slow/, maxMs: 2800 },
      { name: 'chained', want: /alert DONE chained/, maxMs: 2800 },
      { name: 'failed', want: /alert DONE failed/, maxMs: 2800 },
      // A body the page never reads still answers the request.
      { name: 'unread', want: /alert DONE unread/, maxMs: 2000 },
      // Never answers: the report ends at its cap and names the request.
      { name: 'hang', want: /waiting on GET \S+\/req\?hang=1/, minMs: 2800 },
      // A beacon and a request from before the action are not waited for.
      { name: 'beacon', want: /alert DONE beacon/, maxMs: 1500 },
      { name: 'inflight', want: /alert DONE inflight/, maxMs: 1500 },
    ].map((s) => [s.name, s]))
    const entries = {
      'click by name': { name: 'click by name', steps: () => [{ type: 'click', role: 'button', name: 'Run' }] },
      'click by ref': { name: 'click by ref', steps: (ref) => [{ type: 'click', refId: ref }] },
      'press Enter': { name: 'press Enter', steps: () => [{ type: 'fill', role: 'textbox', name: 'Query', value: 'q' }, { type: 'press', key: 'Enter' }] },
      select: { name: 'select', steps: () => [{ type: 'select', role: 'combobox', name: 'Mode', value: 'go' }] },
    }
    const cells = [
      // Slowest shapes first so no straggler stretches the final wave.
      { shape: shapes.hang, entry: entries['click by name'] },
      { shape: shapes.slow, entry: entries['click by name'] },
      { shape: shapes.slow, entry: entries['click by ref'] },
      { shape: shapes.slow, entry: entries['press Enter'] },
      { shape: shapes.slow, entry: entries.select },
      { shape: shapes.chained, entry: entries['click by name'] },
      { shape: shapes.chained, entry: entries['press Enter'] },
      { shape: shapes.failed, entry: entries['click by name'] },
      { shape: shapes.failed, entry: entries.select },
      { shape: shapes.unread, entry: entries['click by name'] },
      { shape: shapes.fast, entry: entries['click by name'] },
      { shape: shapes.beacon, entry: entries['click by name'] },
      { shape: shapes.inflight, entry: entries['click by name'] },
      { shape: shapes.inflight, entry: entries['click by ref'] },
    ]
    const failures = []
    const runCell = async ({ shape, entry }, index) => {
      const where = `${shape.name} via ${entry.name}`
      const opened = (await tool('browser.open', { url: `${rootUrl}/req-form?shape=${shape.name}&c=${index}`, observe: false })).structuredContent
      try {
        let ref
        if (entry.name === 'click by ref') {
          const page = text(await tool('browser.observe', { targetId: opened.targetId, filter: 'interactive' }))
          ref = page.match(/\[(\w+)\] button "Run"/)?.[1]
          assert.ok(ref, `${where}: no ref for Run in ${page.slice(0, 400)}`)
        }
        const result = text(await tool('browser.act', { targetId: opened.targetId, steps: entry.steps(ref) }))
        const line = result.split('\n').at(-1)
        assert.match(line, shape.want, `${where}: ${line}`)
        const settled = Number(line.match(/(\d+)ms\)$/)?.[1])
        if (shape.minMs) assert.ok(settled >= shape.minMs, `${where} settled at ${settled}ms: ${line}`)
        if (shape.maxMs) assert.ok(settled < shape.maxMs, `${where} settled at ${settled}ms: ${line}`)
      } catch (error) {
        failures.push(`${where}: ${error.message.split('\n')[0]}`)
      } finally {
        await tool('browser.close', { targetId: opened.targetId })
      }
    }
    await runPool(cells, 3, runCell)
    assert.deepEqual(failures, [])
  })
  // Discarding uses chrome://discards whose ids are positions in a tab list
  // that reorders as tabs open and close, so discarded cells run alone here.
  check('FROZEN: discarded tabs fail fast', { exclusive: true }, async () => {
    const devtools = await browserSession()
    const { targetId: discardsTarget } = await devtools.send('Target.createTarget', { url: 'chrome://discards', background: true })
    const discards = (await devtools.send('Target.attachToTarget', { targetId: discardsTarget, flatten: true })).sessionId
    const inDiscards = async (body) => {
      const reply = await devtools.send('Runtime.evaluate', {
        expression: `import('chrome://discards/discards.js').then(async (m) => { const p = m.getOrCreateDetailsProvider(); ${body} })`,
        awaitPromise: true, returnByValue: true,
      }, discards)
      if (reply.exceptionDetails) throw new Error(`chrome://discards: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`)
      return reply.result.value
    }
    const onTab = (url, op) => inDiscards(`const { infos } = await p.getTabDiscardsInfo(); const tab = infos.find((i) => i.tabUrl === ${JSON.stringify(url)}); if (!tab) throw new Error('no discards entry for ${url}'); ${op}`)
    const entries = [
      { name: 'click', effect: 'click', run: (t) => tool('browser.act', { targetId: t.targetId, steps: [{ type: 'click', role: 'button', name: 'Go' }] }) },
      { name: 'observe', effect: 'load', read: true, run: (t) => tool('browser.observe', { targetId: t.targetId, mode: 'text' }) },
    ]
    const failures = []
    const timings = {}
    try {
      const t0 = performance.now()
      await waitUntil(async () => (await inDiscards('return true').catch(() => false)) === true, 'chrome://discards')
      timings.discardsReadyMs = Math.round(performance.now() - t0)
      for (const [index, entry] of entries.entries()) {
        const key = `discard-${index}-${Math.random().toString(36).slice(2)}`
        const url = `${rootUrl}/frozen?key=${key}${entry.read ? '&read=1' : ''}`
        const holdOf = (what) => hold(`${key}/${what}`)
        const opened = await openTarget(url, false)
        let page
        try {
          const c0 = performance.now()
          page = await waitUntil(() => devtools.page(url).catch(() => false), 'fixture target')
          const evaluate = (expression) => devtools.send('Runtime.evaluate', { expression, returnByValue: true }, page).then((r) => r.result.value, () => undefined)
          holdOf('load').release()
          if (entry.effect !== 'load') void holdOf(entry.effect).arrived.then(holdOf(entry.effect).release)
          await waitUntil(async () => (await evaluate('out.textContent'))?.includes('LOADED') ?? false, 'loaded fixture')
          const c1 = performance.now()
          await onTab(url, 'await p.discardById(tab.id, 0)')
          const started = performance.now()
          const outcome = await entry.run(opened).then((r) => ({ ok: true, text: text(r) }), (e) => ({ ok: false, text: String(e) }))
          const ms = Math.round(performance.now() - started)
          timings[entry.name] = { setupMs: Math.round(c1 - c0), discardMs: Math.round(started - c1), failMs: ms }
          assert.ok(!outcome.ok, `${entry.name} / discarded should fail: ${outcome.text.slice(0, 300)}`)
          assert.match(outcome.text, /tab \d+ is discarded|No tab with (given )?id|tab \d+ closed/)
          assert.ok(ms < 2_000, `${entry.name} / discarded took ${ms}ms`)
        } catch (error) {
          failures.push(`${entry.name} / discarded: ${error.message.replaceAll('\n', ' ⏎ ').slice(0, 400)}`)
        } finally {
          for (const what of ['load', 'click', 'fill']) holdOf(what).release()
          if (page) await devtools.send('Target.detachFromTarget', { sessionId: page }).catch(() => {})
          await closeTarget(opened).catch(() => {})
        }
      }
    } finally {
      await devtools.send('Target.closeTarget', { targetId: discardsTarget }).catch(() => {})
      devtools.close()
    }
    assert.deepEqual(failures, [])
    return timings
  })
  // Chrome freezes background tabs once it holds more than a few, and a frozen
  // page runs no task and no injected script until Chrome unfreezes it. Freezing
  // through each tab's own DevTools session needs no chrome://discards lookup,
  // so these cells run concurrently in the pool.
  check('FROZEN: acts and reads resume a tab Chrome froze, before or mid-action', async () => {
    const devtools = await browserSession()
    const entries = {
      click: { effect: 'click', want: /alert DONE click/, run: (t) => tool('browser.act', { targetId: t.targetId, steps: [{ type: 'click', role: 'button', name: 'Go' }] }) },
      observe: { effect: 'load', read: true, want: /LOADED/, run: (t) => tool('browser.observe', { targetId: t.targetId, mode: 'text' }) },
      extract: { effect: 'load', read: true, want: /LOADED/, run: (t) => tool('browser.extract', { tabId: t.tabId }).then((r) => ({ ...r, content: [{ type: 'text', text: r.structuredContent.text }] })) },
      wait: { effect: 'load', want: /waited \d+ms until text "LOADED the held" appears/, run: (t) => tool('browser.act', { targetId: t.targetId, steps: [{ type: 'wait', text: 'LOADED the held' }] }) },
    }
    const cells = [
      ['frozen before', 'click'],
      ['frozen before', 'observe'],
      ['frozen before', 'extract'],
      ['frozen before', 'wait'],
      ['frozen mid-action', 'click'],
      ['frozen mid-action', 'wait'],
    ]
    const failures = []
    const runCell = async ([state, entryName], index) => {
      const entry = entries[entryName]
      const where = `${entryName} / ${state}`
      const key = `frozen-${index}-${Math.random().toString(36).slice(2)}`
      const url = `${rootUrl}/frozen?key=${key}${entry.read ? '&read=1' : ''}`
      const holdOf = (what) => hold(`${key}/${what}`)
      const opened = await openTarget(url, false)
      let page, evOf = async () => ''
      try {
        page = await waitUntil(() => devtools.page(url).catch(() => false), 'fixture target')
        evOf = async () => (await ev().catch((e) => String(e))) + ` arrived=${entry.effect}:${holdOf(entry.effect).res !== undefined}`
        const evaluate = (expression) => devtools.send('Runtime.evaluate', { expression, returnByValue: true }, page).then((r) => r.result.value, () => undefined)
        const ev = async () => (await evaluate('ev.join()')) ?? ''
        const freeze = () => waitUntil(async () => {
          await devtools.send('Page.setWebLifecycleState', { state: 'active' }, page)
          await devtools.send('Page.setWebLifecycleState', { state: 'frozen' }, page)
          const deadline = performance.now() + 250
          while (performance.now() < deadline) {
            if ((await ev()).includes('freeze')) return true
            await new Promise((r) => setTimeout(r, 50))
          }
          return false
        }, 'page freeze event').catch(async (error) => {
          const seen = await devtools.send('Runtime.evaluate', { expression: 'JSON.stringify([ev, document.visibilityState, document.readyState])', returnByValue: true }, page)
            .then((r) => r.result.value ?? JSON.stringify(r.exceptionDetails?.text), String)
          throw new Error(`${error.message}; the page says ${seen}`)
        })
        const loaded = () => waitUntil(async () => (await evaluate('out.textContent'))?.includes('LOADED') ?? false, 'loaded fixture')
        const effect = holdOf(entry.effect)
        if (entry.effect !== 'load') {
          holdOf('load').release()
          await loaded()
        } else await holdOf('load').arrived
        let running
        if (state === 'frozen before') {
          await freeze()
          if (entry.effect === 'load') effect.release()
          else void effect.arrived.then(effect.release)
        } else {
          running = entry.run(opened)
          if (entry.effect !== 'load') await effect.arrived
          await freeze()
          effect.release()
        }
        const started = performance.now()
        const outcome = await (running ?? entry.run(opened)).then((r) => ({ ok: true, text: text(r) }), (e) => ({ ok: false, text: String(e) }))
        const ms = Math.round(performance.now() - started)
        assert.ok(outcome.ok, `${where}: ${outcome.text.slice(0, 300)}`)
        assert.match(outcome.text, entry.want, `${where}: ${outcome.text.slice(0, 300)}`)
        assert.match(await ev(), /freeze.*resume/, `${where}: the page was not frozen and resumed`)
        assert.ok(ms < 10_000, `${where} took ${ms}ms: ${outcome.text.slice(0, 200)}`)
      } catch (error) {
        failures.push(`${where}: ${error.message.replaceAll('\n', ' ⏎ ').slice(0, 600)} [page: ${await evOf()}]`)
      } finally {
        for (const what of ['load', 'click', 'fill']) holdOf(what).release()
        if (page) await devtools.send('Target.detachFromTarget', { sessionId: page }).catch(() => {})
        await closeTarget(opened).catch(() => {})
      }
    }
    try {
      await runPool(cells, 2, runCell)
    } finally {
      devtools.close()
    }
    assert.deepEqual(failures, [])
  })
  check('T: role/name targets and change reports chain a form without waits', { long: true }, async () => {
    // Single-action tools default to the session's last target: another
    // check's call on a shared session would move it.
    const session = await connectClient()
    const tool = toolOn(session)
    const opened = (await tool('browser.open', { url: `${rootUrl}/token-form` })).structuredContent
    const targetId = opened.targetId
    try {
      const started = performance.now()
      const result = text(await tool('browser.act', { targetId, steps: [
        { type: 'fill', role: 'textbox', name: 'Token name', value: 'rss-dispatch' },
        { type: 'click', role: 'button', name: 'Expiration' },
        { type: 'click', role: 'menuitem', name: '90 days' },
        { type: 'click', role: 'button', name: 'Generate token' },
        { type: 'click', role: 'button', name: 'Access' },
        { type: 'click', role: 'menuitem', name: 'Read and write' },
        { type: 'click', role: 'button', name: 'Generate token' },
      ] }))
      const elapsed = Math.round(performance.now() - started)
      const lines = result.split('\n')
      assert.equal(lines.length, 8, result)
      assert.match(lines[1], /^filled \w+ \(textbox "Token name"\)$/)
      // An opened layer lists its controls as refs.
      assert.match(lines[2], /^clicked \w+ \(button "Expiration"\) → opened menu "Expiration"; controls [a-z]{3}\d+ menuitem "7 days", [a-z]{3}\d+ menuitem "30 days", [a-z]{3}\d+ menuitem "90 days" /)
      // The menu item re-rendered with a fresh id; resolution happens at click.
      assert.match(lines[3], /^clicked \w+ \(menuitem "90 days"\) → closed menu "Expiration".*text "Expiration: 90 days"/)
      assert.match(lines[4], /→ alert Contents needs read and write access/)
      assert.match(lines[6], /text "Access: Read and write"/)
      assert.match(lines[7], /text "TOKEN_CREATED rss-dispatch 90 days"/)
      assert.ok(elapsed < 8000, `${elapsed}ms\n${result}`)
      // One date input is one fillable node; its month/day/year parts and a
      // button's echoed label are not separate lines.
      const page = text(await tool('browser.observe', { maxChars: 12000 }))
      assert.match(page, /\[[a-z]{3}\d+\] Date "Expires"/)
      assert.doesNotMatch(page, /spinbutton|StaticText "Generate token"/)
      // Single-action tools default to this session's last target.
      await tool('browser.fill', { role: 'Date', name: 'Expires', value: '12/15/2026' }, /A date input takes YYYY-MM-DD/)
      assert.match(text(await tool('browser.fill', { role: 'Date', name: 'Expires', value: '2026-12-15' })), new RegExp(`^targetId: ${targetId}\\nfilled \\w+ \\(Date "Expires"\\)$`))
      assert.match(text(await tool('browser.click', { role: 'button', name: 'Permissions' })), /opened dialog "Permissions"; controls \w+ checkbox "Contents"/)
      assert.match(text(await tool('browser.press', { key: 'Escape' })), /\npressed Escape → closed dialog "Permissions" \(settled \d+ms\)$/)
      await tool('browser.press', { key: 'Esc4pe' }, /Unknown key Esc4pe/)
      await tool('browser.act', { targetId, steps: [{ type: 'click', role: 'menuitem', name: 'Read and write' }] }, /No visible menuitem named "Read and write"/)
      const menu = text(await tool('browser.act', { targetId, steps: [{ type: 'click', role: 'button', name: 'Access' }] }))
      // A near-miss role names what is there instead of only failing.
      await tool('browser.act', { targetId, steps: [{ type: 'click', role: 'menuitemradio', name: 'Read and write' }] }, /No visible menuitemradio named "Read and write"; visible with other roles: menuitem "Read and write"/)
      const listed = /([a-z]{3}\d+) menuitem "Read-only"/.exec(menu)?.[1]
      assert.ok(listed, menu)
      assert.match(text(await tool('browser.act', { targetId, steps: [{ type: 'click', refId: listed }] })), /closed menu "Access".*text "Access: Read-only"/)
      await tool('browser.act', { targetId, steps: [{ type: 'click', role: 'button', name: 'e' }] }, /visible button elements match "e"/)
      await tool('browser.act', { targetId, steps: [{ type: 'click', role: 'button', name: 'Generate', refId: 'kqx1' }] }, /exactly one target/)
      // A form post that answers after the quiet period still reports the navigation.
      assert.match(text(await tool('browser.act', { targetId, steps: [{ type: 'click', role: 'button', name: 'Submit post' }] })), /→ navigated to \S+\/slow-post/)
    } finally {
      await tool('browser.close', { targetId })
      await session.close()
    }
  })
  check('F: scroll, hit acceptance, scope replacement and text cursor', async () => {
    const opened = (await tool('browser.open', { url: `${rootUrl}/f-contract`, observe: false })).structuredContent
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
      assert.equal(refFor(text(await tool('browser.observe', { targetId, refId: feed, depth: 1 })), 'region', 'Feed'), feed)
      const nav = (await tool('browser.act', { targetId, steps: [{ type: 'navigate', url: `${rootUrl}/blank` }, { type: 'evaluate', code: 'document.title' }] })).structuredContent
      assert.equal(nav.results[1].result, 'Benchmark ready')
    } finally {
      await tool('browser.close', { targetId })
    }
  })
  check('N: network capture returns the triggered request and its body in one call', async () => {
    const captured = await tool('browser.network.capture', {
      url: `${rootUrl}/blank?n=1`,
      code: "fetch('/net-echo?bro=live-network', {cache: 'no-store'}).then(r => r.json())",
      urlIncludes: '/net-echo?bro=live-network',
      includeResponseBodies: true,
    })
    const result = captured.structuredContent
    assert.equal(result.matchedRequests, 1, text(captured))
    assert.equal(result.timedOut, false)
    assert.equal(result.requests[0].status, 200)
    assert.equal(JSON.parse(result.requests[0].body).bro, 'live-network')
  })
  check('W: an owned tab groups in its own window while a popup has focus', { exclusive: true }, async () => {
    const opener = (await tool('browser.open', { url: `${rootUrl}/popup-opener`, observe: false })).structuredContent
    try {
      await tool('browser.click', { targetId: opener.targetId, role: 'button', name: 'Open popup' })
      // The popup is the focused window; the group must not be created there.
      const owned = (await tool('browser.open', { url: `${rootUrl}/blank`, ownerSessionId: 'popup-focus', label: 'Popup focus', observe: false })).structuredContent
      await tool('browser.close', { targetId: owned.targetId })
    } finally {
      await tool('browser.act', { targetId: opener.targetId, steps: [{ type: 'evaluate', code: 'window._popup?.close(); 1' }] }).catch(() => {})
      await tool('browser.close', { targetId: opener.targetId })
    }
  })
  // Opening a window takes focus and changes which window is current.
  check('WIN: tabs_context all lists the tabs of every window, anchor window first', { exclusive: true }, async () => {
    const url = `${rootUrl}/blank?window=${Date.now()}`
    const devtools = await browserSession()
    const { targetId } = await devtools.send('Target.createTarget', { url, newWindow: true, background: true })
    try {
      const listed = await waitUntil(async () => {
        const tabs = text(await tool('tabs_context', { all: true }))
        return tabs.includes(url) && tabs
      }, 'tab in a second window')
      const windows = listed.split(/^(?=Window \d+)/m).slice(1)
      assert.ok(windows.length >= 2, `every window must be listed: ${listed}`)
      assert.match(windows[0], /^Window \d+ \(anchor/, `the anchor window must come first: ${listed}`)
      const own = windows.find((w) => w.includes(url))
      assert.notEqual(own, windows[0], `the new tab must be listed under its own window: ${listed}`)
      assert.match(own, /^Tabs \(1\):\n {2}\* \[\d+\] /m, `a window marks its own active tab: ${listed}`)
    } finally {
      await devtools.send('Target.closeTarget', { targetId }).catch(() => {})
      devtools.close()
    }
  })
  check('E: every read path waits for the content a page is loading, and reads only rendered text', { long: true }, async () => {
    // One table of page shapes, read concurrently across extract, multi-URL
    // batch extract, and open → first observe, plus open+close:true, unreachable
    // minChars, and held DOMContentLoaded cap.
    const notRendered = /z-index|:host|HIDDEN_SHADOW_TEXT/
    const shapes = [
      { name: 'small page', path: '/blank', want: /Ready/, maxMs: 2000 },
      { name: 'lazy feed', path: '/lazy-feed', want: /LAZY_CARD_11/ },
      { name: 'slow document', path: '/h-slow', want: /SLOW_CONTENT_OK/, never: /Loading…/ },
      { name: 'app shell with spinner', path: '/app-feed?spinner=1', want: /APP_POST_BODY/, extracted: /GUARD_WIDGET/, never: notRendered },
      { name: 'silent app shell, minChars', path: '/app-feed', args: { minChars: 400 }, want: /APP_POST_BODY/, never: notRendered, paths: ['extract', 'batch'] },
    ]
    const verify = (shape, via, read, elapsedMs) => {
      const where = `${shape.name} via ${via}`
      assert.match(read, shape.want, `${where}: ${read.slice(0, 600)}`)
      if (shape.extracted && via !== 'observe') assert.match(read, shape.extracted, `${where}: ${read.slice(0, 600)}`)
      if (shape.never) assert.doesNotMatch(read, shape.never, `${where}: ${read.slice(0, 600)}`)
      if (shape.maxMs) assert.ok(elapsedMs < shape.maxMs, `${where} took ${elapsedMs}ms`)
    }
    const urlFor = (shape, index, via) => `${rootUrl}${shape.path}${shape.path.includes('?') ? '&' : '?'}e=${index}-${via}`
    const timings = {}
    const failures = []
    const attempt = (where, read) => () => read().catch((error) => failures.push(`${where}: ${error.message.split('\n')[0]}`))
    const tasks = []

    // Start the slowest ~4 s readiness-cap tasks first so they do not sit at the tail.
    // Held DOMContentLoaded: open observe:false returns at dispatch; first
    // observe proceeds after the ~4s cap.
    tasks.push(attempt('held DOMContentLoaded cap', async () => {
      let started = performance.now()
      const held = JSON.parse(text(await tool('browser.open', { url: `${rootUrl}/slow-ready`, observe: false })))
      const heldOpenMs = Math.round(performance.now() - started)
      assert.ok(held.ready === undefined && heldOpenMs < 250, `${heldOpenMs}ms ${JSON.stringify(held)}`)
      try {
        started = performance.now()
        const shell = text(await tool('browser.observe', { targetId: held.targetId }))
        const heldObserveMs = Math.round(performance.now() - started)
        assert.ok(heldObserveMs >= 3500 && heldObserveMs < 6000, `${heldObserveMs}ms`)
        assert.match(shell, /Loading/)
      } finally {
        const closed = await tool('browser.close', { targetId: held.targetId })
        assert.equal((closed.structuredContent ?? JSON.parse(text(closed))).closed, true)
      }
    }))

    // minChars the page never reaches is reported, not papered over.
    tasks.push(attempt('unreachable minChars via extract', async () => {
      const short = (await tool('browser.extract', { url: `${rootUrl}/blank?e=unreachable`, minChars: 500 })).structuredContent
      assert.equal(short.status, 'partial', JSON.stringify(short))
      assert.equal(short.diagnostics.ready, false)
    }))

    // Multi-URL batch extract for all non-minChars shapes in one call.
    const standardShapes = shapes.map((shape, index) => ({ shape, index })).filter(({ shape }) => !shape.args)
    tasks.push(attempt('multi-URL batch extract', async () => {
      const started = performance.now()
      const batch = (await tool('browser.batch.extract', {
        urls: standardShapes.map(({ shape, index }) => urlFor(shape, index, 'batch')),
        maxChars: 20000,
      })).structuredContent
      const elapsed = Math.round(performance.now() - started)
      for (const [i, { shape }] of standardShapes.entries()) {
        const result = batch.results[i]
        assert.equal(result.status, 'ok', `${shape.name} via batch: ${JSON.stringify(result)}`)
        verify(shape, 'batch', result.text, shape.maxMs ? result.diagnostics.elapsedMs : elapsed)
      }
    }))
    // minChars batch extract.
    const minCharsIndex = shapes.findIndex((s) => s.args)
    tasks.push(attempt(`${shapes[minCharsIndex].name} via batch`, async () => {
      const shape = shapes[minCharsIndex]
      const started = performance.now()
      const [result] = (await tool('browser.batch.extract', { urls: [urlFor(shape, minCharsIndex, 'batch')], maxChars: 20000, ...shape.args })).structuredContent.results
      assert.equal(result.status, 'ok', `${shape.name} via batch: ${JSON.stringify(result)}`)
      verify(shape, 'batch', result.text, Math.round(performance.now() - started))
    }))

    for (const [index, shape] of shapes.entries()) {
      const paths = shape.paths ?? ['extract', 'batch', 'observe']
      if (paths.includes('extract')) tasks.push(attempt(`${shape.name} via extract`, async () => {
        const started = performance.now()
        const result = (await tool('browser.extract', { url: urlFor(shape, index, 'extract'), ...(shape.args ?? {}) })).structuredContent
        assert.equal(result.status, 'ok', `${shape.name} via extract: ${JSON.stringify(result)}`)
        verify(shape, 'extract', result.text, Math.round(performance.now() - started))
        timings[`${shape.name} extract`] = result.diagnostics.elapsedMs
      }))
      if (paths.includes('observe')) tasks.push(attempt(`${shape.name} via observe`, async () => {
        const opened = (await tool('browser.open', { url: urlFor(shape, index, 'observe'), observe: false })).structuredContent
        try {
          const started = performance.now()
          const read = text(await tool('browser.observe', { targetId: opened.targetId, mode: 'text' }))
          verify(shape, 'observe', read, Math.round(performance.now() - started))
        } finally {
          await tool('browser.close', { targetId: opened.targetId })
        }
      }))
    }

    // open default observation + close:true + no "Agent is active" overlay leak.
    tasks.push(attempt('open default observe and close:true', async () => {
      const started = performance.now()
      const opened = await tool('browser.open', { url: `${rootUrl}/blank?s=2` })
      const openMs = Math.round(performance.now() - started)
      const targetId = opened.structuredContent.targetId
      let closed = false
      try {
        const first = text(opened)
        assert.match(first, /^targetId: \S+  url: /)
        assert.match(first, /StaticText "Ready"/)
        assert.ok(openMs < 2000, `open with first observation took ${openMs}ms`)
        assert.doesNotMatch(first, /Agent is active/)
        const read = await tool('browser.observe', { targetId, mode: 'text', close: true })
        assert.equal(read.structuredContent.closed, true, text(read))
        assert.match(text(read), /Ready\nclosed /)
        closed = true
        const again = await tool('browser.observe', { targetId }, /unknown flow session/)
        assert.equal(again.isError, true, text(again))
      } finally {
        if (!closed) await tool('browser.close', { targetId })
      }
    }))

    await runPool(tasks, 3, (task) => task())
    assert.deepEqual(failures, [])
    return timings
  })
  check('G: truncation footer lists scoped refs, ceilings, and in-place extract', async () => {
    const opened = (await tool('browser.open', { url: `${rootUrl}/g-long`, observe: false })).structuredContent
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

      // Extract without a url reads an existing tab in place and leaves it open.
      const inPlace = (await tool('browser.extract', { tabId: opened.tabId })).structuredContent
      assert.equal(inPlace.status, 'ok', JSON.stringify(inPlace))
      assert.equal(inPlace.tabId, opened.tabId)
      assert.match(inPlace.text, /REVIEW_OK/)
      assert.match(text(await tool('javascript_tool', { tabId: opened.tabId, code: 'document.title' })), /G long/)
    } finally {
      await tool('browser.close', { targetId })
    }
  })
  check('H1: act wait returns when its condition holds; a timeout continues', async () => {
    const opened = (await tool('browser.open', { url: `${rootUrl}/h-delayed`, observe: false })).structuredContent
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
  check('WATCH: a watch pushes late, re-rendered, navigated, background and transient changes and a closed tab within a second, reports a timeout, stays quiet on a churning page, and follows a cross-site iframe chat, through the MCP read, the CLI stream and the wait step', { long: true }, async () => {
    // Every shape through every entry point. Each run opens its own
    // background tab; the wait step watches the page's text.
    // budgetMs bounds the time from the change to its report: a second, plus
    // what the page itself takes after the release (the next page's fetch,
    // a background tab's throttled timer).
    const shapes = [
      { name: 'late', want: 'met', budgetMs: 1000 },
      { name: 'rerender', want: 'met', node: true, budgetMs: 1000 },
      { name: 'navigate', want: 'met', navigated: true, budgetMs: 1000 + 800 },
      { name: 'timer', want: 'met', budgetMs: 1000 + 2000 },
      { name: 'transient', want: 'met', budgetMs: 1000 },
      { name: 'close', want: 'tabClosed', budgetMs: 1000 },
      { name: 'timeout', want: 'timeout' },
    ]
    // onStart runs once the watch bro watch starts is listed. A watch is
    // listed only after its first probe, so the page latch is in place; a
    // text watch prints no line until it changes, so its output can't tell.
    const cli = (start, flags = [], onStart) =>
      new Promise((resolveRun, reject) => {
        const args = start ? ['watch', JSON.stringify(start), ...flags] : ['watch', ...flags]
        const child = spawn(broBinary, [...args, '--port', String(port)], {
          env: { ...process.env, HOME: brokerHome },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        const listed = onStart && waitUntil(async () =>
          (await tool('browser.watch', { list: true })).structuredContent.watches
            .find((w) => w.targetId === start.targetId && w.active), 'listed watch').then(onStart)
        // Rethrown when the run exits; caught here so it is not unhandled first.
        listed?.catch(() => {})
        child.stdout.on('data', (d) => (out += d))
        child.stderr.on('data', (d) => (err += d))
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
        child.once('error', reject)
        child.once('exit', async (code) => {
          clearTimeout(timer)
          try {
            await listed
            const lines = out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
            resolveRun({ code, lines, err })
          } catch (error) {
            reject(new Error(`bro watch printed non-JSON (${error}): ${out} ${err}`))
          }
        })
      })
    const failures = []
    const timings = {}
    const byName = Object.fromEntries(shapes.map((s) => [s.name, s]))
    // Orthogonal matrix: mcp exercises every shape; cli and wait exercise
    // representative met/close/timeout paths. Slowest tasks start first.
    const matrixCells = [
      { shape: byName.timeout, entry: 'mcp' },
      { shape: byName.timeout, entry: 'cli' },
      { shape: byName.timeout, entry: 'wait' },
      { shape: byName.timer, entry: 'mcp' },
      { shape: byName.close, entry: 'wait' },
      { shape: byName.navigate, entry: 'mcp' },
      { shape: byName.late, entry: 'mcp' },
      { shape: byName.rerender, entry: 'mcp' },
      { shape: byName.transient, entry: 'mcp' },
      { shape: byName.close, entry: 'mcp' },
      { shape: byName.late, entry: 'cli' },
      { shape: byName.close, entry: 'cli' },
      { shape: byName.late, entry: 'wait' },
    ]
    const watchTasks = [
      ...matrixCells.map(({ shape, entry }) => async () => {
        const key = `${shape.name}/${entry}/${Math.random().toString(36).slice(2)}`
        const opened = await openTarget(`${rootUrl}/watch?shape=${shape.name}&key=${encodeURIComponent(key)}`, false)
        const { targetId, tabId } = opened
        let closed = false
        let releasedAt
        const afterStart = async () => {
          releasedAt = performance.now()
          if (shape.name !== 'close') return releaseWatch(key)
          closed = true
          await tool('tabs_close', { tabId })
        }
        const started = performance.now()
        try {
          const start = { targetId, text: 'Done', maxDurationMs: shape.name === 'timeout' ? 2500 : 15000, intervalMs: 60000 }
          if (shape.node && entry !== 'wait') {
            const tree = text(await tool('browser.observe', { targetId }))
            start.refId = refFor(tree, 'status', 'Job 1')
          }
          let reason
          let reported
          let events = []
          if (entry === 'mcp') {
            let r = (await tool('browser.watch', start)).structuredContent
            const id = r.watchId
            events.push(...r.events)
            await afterStart()
            while (r.active) {
              r = (await tool('browser.watch', { watchId: id, cursor: r.cursor, waitMs: 20000 })).structuredContent
              events.push(...r.events)
            }
            reason = r.reason
            reported = performance.now()
          } else if (entry === 'cli') {
            const run = await cli(start, [], afterStart)
            reported = performance.now()
            events = run.lines
            reason = run.lines.at(-1)?.reason
            const wantCode = shape.want === 'met' ? 0 : 1
            if (run.code !== wantCode) throw new Error(`exit ${run.code}, want ${wantCode}: ${run.err} ${JSON.stringify(run.lines)}`)
          } else {
            releaseWatch(key)
            const closing = shape.name === 'close' &&
              new Promise((r) => setTimeout(r, 1200)).then(async () => {
                closed = true
                await tool('tabs_close', { tabId })
              })
            const r = await tool('browser.act', { targetId, steps: [{ type: 'wait', text: 'Done', timeoutMs: shape.name === 'timeout' ? 2500 : 12000 }] },
              shape.name === 'close' && /failed at step 1 \(wait\): tab \d+ closed/)
            await closing
            reason = r.isError ? 'tabClosed' : r.structuredContent.results[0].met ? 'met' : 'timeout'
          }
          if (reason !== shape.want) throw new Error(`ended ${reason}, want ${shape.want}: ${JSON.stringify(events)}`)
          if (shape.want === 'met' && entry !== 'wait') {
            const met = events.find((e) => e.type === 'met')
            if (!/done/i.test(met?.value ?? '')) throw new Error(`met event lacks the text: ${JSON.stringify(events)}`)
          }
          if (shape.navigated && entry !== 'wait' && !events.some((e) => e.type === 'navigated'))
            throw new Error(`no navigated event: ${JSON.stringify(events)}`)
          if (events.at(-1) && entry !== 'wait' && events.at(-1).type !== 'end')
            throw new Error(`last event is not end: ${JSON.stringify(events)}`)
          if (shape.budgetMs && entry !== 'wait' && reported - releasedAt > shape.budgetMs)
            throw new Error(`reported ${Math.round(reported - releasedAt)} ms after the change, budget ${shape.budgetMs} ms: ${JSON.stringify(events)}`)
          timings[`${shape.name}/${entry}`] = Math.round(performance.now() - started)
        } catch (error) {
          failures.push(`${shape.name}/${entry}: ${error.message ?? error}`)
        } finally {
          if (!closed) await closeTarget(opened).catch(() => {})
          else targets.delete(tabId)
        }
      }),
      // A page that mutates all the time without changing what is watched:
      // no event, and one check per task of mutations, not one per mutation.
      async () => {
        const opened = await openTarget(`${rootUrl}/watch?shape=churn`, false)
        const { targetId } = opened
        try {
          let r = (await tool('browser.watch', { targetId, change: true, intervalMs: 1000 })).structuredContent
          const events = [...r.events]
          const until = performance.now() + 1500
          while (performance.now() < until) {
            r = (await tool('browser.watch', { watchId: r.watchId, cursor: r.cursor, waitMs: Math.max(0, Math.round(until - performance.now())) })).structuredContent
            events.push(...r.events)
          }
          await new Promise((done) => setTimeout(done, 1100))
          r = (await tool('browser.watch', { watchId: r.watchId, cursor: r.cursor, waitMs: 0 })).structuredContent
          events.push(...r.events)
          await tool('browser.watch', { watchId: r.watchId, stop: true })
          const tasks = Number(text(await tool('browser.act', { targetId, steps: [{ type: 'evaluate', code: 'churnTasks' }] })).match(/evaluated: (\d+)/)?.[1])
          assert.deepEqual(events.map((e) => e.type), ['initial'], JSON.stringify(events))
          assert.ok(tasks >= 10, `the page churned only ${tasks} tasks`)
          assert.ok(r.pageChecks > 0 && r.pageChecks <= tasks + 6, `${r.pageChecks} checks for ${tasks} tasks of 10 mutations`)
          timings.churn = `${r.pageChecks} checks / ${tasks} tasks`
        } catch (error) {
          failures.push(`churn: ${error.message ?? error}`)
        } finally {
          await closeTarget(opened).catch(() => {})
        }
      },
      // A chat in a cross-site iframe: by frameId, by a ref the frame owns, and via CLI --once/--cursor.
      ...['mcp frameId', 'mcp ref', 'cli once'].map((entry) => async () => {
        const key = `chat/${entry}/${Math.random().toString(36).slice(2)}`
        const reply = (n) => releaseWatch(`${key}/${n}`)
        const opened = await openTarget(`${rootUrl}/watch-chat?key=${encodeURIComponent(key)}`, false)
        const { targetId, tabId } = opened
        const started = performance.now()
        try {
          const frame = await waitUntil(async () =>
            JSON.parse(text(await tool('frames_list', { tabId }))).find((f) => f.url.includes('/watch-chat-frame')), 'chat frame')
          if (entry === 'mcp frameId') {
            let r = (await tool('browser.watch', { targetId, frameId: frame.frameId, css: 'li.msg', count: true, intervalMs: 60000 })).structuredContent
            assert.match(r.condition, /in frame /)
            assert.equal(r.events[0]?.type, 'initial', JSON.stringify(r))
            assert.equal(r.events[0].count, 1)
            reply(1)
            const replied = performance.now()
            r = (await tool('browser.watch', { watchId: r.watchId, cursor: r.cursor, waitMs: 20000 })).structuredContent
            assert.deepEqual(r.events.map((e) => [e.type, e.count, e.added]), [['count', 2, ['Agent: first reply']]], JSON.stringify(r))
            assert.ok(performance.now() - replied < 1000, `the reply in the frame was reported after ${Math.round(performance.now() - replied)} ms`)
            await tool('browser.watch', { watchId: r.watchId, stop: true })
            r = (await tool('browser.watch', { targetId, frameId: frame.frameId, text: 'renewal done', intervalMs: 60000 })).structuredContent
            reply(2)
            while (r.active) r = (await tool('browser.watch', { watchId: r.watchId, cursor: r.cursor, waitMs: 20000 })).structuredContent
            assert.equal(r.reason, 'met', JSON.stringify(r))
          } else if (entry === 'mcp ref') {
            const tree = text(await tool('browser.observe', { targetId }))
            const list = refFor(tree, 'list', 'Messages')
            let r = (await tool('browser.watch', { targetId, refId: list, text: 'renewal done', intervalMs: 60000 })).structuredContent
            reply(1)
            reply(2)
            while (r.active) r = (await tool('browser.watch', { watchId: r.watchId, cursor: r.cursor, waitMs: 20000 })).structuredContent
            assert.equal(r.reason, 'met', JSON.stringify(r))
            assert.match(r.events.find((e) => e.type === 'met')?.value ?? '', /renewal Done/)
          } else {
            let run = await cli({ targetId, frameId: frame.frameId, css: 'li.msg', count: true, intervalMs: 60000 }, ['--once'], () => reply(1))
            assert.equal(run.code, 3, run.err)
            assert.deepEqual(run.lines.map((e) => e.type), ['initial', 'count'])
            const { watchId, seq } = run.lines.at(-1)
            reply(2)
            run = await cli(null, ['--id', watchId, '--cursor', String(seq), '--once'])
            assert.equal(run.code, 3, run.err)
            assert.deepEqual(run.lines.map((e) => [e.seq, e.added]), [[seq + 1, ['Agent: renewal Done']]])
            await tool('browser.watch', { watchId, stop: true })
          }
          timings[`iframe/${entry}`] = Math.round(performance.now() - started)
        } catch (error) {
          failures.push(`iframe/${entry}: ${error.message ?? error}`)
        } finally {
          await closeTarget(opened).catch(() => {})
        }
      }),
    ]
    await runPool(watchTasks, 3, (task) => task())
    assert.deepEqual(failures, [])
    return timings
  })
  check('G: observe rereads once when the document changes mid-read', async () => {
    const opened = (await tool('browser.open', { url: `${rootUrl}/g-churn`, observe: false })).structuredContent
    const targetId = opened.targetId
    try {
      await tool('browser.act', { targetId, steps: [{ type: 'evaluate', code: "(()=>{document.querySelector('#f').src='/g-held-frame';return 1})()" }] })
      await waitUntil(() => heldFrame, 'held iframe navigation')
      const started = performance.now()
      const pingLats = []
      let pinging = true
      const pingLoop = (async () => {
        while (pinging) {
          const p0 = performance.now()
          await tool('tabs_context', {}).catch(() => {})
          pingLats.push(Math.round(performance.now() - p0))
          await new Promise((r) => setTimeout(r, 100))
        }
      })()
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
      pinging = false
      await pingLoop
      assert.match(again, /^Frames: 2\n/)
      assert.equal(refFor(first, 'button', 'Row 0'), refFor(again, 'button', 'Row 0'))
      // Regression: reading a 20,000-row AX tree must not freeze the worker for
      // seconds and stall unrelated calls on other tabs.
      const maxPing = Math.max(...pingLats)
      assert.ok(maxPing < 1000, `large AX read stalled worker: max tabs_context=${maxPing}ms (${JSON.stringify(pingLats)})`)
      // Completeness: sections after 20,000 rows still appear in the outline
      // and can be scoped with refId, and cursor advances without gaps.
      assert.match(again, /region "Trailing"/)
      assert.match(again, /heading "Trailing"/)
      assert.match(again, /contentinfo ""/)
      const trailingRef = refFor(again, 'region', 'Trailing')
      const scoped = text(await tool('browser.observe', { targetId, refId: trailingRef, maxChars: 2000 }))
      assert.match(scoped, /TRAILING_OK/)
      const cursor = Number(/continue with cursor=(\d+)/.exec(again)?.[1])
      assert.ok(cursor > 0, `expected cursor in footer:\n${again}`)
      const lastRow = Number([...again.matchAll(/"Row (\d+)"/g)].pop()?.[1])
      const next = text(await tool('browser.observe', { targetId, maxChars: 2000, cursor }))
      assert.ok(next.includes(`"Row ${lastRow + 1}"`), `cursor=${cursor} missed Row ${lastRow + 1}:\n${next.slice(0, 400)}`)
      assert.ok(!next.includes(`"Row ${lastRow}"`), `cursor=${cursor} repeated Row ${lastRow}`)
    } finally {
      heldFrame?.end('')
      heldFrame = undefined
      await tool('browser.close', { targetId })
    }
  })
  check(correctionCheck, async () => {
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

  check('batch flow evaluates only after the intended document is ready', async () => {
    const batch = JSON.parse(text(await tool('browser.batch.flow', {
      urls: [`${rootUrl}/blank`, `${rootUrl}/scroll`], concurrency: 2,
      steps: [{ type: 'evaluate', code: 'document.title' }],
    })))
    assert.equal(batch.results[0].status, 'ok')
    assert.equal(batch.results[1].status, 'ok')
    assert.match(JSON.stringify(batch.results[0].results), /Benchmark ready/)
    assert.match(JSON.stringify(batch.results[1].results), /Scroll contract/)
  })
  // Last: it closes every remaining tab. Chrome unloads the profile, and with it
  // the extension worker and its alarms, once the last window closes.
  check('Z: closing every tab keeps a window, so the extension stays connected', { exclusive: true, last: true }, async () => {
    const listed = text(await tool('tabs_context', { all: true }))
    const ids = [...listed.matchAll(/^ {2}[ *] \[(\d+)\]/gm)].map((m) => Number(m[1]))
    assert.ok(ids.length > 0, `the window must list its tabs: ${listed}`)
    for (const id of ids) await tool('tabs_close', { tabId: id })
    // Profile teardown follows the window close asynchronously; give it time to
    // drop the connection before asserting that it did not.
    await new Promise((r) => setTimeout(r, 3000))
    const status = await (await fetch(`http://127.0.0.1:${port}/status`, { signal: cancellation.signal })).json()
    assert.equal(status.extensionCount, 1, 'the extension must stay connected after its tabs close')
    const remaining = text(await tool('tabs_context', { all: true }))
    assert.match(remaining, /Tabs \(1\):\n {2}[ *] \[\d+\] chrome:\/\/newtab\//,
      `only a New Tab page should keep the last window open: ${remaining}`)
  })
  const timing = await runChecks()
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify({ checks, pass: checks.every((c) => c.pass), ...timing }, null, 2),
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
