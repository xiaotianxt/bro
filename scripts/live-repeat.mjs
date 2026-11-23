#!/usr/bin/env node
// Run N whole live-refs suites at once and count passes per check. Each run
// has its own Chrome, profile, bro port and output directory, so the runs share
// nothing but the machine. Every other flag passes through to live-refs.mjs.
//
//   node scripts/live-repeat.mjs --runs 3 --extension DIR --chrome BIN --bro BIN [--checks T:]
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdir, open, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'live-refs.mjs')
const flags = process.argv.slice(2)
const runsAt = flags.indexOf('--runs')
const runs = runsAt === -1 ? 3 : Number(flags[runsAt + 1])
if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs takes a positive integer')
const passed = runsAt === -1 ? flags : flags.toSpliced(runsAt, 2)
for (const owned of ['--port', '--output', '--serve'])
  if (passed.includes(owned)) throw new Error(`${owned} is set per run; do not pass it`)

// A port the OS just handed out; live-refs.mjs fails fast if it was taken since.
const freePort = async () => {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}
const root = resolve(tmpdir(), `bro-repeat-${Date.now()}`)
const children = []
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    for (const child of children) child.kill(signal)
  })

console.log(`${runs} runs in ${root}`)
const started = performance.now()
const outcomes = await Promise.all(
  Array.from({ length: runs }, async (_, i) => {
    const output = resolve(root, `run-${i + 1}`)
    await mkdir(output, { recursive: true, mode: 0o700 })
    const log = await open(resolve(output, 'stdout.log'), 'w')
    const child = spawn(process.execPath, [script, ...passed, '--port', String(await freePort()), '--output', output], {
      stdio: ['ignore', log.fd, log.fd],
    })
    children.push(child)
    const [code, signal] = await once(child, 'exit')
    await log.close()
    let results
    try {
      results = JSON.parse(await readFile(resolve(output, 'results.json'), 'utf8'))
    } catch {
      // No results: the run failed before or after its checks.
    }
    console.log(`run ${i + 1}: ${results ? `${results.checks.filter((c) => c.pass).length}/${results.checks.length} passed` : 'no results'}, exit ${code ?? signal}, ${output}`)
    return { i: i + 1, code, signal, output, results }
  }),
)
const seconds = Math.round((performance.now() - started) / 1000)

// An assertion's message leads with boilerplate ("Expected values to be
// strictly deep-equal:", the diff legend, brackets); the reason is in the lines
// after it.
const boilerplate = /^(AssertionError.*|Expected values .*|\+ actual - expected|[+-]?\s*[\[\]{}]?,?|- \[\]|\.\.\.)$/
const reason = (error) => {
  const lines = error.split('\n').map((line) => line.trim()).filter((line) => !boilerplate.test(line))
  return (lines.slice(0, 3).join(' | ') || error.split('\n')[0]).slice(0, 400)
}

// Per check: passes across the runs that reported, and each failure's reason.
const table = new Map()
for (const { i, results } of outcomes)
  for (const c of results?.checks ?? []) {
    const row = table.get(c.name) ?? { pass: 0, runs: 0, failures: [] }
    row.runs++
    if (c.pass) row.pass++
    else row.failures.push(`run ${i}: ${reason(c.error)}`)
    table.set(c.name, row)
  }
console.log(`\nPasses per check (${runs} runs, ${seconds}s wall):`)
for (const [name, row] of table) {
  console.log(`${row.pass === runs ? '  ' : '✗ '}${row.pass}/${runs}  ${name.slice(0, 110)}`)
  for (const failure of row.failures) console.log(`        ${failure}`)
}
const broken = outcomes.filter((o) => !o.results)
for (const o of broken) console.log(`run ${o.i} reported no results; see ${o.output}/stdout.log`)
const phases = outcomes.filter((o) => o.results?.phases).map((o) => `run ${o.i} ${JSON.stringify(o.results.phases)}`)
if (phases.length) console.log(`Phases (s): ${phases.join('; ')}`)
if (broken.length || outcomes.some((o) => o.code !== 0) || [...table.values()].some((row) => row.pass !== runs))
  process.exitCode = 1
