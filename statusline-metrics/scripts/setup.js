#!/usr/bin/env node
'use strict'

/*
 * statusline-metrics: deterministic, cross-platform installer.
 *
 * Writes exactly the same canonical `statusLine` entry into settings.json on
 * every machine -- no prompts, no per-run choices, no LLM in the loop. This is
 * what makes the status line reproducible: the *renderer* (statusline.js) was
 * always deterministic; the variance came from an interactive skill choosing
 * styles/segments/scope. Running this script removes that variance.
 *
 * Usage:
 *   node scripts/setup.js [--scope=user|project] [--uninstall]
 *
 *   --scope=user      write ~/.claude/settings.json          (default)
 *   --scope=project   write <cwd>/.claude/settings.json
 *   --uninstall       remove our statusLine (restore any it replaced)
 *
 * Only the `statusLine` key is ever touched; all other settings are preserved
 * byte-for-byte. A foreign statusLine is backed up before replacement and
 * restored on uninstall.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const RENDERER = 'statusline.js'
const BACKUP_NAME = '.statusline-metrics.backup.json'

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { scope: 'user', uninstall: false }
  for (const a of argv) {
    let m
    if (a === '--uninstall' || a === '--remove' || a === '--disable') out.uninstall = true
    else if ((m = /^--scope=(user|project)$/.exec(a))) out.scope = m[1]
  }
  return out
}

// ---------------------------------------------------------------------------
// resolve the renderer path. Prefer the version-INDEPENDENT marketplace path
// so an ordinary `/plugin update` refreshes the code in place; the versioned
// cache path (…/cache/<mp>/statusline-metrics/<version>/scripts) would break on
// the next update. Fall back to this script's own absolute location.
// ---------------------------------------------------------------------------
function resolveRendererPath() {
  const local = path.join(__dirname, RENDERER)
  // …/plugins/cache/<mp>/statusline-metrics/<version>/scripts/setup.js
  const norm = __dirname.split(path.sep).join('/')
  const m = /^(.*)\/plugins\/cache\/([^/]+)\/statusline-metrics\/[^/]+\/scripts$/.exec(norm)
  if (m) {
    const stable = path.join(
      m[1].split('/').join(path.sep),
      'plugins', 'marketplaces', m[2], 'statusline-metrics', 'scripts', RENDERER,
    )
    if (fs.existsSync(stable)) return stable
  }
  return local
}

// A resolved path under …/plugins/cache/…/<version>/… is version-pinned: an
// upgrade moves it, so the status line would break until setup is re-run. We
// only land here if the version-independent marketplace path could not be
// found -- warn so the "no action needed on upgrade" promise stays honest.
function isVersionPinned(p) {
  return p.split(path.sep).join('/').includes('/plugins/cache/')
}

function settingsPath(scope) {
  const dir = scope === 'project' ? path.join(process.cwd(), '.claude') : path.join(os.homedir(), '.claude')
  return path.join(dir, 'settings.json')
}

function readJson(file) {
  if (!fs.existsSync(file)) return {}
  const raw = fs.readFileSync(file, 'utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw) // throws on malformed JSON -> we abort rather than clobber
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  fs.renameSync(tmp, file) // atomic, replaces existing on POSIX and Windows
}

function isOurs(statusLine) {
  return !!(statusLine && typeof statusLine.command === 'string' && statusLine.command.includes(RENDERER))
}

// ---------------------------------------------------------------------------
function install(scope) {
  const rp = resolveRendererPath()
  const file = settingsPath(scope)
  const backup = path.join(path.dirname(file), BACKUP_NAME)

  let settings
  try {
    settings = readJson(file)
  } catch (e) {
    console.error(`statusline-metrics: ${file} is not valid JSON; leaving it untouched.\n  ${e.message}`)
    process.exit(1)
  }

  // Back up a pre-existing foreign statusLine (once) before replacing it.
  if (settings.statusLine && !isOurs(settings.statusLine) && !fs.existsSync(backup)) {
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.writeFileSync(backup, JSON.stringify(settings.statusLine, null, 2) + '\n')
    console.error(`statusline-metrics: backed up your existing status line to ${backup}`)
  }

  settings.statusLine = {
    type: 'command',
    command: `node "${rp}"`,
    padding: 0,
  }
  writeJsonAtomic(file, settings)
  console.error(`statusline-metrics: installed into ${file}`)
  console.error(`  command: node "${rp}"`)
  console.error('  It renders on the next status-line update (a fresh prompt shows it immediately).')
  if (isVersionPinned(rp)) {
    console.error(
      '  NOTE: this points at a version-pinned install path (the version-independent\n' +
        '  marketplace path was not found). A plugin upgrade will move it -- re-run\n' +
        '  `/statusline-metrics setup` after updating to restore the status line.',
    )
  }
}

function uninstall(scope) {
  const file = settingsPath(scope)
  const backup = path.join(path.dirname(file), BACKUP_NAME)

  let settings
  try {
    settings = readJson(file)
  } catch (e) {
    console.error(`statusline-metrics: ${file} is not valid JSON; leaving it untouched.\n  ${e.message}`)
    process.exit(1)
  }

  if (!settings.statusLine) {
    console.error(`statusline-metrics: nothing to remove in ${file}`)
    return
  }
  if (!isOurs(settings.statusLine)) {
    console.error('statusline-metrics: the status line here is not ours -- left untouched.')
    return
  }

  if (fs.existsSync(backup)) {
    try {
      settings.statusLine = JSON.parse(fs.readFileSync(backup, 'utf8'))
      fs.unlinkSync(backup)
      console.error('statusline-metrics: restored your previous status line.')
    } catch {
      delete settings.statusLine
      console.error(`statusline-metrics: backup at ${backup} was unreadable; removed the status line instead.`)
    }
  } else {
    delete settings.statusLine
    console.error('statusline-metrics: removed the status line.')
  }
  writeJsonAtomic(file, settings)
}

function main() {
  const { scope, uninstall: doUninstall } = parseArgs(process.argv.slice(2))
  if (doUninstall) uninstall(scope)
  else install(scope)
}

main()
