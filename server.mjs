#!/usr/bin/env node
/**
 * dsh-jj — MCP stdio server exposing the local jj (Jujutsu) CLI as Model
 * Context Protocol tools. Usable from DSH (mcp__jj__*), Claude Code, Codex,
 * and any MCP client.
 *
 * Zero dependencies: plain Node >= 18, newline-delimited JSON-RPC 2.0 over
 * stdio (same framing as the kimi-webbridge-mcp / DSH mcp-client family).
 *
 * Every tool talks to the real `jj` binary via spawn (no shell), so args are
 * injection-safe. All jj operations are undoable (jj undo / jj op restore),
 * so the exposed surface is intentionally permissive.
 *
 * Environment:
 *   JJ_MCP_BIN            jj binary path (default /opt/homebrew/bin/jj, fallback 'jj')
 *   JJ_MCP_TIMEOUT_MS     per-call timeout (default 60000)
 *   JJ_MCP_DEFAULT_REPO   default repo directory (optional; otherwise each
 *                         tool's `repo` arg, then walk up from cwd for .jj)
 *   JJ_MCP_LOG            '0' silences the stderr startup banner (default '1')
 */

import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const PROTOCOL_VERSION = '2024-11-05'
const MAX_RESULT_TEXT = 1_000_000
const MAX_ERROR_TEXT = 500

const cfg = {
  jjBin: process.env.JJ_MCP_BIN || (existsSync('/opt/homebrew/bin/jj') ? '/opt/homebrew/bin/jj' : 'jj'),
  timeoutMs: Number(process.env.JJ_MCP_TIMEOUT_MS || 60_000),
  defaultRepo: process.env.JJ_MCP_DEFAULT_REPO || '',
  log: (process.env.JJ_MCP_LOG ?? '1') !== '0',
}

// ── Repo resolution ─────────────────────────────────────────────────────────

/** Walk up from `start` until a .jj directory is found; return the repo root. */
function findRepoRoot(start) {
  let dir = resolve(start)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(`${dir}/.jj`)) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Resolve the repo for one call: explicit repo arg > default repo > cwd walk. */
function resolveRepo(repoArg) {
  if (repoArg) {
    const abs = resolve(String(repoArg))
    if (!existsSync(abs)) throw new Error(`repo not found: ${abs}`)
    return abs
  }
  if (cfg.defaultRepo) {
    const abs = resolve(cfg.defaultRepo)
    if (!existsSync(abs)) throw new Error(`JJ_MCP_DEFAULT_REPO not found: ${abs}`)
    return abs
  }
  const found = findRepoRoot(process.cwd())
  if (!found) {
    throw new Error(
      `no jj repo found from ${process.cwd()} (not a .jj repo, and no repo arg / JJ_MCP_DEFAULT_REPO given)`
    )
  }
  return found
}

/** Run `jj` with argv in repoDir; resolves { stdout, stderr, code }. */
function runJj(repoDir, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.jjBin, argv, {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`jj timed out after ${cfg.timeoutMs}ms: jj ${argv.join(' ')}`))
    }, cfg.timeoutMs)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`cannot run jj (${cfg.jjBin}): ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: out, stderr: err, code: code ?? -1 })
    })
  })
}

/** jj wrapper used by every tool: builds args, runs, formats the result. */
async function execJj(repo, argv) {
  const repoDir = resolveRepo(repo)
  const { stdout, stderr, code } = await runJj(repoDir, argv)
  if (code !== 0) {
    const detail = (stderr || stdout).trim().slice(0, MAX_ERROR_TEXT)
    throw new Error(`jj ${argv[0] ?? '<cmd>'} exited ${code} in ${repoDir}: ${detail}`)
  }
  return { repo: repoDir, command: `jj ${argv.join(' ')}`, stdout }
}

/** Reject config-injection flags outright: jj config can set ui.editor etc.
 * and would let a malicious repo run arbitrary commands. */
function sanitizeJjArgs(argv) {
  const banned = ['--config', '--config-toml', '--config-file']
  for (const flag of banned) {
    if (argv.includes(flag) || argv.some((a, i) => i > 0 && argv[i - 1] === flag)) {
      throw new Error(`jj_run rejects ${flag} (config injection is not allowed)`)
    }
  }
  if (argv.length === 0) throw new Error('jj_run requires at least one argument')
  return argv
}

// ── Tool catalog ────────────────────────────────────────────────────────────

const REPO_ARG = {
  type: 'string',
  description: 'Optional path to the jj repo root. Default: JJ_MCP_DEFAULT_REPO, else the nearest directory containing .jj walked up from the server cwd.',
}

const TOOLS = [
  {
    name: 'jj_status',
    description:
      'jj status — summary of the current change (change id, description, working-copy file modifications). Equivalent to git status + a bit of git log. Use first to see where you are.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        change: { type: 'string', description: 'Show status of this change instead of the current one (-r <revset>).' },
      },
    },
  },
  {
    name: 'jj_log',
    description:
      'jj log — change graph (replaces git log). Shows change ids (stable, use as references), descriptions, bookmarks, @ = current change. The topmost commit is often the remote branch bookmark (e.g. master).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        limit: { type: 'integer', minimum: 1, description: 'Max changes to show (-n). Default 20.' },
        revset: { type: 'string', description: 'Revset to show (-r), e.g. "master", "..", "all()". Default: the visible graph.' },
        noGraph: { type: 'boolean', description: 'Flat one-line-per-change output (--no-graph) — easier to parse; change id is the first token.' },
      },
    },
  },
  {
    name: 'jj_diff',
    description:
      'jj diff — diff of the current change vs its parent, or of a specific change (-r). No staging area: working-copy edits ARE the change, so this shows exactly what would be committed.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        change: { type: 'string', description: 'Diff this change instead of the current one (-r <revset>).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional paths to restrict the diff to.' },
      },
    },
  },
  {
    name: 'jj_describe',
    description:
      'jj describe — set/update the description (commit message) of the current change, or of a change given by -r. Message format: first line title, blank line, body.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        message: { type: 'string', description: 'New description (-m).' },
        change: { type: 'string', description: 'Change to describe (-r), default current.' },
      },
      required: ['message'],
    },
  },
  {
    name: 'jj_new',
    description:
      'jj new — finish nothing: create a new empty change on top of the current one (or of `base`) and make it current. The old change stays intact. No add/commit ceremony. Use -m to pre-describe it.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        message: { type: 'string', description: 'Pre-describe the new change (-m).' },
        base: { type: 'string', description: 'Branch the new change off this change/revset instead of the current one.' },
        insertBefore: { type: 'boolean', description: 'Insert the new change between the parent and the current change (--insert-before).' },
      },
    },
  },
  {
    name: 'jj_commit',
    description:
      'jj commit — describe the current change and start a new empty one on top (shorthand for describe + new). Use to seal a change and move to the next task in one step.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        message: { type: 'string', description: 'Description for the change being sealed (-m).' },
        insertBefore: { type: 'boolean', description: 'Insert the new change between the parent and the current change (--insert-before).' },
      },
      required: ['message'],
    },
  },
  {
    name: 'jj_edit',
    description:
      'jj edit — jump to an existing change and continue editing it. Descendants auto-rebase. jj refuses if the target is immutable (already pushed), so it is always safe.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        change: { type: 'string', description: 'Change id (unique prefix ok) or revset to edit.' },
      },
      required: ['change'],
    },
  },
  {
    name: 'jj_abandon',
    description:
      'jj abandon — discard a change completely (its edits are absorbed into the parent). Defaults to the current change. Safe: nothing is lost until you jj gc, and jj undo restores it.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        change: { type: 'string', description: 'Change to abandon; default current @.' },
        keepDescendants: { type: 'boolean', description: 'Keep descendants of the abandoned change (--keep-descendants).' },
      },
    },
  },
  {
    name: 'jj_undo',
    description:
      'jj undo — undo the last jj operation, whatever it was (describe, new, rebase, split...). Always safe. For deeper recovery use jj_run with "op log" / "op restore".',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
      },
    },
  },
  {
    name: 'jj_rebase',
    description:
      'jj rebase — move a change (and its descendants) onto a new parent. Defaults to moving the current change. Typical use: rebase local work onto the latest remote branch.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        destination: { type: 'string', description: 'New parent change/revset (-d), e.g. "master" or a change id.' },
        source: { type: 'string', description: 'Change to move (-s). Default: current change.' },
        after: { type: 'boolean', description: 'Insert as a sibling after destination instead of as a child (--after).' },
      },
      required: ['destination'],
    },
  },
  {
    name: 'jj_fetch',
    description:
      'jj git fetch — fetch from the git remote (like git fetch). Remote branches become jj bookmarks.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        remote: { type: 'string', description: 'Remote name to fetch from (default: all remotes).' },
      },
    },
  },
  {
    name: 'jj_push',
    description:
      'jj git push — push bookmarks to the git remote (like git push). Remote sees ordinary git commits/branches. Use --bookmark to push one bookmark (create it first with jj_bookmark create).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        bookmark: { type: 'array', items: { type: 'string' }, description: 'Bookmark name(s) to push (--bookmark, repeatable). Default: all changed bookmarks.' },
        deleted: { type: 'boolean', description: 'Also delete remote bookmarks that were deleted locally (--deleted).' },
        all: { type: 'boolean', description: 'Push all local bookmarks (--all).' },
      },
    },
  },
  {
    name: 'jj_bookmark',
    description:
      'jj bookmark — manage bookmarks (= git branches, only needed for pushing). create: point a NEW bookmark at a change. set: MOVE an existing bookmark. track: follow a remote branch (name@remote). untrack: stop following. delete: remove locally. move: repoint. list: show bookmarks.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        action: { type: 'string', enum: ['create', 'set', 'track', 'untrack', 'delete', 'move', 'list'], description: 'Operation to run.' },
        name: { type: 'string', description: 'Bookmark name. For track/untrack use name@remote form, e.g. main@origin.' },
        change: { type: 'string', description: 'Change/revset the bookmark points at (-r); default current @ for create/set/move.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'jj_run',
    description:
      'jj run — generic passthrough for any jj command not covered above (e.g. split, workspace, op log, op restore, file show). Pass argv exactly as you would after "jj". --config / --config-toml flags are blocked. All operations remain undoable.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_ARG,
        args: { type: 'array', items: { type: 'string' }, description: 'jj arguments, e.g. ["split", "path/to/file"] or ["op", "log"]. First element must be a subcommand.' },
      },
      required: ['args'],
    },
  },
]

// ── Per-tool argument builders ──────────────────────────────────────────────

/** Build jj argv from the tool call. Returns { argv, repo }. */
function buildArgv(name, args) {
  const repo = args.repo
  const a = (s) => [s]
  switch (name) {
    case 'jj_status': {
      const argv = ['status', '--color', 'never']
      if (args.change) argv.push('-r', String(args.change))
      return { argv, repo }
    }
    case 'jj_log': {
      const argv = ['log']
      if (args.noGraph) argv.push('--no-graph')
      if (args.revset) argv.push('-r', String(args.revset))
      argv.push('-n', String(args.limit ?? 20))
      return { argv, repo }
    }
    case 'jj_diff': {
      const argv = ['diff', '--color', 'never']
      if (args.change) argv.push('-r', String(args.change))
      if (Array.isArray(args.files)) argv.push(...args.files.map(String))
      return { argv, repo }
    }
    case 'jj_describe': {
      const argv = ['describe']
      if (args.change) argv.push('-r', String(args.change))
      argv.push('-m', String(args.message))
      return { argv, repo }
    }
    case 'jj_new': {
      const argv = ['new']
      if (args.insertBefore) argv.push('--insert-before')
      if (args.message) argv.push('-m', String(args.message))
      if (args.base) argv.push(String(args.base))
      return { argv, repo }
    }
    case 'jj_commit': {
      const argv = ['commit']
      if (args.insertBefore) argv.push('--insert-before')
      argv.push('-m', String(args.message))
      return { argv, repo }
    }
    case 'jj_edit': {
      return { argv: ['edit', String(args.change)], repo }
    }
    case 'jj_abandon': {
      const argv = ['abandon']
      if (args.keepDescendants) argv.push('--keep-descendants')
      if (args.change) argv.push(String(args.change))
      return { argv, repo }
    }
    case 'jj_undo': {
      return { argv: ['undo'], repo }
    }
    case 'jj_rebase': {
      const argv = ['rebase']
      if (args.after) argv.push('--after')
      if (args.source) argv.push('-s', String(args.source))
      argv.push('-d', String(args.destination))
      return { argv, repo }
    }
    case 'jj_fetch': {
      const argv = ['git', 'fetch']
      if (args.remote) argv.push('--remote', String(args.remote))
      return { argv, repo }
    }
    case 'jj_push': {
      const argv = ['git', 'push']
      if (Array.isArray(args.bookmark)) for (const b of args.bookmark) argv.push('--bookmark', String(b))
      if (args.deleted) argv.push('--deleted')
      if (args.all) argv.push('--all')
      return { argv, repo }
    }
    case 'jj_bookmark': {
      const action = String(args.action)
      const argv = ['bookmark']
      if (action === 'list') {
        argv.push('list')
        if (args.name) argv.push(String(args.name))
      } else if (action === 'track' || action === 'untrack') {
        if (!args.name) throw new Error('jj_bookmark track/untrack requires name (name@remote, e.g. main@origin)')
        argv.push(action, String(args.name))
      } else {
        if (!args.name) throw new Error(`jj_bookmark ${action} requires name`)
        argv.push(action, String(args.name))
        if (args.change) argv.push('-r', String(args.change))
        else if (action === 'create' || action === 'set' || action === 'move') argv.push('-r', '@')
      }
      return { argv, repo }
    }
    case 'jj_run': {
      if (!Array.isArray(args.args) || args.args.length === 0) {
        throw new Error('jj_run requires args (array of jj arguments)')
      }
      const argv = sanitizeJjArgs(args.args.map(String))
      return { argv, repo }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

async function callTool(name, args) {
  const { argv, repo } = buildArgv(name, args)
  return execJj(repo, argv)
}

// ── MCP JSON-RPC over stdio ─────────────────────────────────────────────────

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function handle(message) {
  // Notifications and malformed messages get no reply.
  if (message.id === undefined || typeof message.id === 'object' || message.id === null) return null
  if (message.jsonrpc !== '2.0') return null

  if (message.method === 'initialize') {
    return rpcResult(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'dsh-jj', version: '1.0.0' },
    })
  }
  if (message.method === 'ping') return rpcResult(message.id, {})
  if (message.method === 'tools/list') return rpcResult(message.id, { tools: TOOLS })
  if (message.method === 'tools/call') {
    const name = typeof message.params?.name === 'string' ? message.params.name : ''
    const args = (message.params?.arguments && typeof message.params.arguments === 'object')
      ? message.params.arguments
      : {}
    if (!name) return rpcError(message.id, -32602, 'tools/call requires params.name')
    try {
      const value = await callTool(name, args)
      return rpcResult(message.id, { content: [{ type: 'text', text: JSON.stringify(value) }] })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      return rpcResult(message.id, {
        content: [{ type: 'text', text: text.slice(0, MAX_RESULT_TEXT) }],
        isError: true,
      })
    }
  }
  return rpcError(message.id, -32601, `Method not found: ${message.method ?? '<missing>'}`)
}

// ── Main loop ───────────────────────────────────────────────────────────────

if (cfg.log) {
  process.stderr.write(
    `[jj-mcp] ready (jj: ${cfg.jjBin}, timeout: ${cfg.timeoutMs}ms${cfg.defaultRepo ? `, default repo: ${cfg.defaultRepo}` : ''})\n`
  )
}

const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  if (!line.trim()) continue
  let response
  try {
    const message = JSON.parse(line)
    response = await handle(message)
  } catch {
    response = rpcError(0, -32700, 'Parse error')
  }
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
}
