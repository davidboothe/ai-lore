#!/usr/bin/env node
'use strict'

/*
 * statusline-metrics: Claude Code custom status line renderer.
 *
 * Cross-platform, zero-dependency Node port of scripts/statusline-command.sh --
 * that shell script is the design reference; this file is the shipped renderer
 * and MUST reproduce its output byte-for-byte (sans the shell's jq/awk deps) so
 * the status line looks identical on macOS, Linux, and Windows. When you change
 * the look, change it in both and keep the parity diff (see README) green.
 *
 * Canonical line:
 *   [model] repo (branch)  [███░░░░░░░] NN% tok/max  cache-read ⚡ C  +A -R  ⏱ D  $cost
 *
 * Claude Code pipes a JSON payload to this command on stdin for every status
 * line render; we print exactly one line to stdout (no trailing newline).
 * Everything is wrapped so a missing/renamed field degrades to a dropped
 * segment and any thrown error still prints a minimal fallback and exits 0 --
 * the status line must never break the CLI. Any CLI args are ignored, so stale
 * commands from older installs (e.g. `--style=emoji`) still render this look.
 *
 * Data sources (mirrors the reference script's jq paths):
 *   model    model.display_name (fallback "Unknown")
 *   repo     basename(git toplevel) else basename(cwd)
 *   branch   `git -C <cwd> branch --show-current` (omitted outside a work tree)
 *   context  context_window.used_percentage / .total_input_tokens /
 *            .context_window_size
 *   cache    context_window.current_usage.cache_read_input_tokens
 *   lines    cost.total_lines_added / total_lines_removed
 *   duration cost.total_duration_ms
 *   spend    cost.total_cost_usd (default 0)
 *   cwd      workspace.current_dir (fallback: cwd)
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// ---------------------------------------------------------------------------
// colors -- bold + bright so they stay vivid in the dimmed status-line area
// (honor NO_COLOR; the reference script's palette otherwise, byte-identical)
// ---------------------------------------------------------------------------
const NO_COLOR = !!process.env.NO_COLOR
function paint(code, s) {
  return NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`
}
const cyan = (s) => paint('1;96', s)
const yellow = (s) => paint('1;93', s)
const green = (s) => paint('1;92', s)
const red = (s) => paint('1;91', s)
const blue = (s) => paint('1;94', s)
const magenta = (s) => paint('1;95', s)
const white = (s) => paint('1;97', s)

// ---------------------------------------------------------------------------
// formatters (match the reference script's awk exactly)
// ---------------------------------------------------------------------------
// tokens: 470000 -> "470k", 1000000 -> "1.0M"
function fmtTokens(n) {
  if (!Number.isFinite(n)) return null
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(Math.trunc(n))
}
// duration: ms -> "45s" / "12m" / "1h5m"
function fmtDur(ms) {
  const s = Math.trunc(ms / 1000)
  if (s >= 3600) return `${Math.trunc(s / 3600)}h${Math.trunc((s % 3600) / 60)}m`
  if (s >= 60) return `${Math.trunc(s / 60)}m`
  return `${s}s`
}

// ---------------------------------------------------------------------------
// git: repo name + current branch (skip optional locks so we never write to
// the repo). Returns { repo, branch } with branch '' when not in a work tree.
// ---------------------------------------------------------------------------
function gitInfo(cwd) {
  const out = { repo: '', branch: '' }
  if (!cwd) return out
  const git = (args) =>
    execFileSync('git', ['-C', cwd, '--no-optional-locks', ...args], {
      timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return out
  } catch {
    return out // not a git repo (or git unavailable)
  }
  try {
    out.branch = git(['branch', '--show-current'])
  } catch {
    /* leave branch empty */
  }
  try {
    out.repo = path.basename(git(['rev-parse', '--show-toplevel']))
  } catch {
    /* fall back to cwd basename below */
  }
  return out
}

// ---------------------------------------------------------------------------
// context-usage bar (10 cells) + used/max tokens, colored by fill level
// ---------------------------------------------------------------------------
function contextSegment(cw) {
  const used = cw.used_percentage
  if (!Number.isFinite(used)) {
    return { text: '[░░░░░░░░░░] --%', color: green }
  }
  const usedInt = Math.round(used)
  const filled = Math.min(10, Math.max(0, Math.floor(usedInt / 10)))
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
  let text = `[${bar}] ${usedInt}%`
  const tok = fmtTokens(cw.total_input_tokens)
  const max = fmtTokens(cw.context_window_size)
  if (tok != null && max != null) text += ` ${tok}/${max}`
  // alert color: green <60, yellow 60-79, red >=80
  const color = usedInt >= 80 ? red : usedInt >= 60 ? yellow : green
  return { text, color }
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
function render(data) {
  const cost = data.cost || {}
  const cw = data.context_window || {}

  const model = (data.model && data.model.display_name) || 'Unknown'
  const cwd = (data.workspace && data.workspace.current_dir) || data.cwd || ''
  const { repo: gitRepo, branch } = gitInfo(cwd)
  const repo = gitRepo || (cwd ? path.basename(cwd) : '')

  const parts = []
  // [model] repo
  parts.push(`${cyan(`[${model}]`)} ${yellow(repo)}`)
  // (branch)
  if (branch) parts[parts.length - 1] += ` ${green(`(${branch})`)}`

  // context bar
  const ctx = contextSegment(cw)
  parts.push(ctx.color(ctx.text))

  // cache-read
  const cache = cw.current_usage && cw.current_usage.cache_read_input_tokens
  if (Number.isFinite(cache)) parts.push(magenta(`cache-read ⚡ ${fmtTokens(cache)}`))

  // +added -removed
  const added = cost.total_lines_added
  const removed = cost.total_lines_removed
  if (Number.isFinite(added) && Number.isFinite(removed)) {
    parts.push(`${green(`+${added}`)} ${red(`-${removed}`)}`)
  }

  // duration
  if (Number.isFinite(cost.total_duration_ms)) {
    parts.push(blue(`⏱ ${fmtDur(cost.total_duration_ms)}`))
  }

  // spend (always)
  const spend = Number.isFinite(cost.total_cost_usd) ? cost.total_cost_usd : 0
  parts.push(white(`$${spend.toFixed(2)}`))

  // single space joins the [model] repo (branch) prefix (already assembled);
  // a double space separates every metric segment.
  return parts.join('  ')
}

function main() {
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
    process.stdout.write(render(data) || fallbackLine(data))
  } catch {
    process.stdout.write(fallbackLine(data))
  }
}

main()
