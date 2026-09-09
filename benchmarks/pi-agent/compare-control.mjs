// Read-only setup/cleanup diagnostics for the private broker, outside model timing.
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const control = JSON.parse(await readFile(process.argv[2], 'utf8'))
const token = JSON.parse(await readFile(control.settingsPath, 'utf8')).token
const client = new Client({ name: 'ref-comparison-control', version: '1' })
const text = r => r.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') ?? ''
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args })
  if (r.isError) throw new Error(`${name}: ${text(r)}`)
  return text(r)
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(control.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  if (process.argv[3] === 'viewport') {
    const flow = JSON.parse(await call('browser.flow.start', { url: control.rootUrl + '/blank', active: false }))
    try {
      const viewport = JSON.parse(await call('javascript_tool', { tabId: flow.tabId, code: '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,outerWidth,outerHeight})' }))
      console.log(JSON.stringify(viewport))
    } finally { await call('browser.flow.finish', { sessionId: flow.sessionId }) }
  } else if (process.argv[3] === 'cleanup') {
    const run = process.argv[4]
    const tabs = await call('tabs_context', { all: true })
    const owned = [...tabs.matchAll(/\[(\d+)\]\s+(\S+)/g)].filter(m => m[2].includes(`run=${run}`))
    for (const match of owned) await call('tabs_close', { tabId: Number(match[1]) })
    console.log(JSON.stringify({ leakedTaskTabs: owned.length }))
  } else throw new Error('Expected viewport or cleanup')
} finally { await client.close() }
