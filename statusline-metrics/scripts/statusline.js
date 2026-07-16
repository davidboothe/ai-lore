#!/usr/bin/env node
'use strict'

/*
 * statusline-metrics: Claude Code custom status line renderer.
 *
 * Claude Code pipes a JSON payload to this command on stdin for every status
 * line render; we print exactly one line to stdout. Everything is wrapped so a
 * missing/renamed field degrades to a dropped segment and any thrown error
 * still prints a minimal fallback line and exits 0 -- the status line must
 * never break the CLI.
 *
 * Usage (set as the `statusLine.command` in settings.json):
 *   node /abs/path/statusline.js [--style=emoji|ascii|powerline]
 *                                [--segments=context,branch,cost,meta]
 *
 * Data sources:
 *   spend         cost.total_cost_usd
 *   lines         cost.total_lines_added / total_lines_removed
 *   model         model.display_name / model.id
 *   directory     workspace.current_dir (fallback: cwd)
 *   branch        `git -C <cwd> ...` (not in payload; derived)
 *   context bar   parse transcript_path JSONL, last assistant message usage
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { style: 'emoji', segments: ['context', 'branch', 'cost', 'meta'] }
  for (const a of argv) {
    let m
    if ((m = /^--style=(.+)$/.exec(a))) out.style = m[1].trim()
    else if ((m = /^--segments=(.+)$/.exec(a))) {
      out.segments = m[1].split(',').map((s) => s.trim()).filter(Boolean)
    }
  }
  if (!STYLES[out.style]) out.style = 'emoji'
  return out
}

// ---------------------------------------------------------------------------
// styles: per-style glyphs and labels. Every segment reads from here so a new
// style is a single table entry.
// ---------------------------------------------------------------------------
const STYLES = {
  emoji: {
    barFull: '█', barEmpty: '░', barOpen: '[', barClose: ']',
    branchIcon: '⎇ ', costIcon: '$', sep: '   ', metaSep: ' · ',
    color: true,
  },
  ascii: {
    barFull: '#', barEmpty: '.', barOpen: '[', barClose: ']',
    branchIcon: 'br:', costIcon: '$', sep: '  |  ', metaSep: ' / ',
    color: false,
  },
  powerline: {
    barFull: '█', barEmpty: '░', barOpen: '', barClose: '',
    branchIcon: ' ', costIcon: '$', sep: '    ', metaSep: ' · ',
    color: true,
  },
}

// ---------------------------------------------------------------------------
// color helpers (respect NO_COLOR)
// ---------------------------------------------------------------------------
const useColor = () => !process.env.NO_COLOR
function paint(code, s) {
  if (!useColor()) return s
  return `[${code}m${s}[0m`
}
const dim = (s) => paint('2', s)
const green = (s) => paint('32', s)
const yellow = (s) => paint('33', s)
const red = (s) => paint('31', s)
const cyan = (s) => paint('36', s)

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------
function formatTokens(n) {
  if (!Number.isFinite(n)) return '?'
  if (n >= 1000000) return `${Math.round(n / 100000) / 10}M`.replace('.0M', 'M')
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`.replace('.0k', 'k')
  return String(n)
}

// ---------------------------------------------------------------------------
// context window: read transcript JSONL from the end, find the last assistant
// message with usage, sum the tokens currently resident in context.
// ---------------------------------------------------------------------------
function contextWindow(model, exceeds200k) {
  const id = (model && (model.id || model.display_name) || '').toLowerCase()
  if (/\[1m\]|1m|\b1000000\b/.test(id)) return 1000000
  if (exceeds200k) return 1000000
  return 200000
}

function usedContextTokens(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null
  let lines
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n')
  } catch {
    return null
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const msg = ev && (ev.message || ev)
    const usage = msg && msg.usage
    if (ev && (ev.type === 'assistant' || (msg && msg.role === 'assistant')) && usage) {
      const t =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0)
      if (t > 0) return t
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// segment builders. Each returns a string, or null to omit the segment.
// ---------------------------------------------------------------------------
function segContext(data, st) {
  const used = usedContextTokens(data.transcript_path)
  const window = contextWindow(data.model, data.exceeds_200k_tokens)
  if (used == null) return null
  const pct = Math.min(100, Math.max(0, (used / window) * 100))
  const cells = 10
  const filled = Math.min(cells, Math.round((pct / 100) * cells))
  const bar = st.barFull.repeat(filled) + st.barEmpty.repeat(cells - filled)
  const tint = pct >= 90 ? red : pct >= 70 ? yellow : green
  const pctStr = `${Math.round(pct)}%`
  const counts = dim(`${formatTokens(used)}/${formatTokens(window)}`)
  return `${st.barOpen}${tint(bar)}${st.barClose} ${pctStr} · ${counts}`
}

function segBranch(data, st) {
  const cwd = (data.workspace && data.workspace.current_dir) || data.cwd
  if (!cwd) return null
  let branch = null
  let dirty = false
  try {
    branch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 400,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return null // not a git repo (or git unavailable) -> omit segment
  }
  if (!branch || branch === 'HEAD') branch = branch || 'detached'
  try {
    const porcelain = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      timeout: 400,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    dirty = porcelain.length > 0
  } catch {
    /* leave dirty=false */
  }
  return `${dim(st.branchIcon)}${branch}${dirty ? yellow('*') : ''}`
}

function segCost(data, st) {
  const cost = data.cost && data.cost.total_cost_usd
  if (!Number.isFinite(cost)) return null
  const s = cost >= 100 ? cost.toFixed(0) : cost.toFixed(2)
  return green(`${st.costIcon}${s}`)
}

function segMeta(data, st) {
  const parts = []
  const model = data.model && data.model.display_name
  if (model) parts.push(cyan(model))
  const cwd = (data.workspace && data.workspace.current_dir) || data.cwd
  if (cwd) parts.push(path.basename(cwd))
  const added = data.cost && data.cost.total_lines_added
  const removed = data.cost && data.cost.total_lines_removed
  if (Number.isFinite(added) || Number.isFinite(removed)) {
    const a = added || 0
    const r = removed || 0
    if (a || r) parts.push(`${green('+' + a)}${dim('/')}${red('-' + r)}`)
  }
  if (!parts.length) return null
  return parts.join(st.metaSep)
}

const BUILDERS = {
  context: segContext,
  branch: segBranch,
  cost: segCost,
  meta: segMeta,
}

// ---------------------------------------------------------------------------
// fallback: the smallest useful line, used when the main render throws.
// ---------------------------------------------------------------------------
function fallbackLine(data) {
  try {
    const cwd = (data && data.workspace && data.workspace.current_dir) || (data && data.cwd)
    return cwd ? path.basename(cwd) : 'claude'
  } catch {
    return 'claude'
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2))
  const st = STYLES[args.style]

  let raw = ''
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch {
    raw = ''
  }

  let data = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = {}
  }

  try {
    const segments = args.segments
      .map((name) => (BUILDERS[name] ? BUILDERS[name](data, st) : null))
      .filter((s) => s != null && s !== '')
    const line = segments.join(st.sep)
    process.stdout.write(line || fallbackLine(data))
  } catch {
    process.stdout.write(fallbackLine(data))
  }
}

main()
