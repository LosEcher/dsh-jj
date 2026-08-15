#!/usr/bin/env node
/**
 * MCP client smoke test for dsh-jj.
 *
 * Spawns server.mjs over stdio and walks the real MCP handshake:
 *   initialize -> notifications/initialized -> tools/list -> tools/call
 *
 * Usage:
 *   node test/test-client.mjs <repo-dir>          # real jj repo, runs the full suite
 *   node test/test-client.mjs --list              # just tools/list
 *   node test/test-client.mjs <repo-dir> --tool jj_status
 *   node test/test-client.mjs <repo-dir> --tool jj_run --args '["op","log"]'
 *
 * Exit code 0 on success, 1 on any failure. Prints one line per response.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

const onlyList = args.includes('--list')
const repoIndex = args.findIndex((a) => !a.startsWith('--'))
const repo = repoIndex >= 0 ? args[repoIndex] : null
const toolIndex = args.indexOf('--tool')
const onlyTool = toolIndex >= 0 ? args[toolIndex + 1] : null
const onlyArgs = (() => {
  const i = args.indexOf('--args')
  return i >= 0 ? JSON.parse(args[i + 1]) : null
})()

const env = { ...process.env }
if (repo) env.JJ_MCP_DEFAULT_REPO = repo

const child = spawn(process.execPath, [join(root, 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env,
})

let buf = ''
const pending = new Map()
let nextId = 0

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  }
})

function rpc(method, params) {
  const id = ++nextId
  return new Promise((resolve) => {
    pending.set(id, { resolve })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

function assert(cond, label, detail) {
  if (!cond) {
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
    process.exitCode = 1
    throw new Error(`assertion failed: ${label}`)
  }
  console.log(`PASS ${label}`)
}

function toolResultText(msg) {
  const content = msg.result?.content ?? []
  const text = content.map((c) => c.text ?? '').join('\n')
  return { text, isError: Boolean(msg.result?.isError) }
}

try {
  // 1. initialize
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-jj-test', version: '0.0.1' },
  })
  assert(init.result?.serverInfo?.name === 'dsh-jj', 'initialize returns dsh-jj', JSON.stringify(init.result))
  assert(init.result?.protocolVersion === '2024-11-05', 'protocol version', JSON.stringify(init.result))

  // 2. initialized notification (no reply expected)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  // 3. tools/list
  const list = await rpc('tools/list', {})
  const tools = list.result?.tools ?? []
  assert(Array.isArray(tools) && tools.length >= 10, `tools/list returns >=10 tools (got ${tools.length})`)
  const names = tools.map((t) => t.name)
  for (const expected of ['jj_status', 'jj_log', 'jj_diff', 'jj_describe', 'jj_new', 'jj_commit', 'jj_edit', 'jj_abandon', 'jj_undo', 'jj_rebase', 'jj_fetch', 'jj_push', 'jj_bookmark', 'jj_run']) {
    assert(names.includes(expected), `tool ${expected} present`)
  }
  if (onlyList) process.exit(process.exitCode ?? 0)

  // 4. tools/call — full suite against a real repo
  const call = async (name, argsObj) => {
    const msg = await rpc('tools/call', { name, arguments: argsObj ?? {} })
    const { text, isError } = toolResultText(msg)
    return { text, isError, msg }
  }

  const isOnly = (name) => onlyTool !== null && onlyTool !== name

  // 4a. jj_status on the fresh repo
  if (!isOnly('jj_status')) {
    const r = await call('jj_status')
    assert(!r.isError, 'jj_status succeeds', r.text)
    assert(/repo/.test(r.text), 'jj_status reports repo')
  }

  // 4b. jj_new -m
  if (!isOnly('jj_new')) {
    const r = await call('jj_new', { message: 'test: first change from dsh-jj test' })
    assert(!r.isError, 'jj_new succeeds', r.text)
  }

  // 4c. jj_status now shows the change
  if (!isOnly('jj_status')) {
    const r = await call('jj_status')
    assert(!r.isError && /test: first change/.test(r.text), 'jj_status shows new change', r.text)
  }

  // 4d. jj_log
  if (!isOnly('jj_log')) {
    const r = await call('jj_log', { limit: 5, noGraph: true })
    assert(!r.isError && /test: first change/.test(r.text), 'jj_log shows the change', r.text)
  }

  // 4e. jj_diff on empty change
  if (!isOnly('jj_diff')) {
    const r = await call('jj_diff')
    assert(!r.isError, 'jj_diff succeeds (empty change)', r.text)
  }

  // 4f. jj_describe
  if (!isOnly('jj_describe')) {
    const r = await call('jj_describe', { message: 'test: described later' })
    assert(!r.isError, 'jj_describe succeeds', r.text)
    const s = await call('jj_status')
    assert(!s.isError && /test: described later/.test(s.text), 'jj_describe applied', s.text)
  }

  // 4g. jj_commit
  if (!isOnly('jj_commit')) {
    const r = await call('jj_commit', { message: 'test: committed change' })
    assert(!r.isError, 'jj_commit succeeds', r.text)
  }

  // 4h. jj_undo (undo the commit, back to one change)
  if (!isOnly('jj_undo')) {
    const r = await call('jj_undo')
    assert(!r.isError, 'jj_undo succeeds', r.text)
  }

  // 4i. jj_run op log
  if (!isOnly('jj_run')) {
    const r = await call('jj_run', { args: ['op', 'log'] })
    assert(!r.isError, 'jj_run op log succeeds', r.text)
    // config-injection flags must be rejected
    const bad = await call('jj_run', { args: ['--config-toml', 'ui.editor="x"', 'status'] })
    assert(bad.isError, 'jj_run blocks --config-toml', bad.text)
  }

  // 4j. jj_bookmark list
  if (!isOnly('jj_bookmark')) {
    const r = await call('jj_bookmark', { action: 'list' })
    assert(!r.isError, 'jj_bookmark list succeeds', r.text)
  }

  console.log('ALL TESTS PASSED')
  process.exit(0)
} catch (error) {
  console.error(`TEST RUN FAILED: ${error.message}`)
  process.exit(1)
} finally {
  child.kill()
}
