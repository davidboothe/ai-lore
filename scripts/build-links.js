#!/usr/bin/env node
'use strict';

/*
 * build-links.js - deterministic linker for ail-document knowledge-graph docs.
 *
 * Reads the module, concept, and decision docs under a .ai-lore-docs directory, computes
 * the cross-directory dependency graph (depends_on / depended_on_by / concepts, cycles,
 * coupling), and rewrites the managed regions of the module docs plus dependencies.md
 * and index.md. Also derives decision supersession (superseded_by / status) for decision
 * nodes under decisions/. Markdown only; no JSON graph store.
 *
 * The docs are the source of truth. This script is the SOLE writer of the managed
 * module-frontmatter keys (depends_on, depended_on_by, concepts), the managed body
 * sections (## Concepts, ## Related), and the managed decision-frontmatter keys
 * (superseded_by, status). It never touches human/LLM-authored prose.
 *
 * Guard bundle (there is no CI; output is committed and auto-committed):
 *   - Surgical, managed-region-only edits (never re-serializes the whole frontmatter).
 *   - Non-managed preservation assertion (prose is byte-stable modulo blank lines).
 *   - Fail-closed validation (link integrity, exact depends_on/depended_on_by inverse).
 *   - Idempotence assertion (a second in-memory pass produces no delta).
 *   - Transactional all-or-nothing writes (compute + validate in memory, then flush).
 *
 * Usage:
 *   node build-links.js <docs_dir>                          write on delta (default)
 *   node build-links.js --check <docs_dir>                  validate only, write nothing (fail closed)
 *   node build-links.js --recall <docs_dir> <path> [<path>...]  read-only recall query (see below)
 *   node build-links.js --selftest                          run built-in fixtures, exit nonzero on mismatch
 *
 * --recall is a deterministic, source-only, read-only query: it ranks committed
 * decisions under <docs_dir>/decisions by affects_paths prefix overlap with the
 * given query paths (longest shared prefix, then newer date), prints a capped
 * JSON array to stdout, and never writes anything. It never reads the derived
 * `status` key, so it works even if the linker has never run. Mutually
 * exclusive with --check. See ADR-003 and api.md ("Recall query").
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

// Node-type-aware managed regions. Each node type owns a disjoint set of
// frontmatter keys and body headings that this script is the sole writer of.
const MANAGED_KEYS = {
  module: ['depends_on', 'depended_on_by', 'concepts', 'decisions'],
  concept: [],
  decision: ['superseded_by', 'status'],
};
const MANAGED_HEADINGS = {
  module: ['## Concepts', '## Related', '## Decisions'],
  concept: ['## Decisions'],
  decision: [],
};

// Default cap on the number of decisions injected into a module or concept
// doc's ## Decisions section (most-recent active decisions first).
const DEFAULT_DECISION_CAP = 10;

// ---------------------------------------------------------------------------
// Frontmatter + document parsing (constrained YAML subset: flat scalars, flow-
// style lists `[a, b]`, and block-style lists `key:` + `  - item` lines; no
// deeper nesting). Flow-style is the canonical WRITE form (serializeList); the
// reader also accepts block-style so a hand-authored or externally-tooled list
// links instead of silently dropping to an empty scalar.
// ---------------------------------------------------------------------------

function splitDoc(content) {
  // Normalize CRLF and stray CR line endings before splitting. This is safe:
  // output is always written with \n, and write-on-delta will rewrite the
  // file cleanly on the next run. Without this, a CRLF file's first line is
  // '---\r' (not '---'), which used to be silently treated as a
  // frontmatter-less doc.
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') return { hasFm: false, fmLines: [], bodyLines: lines };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return { hasFm: false, fmLines: [], bodyLines: lines };
  return { hasFm: true, fmLines: lines.slice(1, end), bodyLines: lines.slice(end + 1) };
}

function assembleDoc(fmLines, bodyLines) {
  return ['---'].concat(fmLines, ['---'], bodyLines).join('\n');
}

function stripQuotes(s) {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFmLine(line) {
  const m = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
  if (!m) return null;
  return { key: m[1], raw: m[2] };
}

function parseValue(raw) {
  raw = raw.trim();
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(function (s) { return stripQuotes(s.trim()); })
      .filter(function (s) { return s !== ''; });
  }
  return stripQuotes(raw);
}

// A block-sequence continuation line: leading whitespace (or none), a dash, at
// least one space, then the item. Returns the stripped item, or null if the
// line is not a block item. `-` is not a valid key char, so a block item is
// never mistaken for a `key:` line.
function parseBlockItem(line) {
  const m = line.match(/^\s*-\s+(.*)$/);
  if (!m) return null;
  return stripQuotes(m[1].trim());
}

function parseFm(fmLines) {
  const fm = {};
  for (let i = 0; i < fmLines.length; i++) {
    const p = parseFmLine(fmLines[i]);
    if (!p) continue;
    // A key with an empty inline value followed by one or more `- item` lines
    // is a block-style list; collect the items instead of leaving an empty
    // scalar (the silent-drop bug this guards against).
    if (p.raw.trim() === '') {
      const items = [];
      let j = i + 1;
      for (; j < fmLines.length; j++) {
        const item = parseBlockItem(fmLines[j]);
        if (item === null) break;
        if (item !== '') items.push(item);
      }
      if (j > i + 1) {
        fm[p.key] = items;
        i = j - 1;
        continue;
      }
    }
    fm[p.key] = parseValue(p.raw);
  }
  return fm;
}

function serializeList(arr) {
  return '[' + arr.join(', ') + ']';
}

// Surgically set a frontmatter key: replace its line in place, or append it.
// If the existing line is a hand-authored block-style list (`key:` followed
// by one or more `  - item` continuation lines), those continuation lines
// are removed along with it; otherwise they would be left behind forever as
// orphaned, no-longer-parsed lines under the freshly written flow-style key.
function setFmKey(fmLines, key, serializedValue) {
  const out = fmLines.slice();
  for (let i = 0; i < out.length; i++) {
    const p = parseFmLine(out[i]);
    if (p && p.key === key) {
      let removeEnd = i + 1;
      if (p.raw.trim() === '') {
        while (removeEnd < out.length && parseBlockItem(out[removeEnd]) !== null) removeEnd++;
      }
      out.splice(i, removeEnd - i, key + ': ' + serializedValue);
      return out;
    }
  }
  out.push(key + ': ' + serializedValue);
  return out;
}

// Strip a managed key's line (and, for a block-style value, its owned
// `  - item` continuation lines) from a frontmatter line list. Mirrors the
// removal setFmKey performs, so residual() compares apples to apples: a
// managed key's old block-style serialization must not be misread as
// unmanaged prose that "changed" when setFmKey collapses it to flow-style.
function stripManagedFmLines(fmLines, keys) {
  const out = [];
  for (let i = 0; i < fmLines.length; i++) {
    const p = parseFmLine(fmLines[i]);
    if (p && keys.indexOf(p.key) !== -1) {
      let j = i + 1;
      if (p.raw.trim() === '') {
        while (j < fmLines.length && parseBlockItem(fmLines[j]) !== null) j++;
      }
      i = j - 1;
      continue;
    }
    out.push(fmLines[i]);
  }
  return out;
}

// Replace (or append) a managed body section. sectionLines includes the heading.
function setSection(bodyLines, heading, sectionLines) {
  const out = bodyLines.slice();
  let start = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === heading) { start = i; break; }
  }
  if (start === -1) {
    // Append: ensure exactly one blank line before the new section.
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push('');
    return out.concat(sectionLines);
  }
  let end = out.length;
  for (let i = start + 1; i < out.length; i++) {
    if (/^## /.test(out[i])) { end = i; break; }
  }
  // Preserve a single trailing blank line if the following content needs separation.
  const tail = out.slice(end);
  const head = out.slice(0, start);
  const joined = head.concat(sectionLines);
  if (tail.length) joined.push('');
  return joined.concat(tail.filter(function (l, idx) { return !(idx === 0 && l.trim() === ''); }));
}

// Residual = everything EXCEPT managed keys and managed sections, blank-line
// normalized. Used to assert prose was not perturbed.
function removeSections(bodyLines, headings) {
  const out = [];
  let skipping = false;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (headings.indexOf(line) !== -1) { skipping = true; continue; }
    if (skipping && /^## /.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out;
}

function normalizeBlank(lines) {
  const collapsed = [];
  let prevBlank = false;
  lines.forEach(function (l) {
    const blank = l.trim() === '';
    if (blank && prevBlank) return;
    collapsed.push(l.replace(/\s+$/, ''));
    prevBlank = blank;
  });
  while (collapsed.length && collapsed[0].trim() === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();
  return collapsed;
}

function residual(content, nodeType) {
  const keys = MANAGED_KEYS[nodeType] || [];
  const headings = MANAGED_HEADINGS[nodeType] || [];
  const d = splitDoc(content);
  const keptFm = stripManagedFmLines(d.fmLines, keys);
  const keptBody = removeSections(d.bodyLines, headings);
  return JSON.stringify([normalizeBlank(keptFm), normalizeBlank(keptBody)]);
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

function slugify(dir) {
  const s = String(dir).replace(/[\/.]/g, '-').replace(/^-+/, '');
  return s === '' ? 'root' : s;
}

// Normalize a repo-relative path for matching: backslashes to forward
// slashes, collapse `.`/`..`/doubled-slash segments via posix.normalize
// (never OS-specific path.normalize, so this is stable cross-platform), and
// treat the resulting '.' (an all-dot input) as empty. Non-string input is
// returned unchanged so callers' own type/emptiness checks still apply.
function normalizeRepoPath(p) {
  if (typeof p !== 'string' || p === '') return p;
  const n = path.posix.normalize(p.replace(/\\/g, '/'));
  return n === '.' ? '' : n;
}

function mapPathToDir(p, dirs) {
  const norm = normalizeRepoPath(p);
  let best = null;
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    if (norm === d || norm.indexOf(d + '/') === 0) {
      if (best === null || d.length > best.length) best = d;
    }
  }
  return best;
}

function uniqSort(arr) {
  return Array.from(new Set(arr)).sort();
}

// A path is out-of-repo if it is absolute or escapes the repo root via `..`.
// affects_paths are always repo-relative; anything else is dropped, not an
// error (fail-closed, no partial trust of a malformed path).
function isOutOfRepo(p) {
  if (typeof p !== 'string' || p === '') return true;
  if (path.isAbsolute(p)) return true;
  const normalized = path.normalize(p);
  if (normalized === '..' || normalized.indexOf('..' + path.sep) === 0 || normalized === '.') return true;
  return false;
}

// --recall CLI convenience: convert an absolute query path that falls under
// repoRoot into a repo-relative one, so a caller passing an absolute path
// (as most editors/tools do) still scores correctly instead of being
// silently treated as out-of-repo. An absolute path that does NOT fall
// under repoRoot, or a relative path, is returned unchanged (isOutOfRepo
// still applies its own judgment afterward).
function resolveRecallQueryPath(p, repoRoot) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return p;
  const rel = path.relative(repoRoot, p);
  if (rel === '' || rel === '..' || rel.indexOf('..' + path.sep) === 0 || path.isAbsolute(rel)) return p;
  return normalizeRepoPath(rel);
}

// ---------------------------------------------------------------------------
// Recall (--recall): deterministic, source-only, read-only. See ADR-003.
// ---------------------------------------------------------------------------

function pathSegments(p) {
  return String(p).split('/').filter(Boolean);
}

// Longest shared leading-segment prefix between two repo-relative paths
// (segment-exact, so "src/ap" never matches "src/api"). Direction-agnostic:
// works whether the decision's affects_path or the query path is the deeper
// one. Returns null when no leading segment matches.
function sharedPrefix(a, b) {
  const segA = pathSegments(a);
  const segB = pathSegments(b);
  const n = Math.min(segA.length, segB.length);
  let i = 0;
  while (i < n && segA[i] === segB[i]) i++;
  if (i === 0) return null;
  return { length: i, path: segA.slice(0, i).join('/') };
}

const DEFAULT_RECALL_CAP = 5;

// Shell metacharacters and null bytes are rejected fail-closed. --recall
// paths are always passed as an argv array to a non-shell spawn, never
// interpolated into a shell string; this is defense in depth for callers.
const SHELL_METACHAR_RE = /[;&|`$(){}<>*?~!\n\r"'\\]/;
function hasDangerousPathArg(p) {
  if (typeof p !== 'string' || p === '') return true;
  if (p.indexOf('\0') !== -1) return true;
  return SHELL_METACHAR_RE.test(p);
}

// Rank committed decisions under <docsDir>/decisions by affects_paths prefix
// overlap with the query paths: (1) longest shared prefix, (2) newer date.
// Source-only (reuses readDocSet's raw frontmatter; never touches derived
// `status`), read-only, deterministic. Returns [] if the decisions dir is
// absent or nothing matches.
function recall(docsDir, paths, cap) {
  cap = cap || DEFAULT_RECALL_CAP;
  const absDir = path.resolve(docsDir);
  const decisionsDir = path.join(absDir, 'decisions');
  if (!fs.existsSync(decisionsDir)) return [];

  const docSet = readDocSet(absDir);
  const candidates = [];
  docSet.decisions.forEach(function (d) {
    const affects = Array.isArray(d.fm.affects_paths) ? d.fm.affects_paths : [];
    let best = null;
    affects.forEach(function (ap) {
      if (isOutOfRepo(ap)) return;
      const normAp = normalizeRepoPath(ap);
      paths.forEach(function (qp) {
        const sp = sharedPrefix(normAp, normalizeRepoPath(qp));
        if (sp && (!best || sp.length > best.length)) best = sp;
      });
    });
    if (best) {
      candidates.push({
        id: d.fm.id,
        title: d.fm.title,
        date: d.fm.date,
        stage: d.fm.stage,
        affects_paths: affects,
        overlap_path: best.path,
        _rank: best.length,
      });
    }
  });

  candidates.sort(function (a, b) {
    if (b._rank !== a._rank) return b._rank - a._rank;
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id.localeCompare(b.id);
  });

  return candidates.slice(0, cap).map(function (c) {
    return {
      id: c.id, title: c.title, date: c.date, stage: c.stage,
      affects_paths: c.affects_paths, overlap_path: c.overlap_path,
    };
  });
}

// Dedupe an array preserving first-seen order (unlike uniqSort, which
// alphabetizes; here recency/status ordering must survive the dedupe).
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  arr.forEach(function (x) { if (!seen.has(x)) { seen.add(x); out.push(x); } });
  return out;
}

// Order decision ids: accepted (active) decisions before superseded ones,
// then newest date first within each group, then id ascending as a
// deterministic tie-break.
function orderDecisionIds(ids, decisionById) {
  return ids.slice().sort(function (a, b) {
    const da = decisionById[a];
    const db = decisionById[b];
    const sa = (da && da.status === 'accepted') ? 0 : 1;
    const sb = (db && db.status === 'accepted') ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const dateA = da ? da.date : '';
    const dateB = db ? db.date : '';
    if (dateA !== dateB) return dateA < dateB ? 1 : -1;
    return a.localeCompare(b);
  });
}

// Dedupe, order, and cap a list of decision ids at N; report whether the
// cap truncated the list so the renderer can add a "see decisions.md" note.
function capDecisions(ids, decisionById, cap) {
  const ordered = orderDecisionIds(dedupe(ids), decisionById);
  return { ids: ordered.slice(0, cap), truncated: ordered.length > cap };
}

// Render a managed "## Decisions" section from a capped/ordered id list.
function renderDecisionsSection(capped, decisionById, linkPrefix, aggregateLink) {
  const lines = ['## Decisions'];
  if (!capped.ids.length) {
    lines.push('none');
    return lines;
  }
  capped.ids.forEach(function (id) {
    const dec = decisionById[id] || {};
    lines.push('- [' + id + '](' + linkPrefix + id + '.md): ' + (dec.title || id) + ' (' + (dec.stage || '') + ')');
  });
  if (capped.truncated) {
    lines.push('See [decisions.md](' + aggregateLink + ') for the full history.');
  }
  return lines;
}

// Tarjan SCC; returns components with size > 1 (or self-loops) as cycles.
function findCycles(nodes, edges) {
  let index = 0;
  const stack = [];
  // Object.create(null): node ids (dirs, decision ids) are arbitrary strings
  // and must not collide with inherited Object.prototype keys like
  // "constructor" (e.g. idx['constructor'] would be truthy before the node
  // is ever visited, silently excluding it from cycle detection).
  const onStack = Object.create(null);
  const idx = Object.create(null);
  const low = Object.create(null);
  const cycles = [];
  function strongconnect(v) {
    idx[v] = index; low[v] = index; index++;
    stack.push(v); onStack[v] = true;
    (edges[v] || []).forEach(function (w) {
      if (idx[w] === undefined) { strongconnect(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStack[w]) { low[v] = Math.min(low[v], idx[w]); }
    });
    if (low[v] === idx[v]) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack[w] = false; comp.push(w); } while (w !== v);
      const isSelfLoop = comp.length === 1 && (edges[comp[0]] || []).indexOf(comp[0]) !== -1;
      if (comp.length > 1 || isSelfLoop) cycles.push(comp.sort());
    }
  }
  nodes.forEach(function (v) { if (idx[v] === undefined) strongconnect(v); });
  return cycles.sort(function (a, b) { return a.join().localeCompare(b.join()); });
}

// ---------------------------------------------------------------------------
// Core: read docs -> compute graph -> render managed regions (in memory)
// ---------------------------------------------------------------------------

function readDocSet(docsDir) {
  const modulesDir = path.join(docsDir, 'modules');
  const conceptsDir = path.join(docsDir, 'concepts');
  const decisionsDir = path.join(docsDir, 'decisions');
  const modules = [];
  const concepts = [];
  const decisions = [];

  if (fs.existsSync(modulesDir)) {
    fs.readdirSync(modulesDir).filter(function (f) { return /\.md$/.test(f); }).sort()
      .forEach(function (f) {
        const content = fs.readFileSync(path.join(modulesDir, f), 'utf8');
        const d = splitDoc(content);
        const fm = parseFm(d.fmLines);
        modules.push({ file: 'modules/' + f, slug: f.replace(/\.md$/, ''), content: content, fm: fm, hasFm: d.hasFm });
      });
  }
  if (fs.existsSync(conceptsDir)) {
    fs.readdirSync(conceptsDir).filter(function (f) { return /\.md$/.test(f); }).sort()
      .forEach(function (f) {
        const content = fs.readFileSync(path.join(conceptsDir, f), 'utf8');
        const d = splitDoc(content);
        const fm = parseFm(d.fmLines);
        concepts.push({ file: 'concepts/' + f, slug: f.replace(/\.md$/, ''), content: content, fm: fm, hasFm: d.hasFm });
      });
  }
  if (fs.existsSync(decisionsDir)) {
    fs.readdirSync(decisionsDir).filter(function (f) { return /\.md$/.test(f); }).sort()
      .forEach(function (f) {
        const content = fs.readFileSync(path.join(decisionsDir, f), 'utf8');
        const d = splitDoc(content);
        const fm = parseFm(d.fmLines);
        decisions.push({ file: 'decisions/' + f, slug: f.replace(/\.md$/, ''), content: content, fm: fm, hasFm: d.hasFm });
      });
  }
  return { modules: modules, concepts: concepts, decisions: decisions };
}

// Derive decision-to-decision managed state: superseded_by is the inverse of
// each decision's source `supersedes` list; status is fully derived from it.
// A `supersedes` target that does not resolve to a known decision id is
// reported in danglingRefs so the caller can fail closed. Self-supersession
// and multi-node supersession cycles are reported in `cycles` for the same
// reason: left unchecked, every decision in a cycle ends up "superseded"
// with no accepted decision surviving, and nothing signals the contradiction.
//
// All lookup structures here are Object.create(null): decision ids are
// arbitrary author-supplied strings and must not collide with inherited
// Object.prototype keys like "constructor" (e.g. byId['constructor'] would
// be truthy before any decision with that id was ever added, silently
// treating a dangling supersedes target named "constructor" as resolved).
function computeDecisionModel(decisionRecords) {
  const byId = Object.create(null);
  decisionRecords.forEach(function (d) { byId[d.fm.id] = d; });

  const supersededBy = Object.create(null);
  const supersedesGraph = Object.create(null);
  decisionRecords.forEach(function (d) { supersededBy[d.fm.id] = []; supersedesGraph[d.fm.id] = []; });

  const danglingRefs = [];
  decisionRecords.forEach(function (d) {
    const sup = Array.isArray(d.fm.supersedes) ? d.fm.supersedes : [];
    sup.forEach(function (target) {
      if (!byId[target]) { danglingRefs.push({ from: d.fm.id, to: target }); return; }
      supersededBy[target].push(d.fm.id);
      supersedesGraph[d.fm.id].push(target);
    });
  });
  Object.keys(supersededBy).forEach(function (id) { supersededBy[id] = uniqSort(supersededBy[id]); });

  const status = Object.create(null);
  decisionRecords.forEach(function (d) {
    status[d.fm.id] = supersededBy[d.fm.id].length ? 'superseded' : 'accepted';
  });

  const cycles = findCycles(Object.keys(supersedesGraph), supersedesGraph);

  return { supersededBy: supersededBy, status: status, danglingRefs: danglingRefs, cycles: cycles };
}

// Surgically write the derived managed keys onto a decision record's frontmatter.
// Source keys and the MADR body are preserved byte-for-byte.
function renderDecisionManaged(record, decisionModel) {
  const id = record.fm.id;
  const supersededBy = decisionModel.supersededBy[id] || [];
  const status = decisionModel.status[id] || 'accepted';

  const d = splitDoc(record.content);
  let fmLines = d.fmLines;
  const values = { superseded_by: serializeList(supersededBy), status: status };
  MANAGED_KEYS.decision.forEach(function (k) { fmLines = setFmKey(fmLines, k, values[k]); });

  return assembleDoc(fmLines, d.bodyLines);
}

// Build the in-memory graph model from a set of {file, slug, content, fm} module
// records and {slug, fm} concept records. Pure; used for both the disk pass and
// the idempotence re-pass.
function computeModel(moduleRecords, conceptRecords, decisionRecords, decisionModel) {
  decisionRecords = decisionRecords || [];
  decisionModel = decisionModel || { status: {} };

  const dirs = moduleRecords.map(function (m) { return String(m.fm.directory || ''); });
  const dirSet = dirs.filter(Boolean);
  const bySlugDir = {};
  moduleRecords.forEach(function (m) { bySlugDir[m.fm.directory] = m.slug; });

  // concepts per module directory, from concept implemented_by
  const conceptsByDir = {};
  conceptRecords.forEach(function (c) {
    const impl = Array.isArray(c.fm.implemented_by) ? c.fm.implemented_by : [];
    impl.forEach(function (dir) {
      (conceptsByDir[dir] = conceptsByDir[dir] || []).push(c.slug);
    });
  });

  const dependsOn = {};
  moduleRecords.forEach(function (m) {
    const dir = m.fm.directory;
    const resolved = Array.isArray(m.fm.resolved_dependencies) ? m.fm.resolved_dependencies : [];
    const deps = [];
    resolved.forEach(function (p) {
      const target = mapPathToDir(p, dirSet);
      if (target && target !== dir) deps.push(target);
    });
    dependsOn[dir] = uniqSort(deps);
  });

  const dependedOnBy = {};
  dirSet.forEach(function (d) { dependedOnBy[d] = []; });
  dirSet.forEach(function (from) {
    dependsOn[from].forEach(function (to) {
      if (dependedOnBy[to]) dependedOnBy[to].push(from);
    });
  });
  Object.keys(dependedOnBy).forEach(function (d) { dependedOnBy[d] = uniqSort(dependedOnBy[d]); });

  // Decisions: resolve each decision's affects_paths to a documented module
  // directory (longest-match, clamped to repo root, out-of-repo/undocumented
  // dropped fail-closed), then cap/order per module and, via implemented_by,
  // as a deduplicated capped union per concept.
  const decisionById = Object.create(null);
  decisionRecords.forEach(function (d) {
    decisionById[d.fm.id] = {
      id: d.fm.id,
      title: d.fm.title,
      date: d.fm.date,
      stage: d.fm.stage,
      affects_paths: Array.isArray(d.fm.affects_paths) ? d.fm.affects_paths : [],
      status: decisionModel.status[d.fm.id] || 'accepted',
    };
  });

  const decisionsByDirAll = {};
  dirSet.forEach(function (d) { decisionsByDirAll[d] = []; });
  decisionRecords.forEach(function (d) {
    const paths = Array.isArray(d.fm.affects_paths) ? d.fm.affects_paths : [];
    const resolvedDirs = {};
    paths.forEach(function (p) {
      if (isOutOfRepo(p)) return;
      const dir = mapPathToDir(p, dirSet);
      if (dir) resolvedDirs[dir] = true;
    });
    Object.keys(resolvedDirs).forEach(function (dir) { decisionsByDirAll[dir].push(d.fm.id); });
  });

  const decisionsByDir = {};
  dirSet.forEach(function (dir) {
    decisionsByDir[dir] = capDecisions(decisionsByDirAll[dir], decisionById, DEFAULT_DECISION_CAP);
  });

  const decisionsByConcept = {};
  conceptRecords.forEach(function (c) {
    const impl = Array.isArray(c.fm.implemented_by) ? c.fm.implemented_by : [];
    let union = [];
    impl.forEach(function (dir) {
      const capped = decisionsByDir[dir];
      if (capped) union = union.concat(capped.ids);
    });
    decisionsByConcept[c.slug] = capDecisions(union, decisionById, DEFAULT_DECISION_CAP);
  });

  return {
    dirs: dirSet.slice().sort(),
    slugForDir: bySlugDir,
    dependsOn: dependsOn,
    dependedOnBy: dependedOnBy,
    conceptsByDir: conceptsByDir,
    dependsGraph: dependsOn,
    decisionById: decisionById,
    decisionsByDir: decisionsByDir,
    decisionsByConcept: decisionsByConcept,
  };
}

function renderModuleManaged(record, model) {
  const dir = record.fm.directory;
  const deps = model.dependsOn[dir] || [];
  const rdeps = model.dependedOnBy[dir] || [];
  const cons = uniqSort(model.conceptsByDir[dir] || []);
  const decInfo = model.decisionsByDir[dir] || { ids: [], truncated: false };

  const d = splitDoc(record.content);
  let fmLines = d.fmLines;
  const values = {
    depends_on: serializeList(deps),
    depended_on_by: serializeList(rdeps),
    concepts: serializeList(cons),
    decisions: serializeList(decInfo.ids),
  };
  MANAGED_KEYS.module.forEach(function (k) { fmLines = setFmKey(fmLines, k, values[k]); });

  let bodyLines = d.bodyLines;

  // ## Concepts section
  const conceptSection = ['## Concepts'];
  if (cons.length) {
    cons.forEach(function (slug) { conceptSection.push('- [' + slug + '](../concepts/' + slug + '.md)'); });
  } else {
    conceptSection.push('none');
  }
  bodyLines = setSection(bodyLines, '## Concepts', conceptSection);

  // ## Related section
  function linkList(list) {
    if (!list.length) return 'none';
    return list.map(function (targetDir) {
      const slug = model.slugForDir[targetDir] || slugify(targetDir);
      return '[' + targetDir + '](./' + slug + '.md)';
    }).join(', ');
  }
  const relatedSection = [
    '## Related',
    'Depends on: ' + linkList(deps),
    'Depended on by: ' + linkList(rdeps),
  ];
  bodyLines = setSection(bodyLines, '## Related', relatedSection);

  // ## Decisions section: capped, active-first, "see decisions.md" on truncation.
  const decisionsSection = renderDecisionsSection(decInfo, model.decisionById, '../decisions/', '../decisions.md');
  bodyLines = setSection(bodyLines, '## Decisions', decisionsSection);

  return assembleDoc(fmLines, bodyLines);
}

// Concept docs manage no frontmatter keys, only a render-time ## Decisions
// section: the deduplicated, capped union of member modules' decision lists.
function renderConceptManaged(record, model) {
  const decInfo = model.decisionsByConcept[record.slug] || { ids: [], truncated: false };
  const d = splitDoc(record.content);
  let bodyLines = d.bodyLines;
  const decisionsSection = renderDecisionsSection(decInfo, model.decisionById, '../decisions/', '../decisions.md');
  bodyLines = setSection(bodyLines, '## Decisions', decisionsSection);
  return assembleDoc(d.fmLines, bodyLines);
}

// Render an aggregate doc (dependencies.md, decisions.md, index.md) whose
// only churn-prone field is last_run. Reusing the previous file's last_run
// forever (the old behavior) keeps the field from causing date-only churn,
// but freezes it at first-render forever, even once the content it
// describes has genuinely changed. Instead: render first with the PREVIOUS
// last_run; if that reproduces the file on disk byte-for-byte, nothing
// changed, so keep it (no churn). If it does not, something else changed,
// so re-render with today()'s date. Within a single run this is called at
// most once per aggregate, so it is trivially stable for the idempotence
// assertion in validate() (same-run renders always use the same date).
function renderWithLastRun(prevContent, renderFn) {
  const prevLastRun = fmField(prevContent, 'last_run', today());
  const withPrevDate = renderFn(prevLastRun);
  if (withPrevDate === prevContent) return withPrevDate;
  if (prevLastRun === today()) return withPrevDate;
  return renderFn(today());
}

function renderDependencies(model, prevContent) {
  return renderWithLastRun(prevContent, function (lastRun) {
    const fm = [
      '---',
      'last_run: ' + lastRun,
      'type: dependencies',
      '---',
      '',
    ];
    const lines = ['# Dependency Map', '', '## Module Dependencies', '', '| Module | Depends On |', '|---|---|'];
    model.dirs.forEach(function (dir) {
      const deps = model.dependsOn[dir] || [];
      const slug = model.slugForDir[dir] || slugify(dir);
      const depCell = deps.length ? deps.join(', ') : 'none';
      lines.push('| [' + dir + '](modules/' + slug + '.md) | ' + depCell + ' |');
    });
    lines.push('', '## Dependency Graph', '');
    model.dirs.forEach(function (dir) {
      const deps = model.dependsOn[dir] || [];
      if (deps.length) lines.push(dir + ' -> ' + deps.join(', '));
    });
    if (!model.dirs.some(function (d) { return (model.dependsOn[d] || []).length; })) {
      lines.push('(no internal dependencies)');
    }
    lines.push('', '## Circular Dependencies', '');
    const cycles = findCycles(model.dirs, model.dependsGraph);
    if (cycles.length) {
      cycles.forEach(function (c) { lines.push('- ' + c.join(' -> ') + ' -> ' + c[0]); });
    } else {
      lines.push('None detected.');
    }
    lines.push('', '## High-Coupling Modules', '');
    const ranked = model.dirs.slice().sort(function (a, b) {
      return (model.dependedOnBy[b] || []).length - (model.dependedOnBy[a] || []).length;
    }).filter(function (d) { return (model.dependedOnBy[d] || []).length > 0; });
    if (ranked.length) {
      ranked.slice(0, 10).forEach(function (d) {
        lines.push('- ' + d + ' (' + (model.dependedOnBy[d] || []).length + ' dependents)');
      });
    } else {
      lines.push('None.');
    }
    return fm.join('\n') + lines.join('\n') + '\n';
  });
}

// Global aggregate decision log, rendered the same way renderDependencies
// renders dependencies.md: chronological within each status group, newest
// first, with a link and the originating stage.
function renderDecisions(decisionRecords, decisionModel, prevContent) {
  return renderWithLastRun(prevContent, function (lastRun) {
    const fm = [
      '---',
      'last_run: ' + lastRun,
      'type: decisions',
      '---',
      '',
    ];
    const lines = ['# Decision Log', ''];
    function byDateDesc(list) {
      return list.slice().sort(function (a, b) {
        if (a.fm.date !== b.fm.date) return a.fm.date < b.fm.date ? 1 : -1;
        return a.fm.id.localeCompare(b.fm.id);
      });
    }
    [{ title: 'Accepted', status: 'accepted' }, { title: 'Superseded', status: 'superseded' }].forEach(function (g) {
      const list = byDateDesc(decisionRecords.filter(function (d) {
        return (decisionModel.status[d.fm.id] || 'accepted') === g.status;
      }));
      lines.push('## ' + g.title, '');
      if (list.length) {
        lines.push('| Decision | Date | Stage |', '|---|---|---|');
        list.forEach(function (d) {
          lines.push('| [' + d.fm.id + '](decisions/' + d.fm.id + '.md) | ' + d.fm.date + ' | ' + d.fm.stage + ' |');
        });
      } else {
        lines.push('None.');
      }
      lines.push('');
    });
    if (!decisionRecords.length) lines.push('No decisions recorded.', '');
    return fm.join('\n') + lines.join('\n').replace(/\n+$/, '\n');
  });
}

function renderIndex(model, conceptRecords, decisionRecords, decisionModel, prevContent) {
  return renderWithLastRun(prevContent, function (lastRun) {
    const fm = [
      '---',
      'last_run: ' + lastRun,
      'type: index',
      '---',
      '',
    ];
    const lines = [
      '# Documentation Index',
      '',
      'Interlinked docs for AI agents: start at a concept, or find the doc that owns a path below.',
      '',
      '## Concepts',
      '',
    ];
    conceptRecords.slice().sort(function (a, b) { return a.slug.localeCompare(b.slug); }).forEach(function (c) {
      const impl = Array.isArray(c.fm.implemented_by) ? c.fm.implemented_by : [];
      lines.push('- [' + c.slug + '](concepts/' + c.slug + '.md): ' + (impl.length ? impl.join(', ') : 'none'));
    });
    lines.push('', '## Directory to doc', '', '| Directory | Module | Concepts |', '|---|---|---|');
    model.dirs.forEach(function (dir) {
      const slug = model.slugForDir[dir] || slugify(dir);
      const cons = uniqSort(model.conceptsByDir[dir] || []);
      lines.push('| ' + dir + ' | [' + slug + '](modules/' + slug + '.md) | ' + (cons.length ? cons.join(', ') : 'none') + ' |');
    });
    lines.push('', '## Decisions', '');
    if (decisionRecords.length) {
      lines.push('| Decision | Status | Stage |', '|---|---|---|');
      decisionRecords.slice().sort(function (a, b) { return a.fm.id.localeCompare(b.fm.id); }).forEach(function (d) {
        lines.push('| [' + d.fm.id + '](decisions/' + d.fm.id + '.md) | ' + (decisionModel.status[d.fm.id] || 'accepted') + ' | ' + d.fm.stage + ' |');
      });
      lines.push('', 'See [decisions.md](decisions.md) for the full log.');
    } else {
      lines.push('none');
    }
    return fm.join('\n') + lines.join('\n') + '\n';
  });
}

function fmField(content, key, fallback) {
  if (!content) return fallback;
  const fm = parseFm(splitDoc(content).fmLines);
  return fm[key] !== undefined ? fm[key] : fallback;
}

function today() {
  // Deterministic within a run; date is informational only.
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Remove fenced code blocks (``` ... ```) so the link-integrity scan does
// not treat a literal example link inside a fence as a real link that must
// resolve to a known file. Used read-only, for scanning purposes only; it
// never touches the actual doc content that gets written.
function stripFencedCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

// Produce the full map of {relativePath: newContent} for all managed outputs.
function computeOutputs(docsDir, docSet) {
  const decisionModel = computeDecisionModel(docSet.decisions);
  const model = computeModel(docSet.modules, docSet.concepts, docSet.decisions, decisionModel);
  const outputs = {};
  docSet.modules.forEach(function (m) {
    outputs[m.file] = renderModuleManaged(m, model);
  });
  docSet.concepts.forEach(function (c) {
    outputs[c.file] = renderConceptManaged(c, model);
  });
  docSet.decisions.forEach(function (d) {
    outputs[d.file] = renderDecisionManaged(d, decisionModel);
  });
  const depsPath = path.join(docsDir, 'dependencies.md');
  const idxPath = path.join(docsDir, 'index.md');
  const decsAggPath = path.join(docsDir, 'decisions.md');
  outputs['dependencies.md'] = renderDependencies(model, fs.existsSync(depsPath) ? fs.readFileSync(depsPath, 'utf8') : '');
  outputs['decisions.md'] = renderDecisions(docSet.decisions, decisionModel, fs.existsSync(decsAggPath) ? fs.readFileSync(decsAggPath, 'utf8') : '');
  outputs['index.md'] = renderIndex(model, docSet.concepts, docSet.decisions, decisionModel, fs.existsSync(idxPath) ? fs.readFileSync(idxPath, 'utf8') : '');
  return { outputs: outputs, model: model, decisionModel: decisionModel };
}

// ---------------------------------------------------------------------------
// Validation (fail closed)
// ---------------------------------------------------------------------------

function validate(docsDir, docSet, computed) {
  const errors = [];
  const outputs = computed.outputs;
  const model = computed.model;
  const decisionModel = computed.decisionModel;

  // 1. Non-managed preservation: module prose unchanged.
  docSet.modules.forEach(function (m) {
    if (residual(m.content, 'module') !== residual(outputs[m.file], 'module')) {
      errors.push('preservation: non-managed content changed in ' + m.file);
    }
  });

  // 1a. Non-managed preservation: concept prose unchanged.
  docSet.concepts.forEach(function (c) {
    if (residual(c.content, 'concept') !== residual(outputs[c.file], 'concept')) {
      errors.push('preservation: non-managed content changed in ' + c.file);
    }
  });

  // 1b. Non-managed preservation: decision source region unchanged.
  docSet.decisions.forEach(function (d) {
    if (residual(d.content, 'decision') !== residual(outputs[d.file], 'decision')) {
      errors.push('preservation: non-managed content changed in ' + d.file);
    }
  });

  // 1c. Decision supersedes targets must resolve to a known decision id.
  decisionModel.danglingRefs.forEach(function (ref) {
    errors.push('supersedes: ' + ref.from + ' supersedes unknown decision ' + ref.to);
  });

  // 1d. Self-supersession and supersedes cycles fail closed: unchecked, every
  // decision in the cycle would render as "superseded" with none accepted.
  (decisionModel.cycles || []).forEach(function (c) {
    if (c.length === 1) {
      errors.push('supersedes: ' + c[0] + ' supersedes itself (self-supersession)');
    } else {
      errors.push('supersedes: cycle detected among decisions: ' + c.concat([c[0]]).join(' -> '));
    }
  });

  // 2. Exact depends_on / depended_on_by inverse.
  model.dirs.forEach(function (a) {
    (model.dependsOn[a] || []).forEach(function (b) {
      if ((model.dependedOnBy[b] || []).indexOf(a) === -1) {
        errors.push('inverse: ' + a + ' depends_on ' + b + ' but missing back-edge');
      }
    });
    (model.dependedOnBy[a] || []).forEach(function (b) {
      if ((model.dependsOn[b] || []).indexOf(a) === -1) {
        errors.push('inverse: ' + a + ' depended_on_by ' + b + ' but no forward edge');
      }
    });
  });

  // 3. Link integrity: every managed link target resolves to a real file.
  const known = {};
  docSet.modules.forEach(function (m) { known[m.file] = true; });
  docSet.concepts.forEach(function (c) { known[c.file] = true; });
  docSet.decisions.forEach(function (d) { known[d.file] = true; });
  const linkRe = /\]\((\.\.\/concepts\/[^)]+|\.\.\/decisions\/[^)]+|\.\/[^)]+|modules\/[^)]+|concepts\/[^)]+|decisions\/[^)]+)\)/g;
  Object.keys(outputs).forEach(function (rel) {
    const dir = path.dirname(rel); // 'modules', 'concepts', or '.'
    // Strip fenced code blocks before scanning: a literal example link inside
    // a ``` fence is prose/documentation, not a real managed link that must
    // resolve to a known file. Prose outside fences is scanned as before.
    const text = stripFencedCodeBlocks(outputs[rel]);
    let mm;
    while ((mm = linkRe.exec(text)) !== null) {
      let target = mm[1];
      const resolved = path.normalize(path.join(dir === '.' ? '' : dir, target));
      if (!known[resolved]) errors.push('dangling link in ' + rel + ': ' + target);
    }
  });

  // 4. Idempotence: re-parse outputs as input and recompute; expect no delta.
  // Decisions are recomputed first since module/concept decision ordering
  // depends on derived decision status.
  const rebuiltDecisions = docSet.decisions.map(function (d) {
    const c = outputs[d.file];
    return { file: d.file, slug: d.slug, content: c, fm: parseFm(splitDoc(c).fmLines) };
  });
  const decisionModel2 = computeDecisionModel(rebuiltDecisions);
  const outputs2Decisions = {};
  rebuiltDecisions.forEach(function (d) { outputs2Decisions[d.file] = renderDecisionManaged(d, decisionModel2); });
  rebuiltDecisions.forEach(function (d) {
    if (outputs2Decisions[d.file] !== outputs[d.file]) errors.push('idempotence: second pass differs for ' + d.file);
  });

  const rebuiltModules = docSet.modules.map(function (m) {
    const c = outputs[m.file];
    return { file: m.file, slug: m.slug, content: c, fm: parseFm(splitDoc(c).fmLines) };
  });
  const rebuiltConcepts = docSet.concepts.map(function (c) {
    const content = outputs[c.file];
    return { file: c.file, slug: c.slug, content: content, fm: parseFm(splitDoc(content).fmLines) };
  });
  const model2 = computeModel(rebuiltModules, rebuiltConcepts, rebuiltDecisions, decisionModel2);
  const outputs2 = {};
  rebuiltModules.forEach(function (m) { outputs2[m.file] = renderModuleManaged(m, model2); });
  rebuiltModules.forEach(function (m) {
    if (outputs2[m.file] !== outputs[m.file]) errors.push('idempotence: second pass differs for ' + m.file);
  });
  rebuiltConcepts.forEach(function (c) { outputs2[c.file] = renderConceptManaged(c, model2); });
  rebuiltConcepts.forEach(function (c) {
    if (outputs2[c.file] !== outputs[c.file]) errors.push('idempotence: second pass differs for ' + c.file);
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Schema validation (fail closed; runs before any graph computation, since
// computeOutputs assumes every record has a parseable, well-formed frontmatter
// block)
// ---------------------------------------------------------------------------

// Fail-closed frontmatter checks that must hold before the graph is computed
// at all: a doc under modules/, concepts/, or decisions/ with no parseable
// frontmatter block would otherwise get one silently prepended by
// assembleDoc, demoting the original frontmatter to body content. Also
// enforces the minimal per-node-type schema: every module needs a
// `directory` key (and directories must be unique across modules); every
// decision needs a non-empty id/title/date/stage, and its id must match its
// filename.
function validateSchema(docSet) {
  const errors = [];

  docSet.modules.forEach(function (m) {
    if (!m.hasFm) { errors.push('schema: no parseable frontmatter block found in ' + m.file); return; }
    if (!m.fm.directory) errors.push('schema: missing directory key in ' + m.file);
  });

  docSet.concepts.forEach(function (c) {
    if (!c.hasFm) errors.push('schema: no parseable frontmatter block found in ' + c.file);
  });

  docSet.decisions.forEach(function (d) {
    if (!d.hasFm) { errors.push('schema: no parseable frontmatter block found in ' + d.file); return; }
    ['id', 'title', 'date', 'stage'].forEach(function (k) {
      const v = d.fm[k];
      if (!v || (typeof v === 'string' && v.trim() === '')) errors.push('schema: missing ' + k + ' in ' + d.file);
    });
    if (d.fm.id && d.fm.id !== d.slug) {
      errors.push('schema: decision id "' + d.fm.id + '" does not match filename in ' + d.file + ' (expected "' + d.slug + '")');
    }
  });

  const dirSeen = Object.create(null);
  docSet.modules.forEach(function (m) {
    if (!m.hasFm || !m.fm.directory) return;
    const dir = m.fm.directory;
    if (dirSeen[dir]) errors.push('schema: duplicate directory "' + dir + '" claimed by both ' + dirSeen[dir] + ' and ' + m.file);
    else dirSeen[dir] = m.file;
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function run(docsDir, opts) {
  opts = opts || {};
  const absDir = path.resolve(docsDir);
  const hasModules = fs.existsSync(path.join(absDir, 'modules'));
  const hasDecisions = fs.existsSync(path.join(absDir, 'decisions'));
  if (!hasModules && !hasDecisions) {
    return { ok: false, errors: ['no modules/ or decisions/ directory under ' + absDir], written: [] };
  }
  const docSet = readDocSet(absDir);
  const schemaErrors = validateSchema(docSet);
  if (schemaErrors.length) return { ok: false, errors: schemaErrors, written: [] };

  const computed = computeOutputs(absDir, docSet);
  const errors = validate(absDir, docSet, computed);
  if (errors.length) return { ok: false, errors: errors, written: [] };

  if (opts.check) return { ok: true, errors: [], written: [], pending: pendingChanges(absDir, computed.outputs) };

  // Transactional per file: write to a sibling temp file, then rename over
  // the target. A rename is atomic on the same filesystem, so a crash or
  // interrupt mid-flush never leaves a target file partially written.
  const written = [];
  Object.keys(computed.outputs).forEach(function (rel) {
    const abs = path.join(absDir, rel);
    const next = computed.outputs[rel];
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (prev !== next) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmpPath = abs + '.tmp-buildlinks';
      fs.writeFileSync(tmpPath, next, 'utf8');
      fs.renameSync(tmpPath, abs);
      written.push(rel);
    }
  });
  return { ok: true, errors: [], written: written };
}

function pendingChanges(absDir, outputs) {
  const pending = [];
  Object.keys(outputs).forEach(function (rel) {
    const abs = path.join(absDir, rel);
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (prev !== outputs[rel]) pending.push(rel);
  });
  return pending;
}

// ---------------------------------------------------------------------------
// Self-test (hermetic fixtures; no CI, so this gates releases by hand)
// ---------------------------------------------------------------------------

function decisionFixture(id, title, supersedes, affectsPaths, date) {
  affectsPaths = affectsPaths || ['src/api'];
  date = date || '2026-06-01';
  return '---\nid: ' + id + '\ntitle: ' + title + '\ndate: ' + date + '\nstage: architect\n' +
    'affects_paths: [' + affectsPaths.join(', ') + ']\nsupersedes: [' + supersedes.join(', ') + ']\n---\n\n' +
    '# ' + title + '\n\n## Context\n\nTest context.\n\n## Decision\n\nTest decision.\n\n## Consequences\n\nTest consequences.\n';
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-'));
  const mods = path.join(tmp, 'modules');
  const cons = path.join(tmp, 'concepts');
  const decs = path.join(tmp, 'decisions');
  fs.mkdirSync(mods, { recursive: true });
  fs.mkdirSync(cons, { recursive: true });
  fs.mkdirSync(decs, { recursive: true });

  fs.writeFileSync(path.join(mods, 'src-api.md'),
    '---\ndirectory: src/api\nlast_commit: abc\nresolved_dependencies: [src/models]\nexternal_dependencies: [zod]\n---\n\n# src/api\n\nAPI layer.\n\n## Files\n### `users.ts`\nHandles users.\n', 'utf8');
  fs.writeFileSync(path.join(mods, 'src-models.md'),
    '---\ndirectory: src/models\nlast_commit: abc\nresolved_dependencies: []\nexternal_dependencies: []\n---\n\n# src/models\n\nData models.\n', 'utf8');
  fs.writeFileSync(path.join(cons, 'auth.md'),
    '---\nconcept: auth\nimplemented_by: [src/api]\n---\n\n# auth\n\nAuth concern.\n', 'utf8');

  // Decision fixtures: a supersession pair (001 <- 002) and two decisions
  // superseding one ancestor (003 <- 004, 003 <- 005). All affect src/api
  // (the default), exercising module + concept resolution and ordering.
  fs.writeFileSync(path.join(decs, 'adr-test-001.md'), decisionFixture('adr-test-001', 'Original choice', []), 'utf8');
  fs.writeFileSync(path.join(decs, 'adr-test-002.md'), decisionFixture('adr-test-002', 'Revised choice', ['adr-test-001']), 'utf8');
  fs.writeFileSync(path.join(decs, 'adr-test-003.md'), decisionFixture('adr-test-003', 'Ancestor choice', []), 'utf8');
  fs.writeFileSync(path.join(decs, 'adr-test-004.md'), decisionFixture('adr-test-004', 'First replacement', ['adr-test-003']), 'utf8');
  fs.writeFileSync(path.join(decs, 'adr-test-005.md'), decisionFixture('adr-test-005', 'Second replacement', ['adr-test-003']), 'utf8');
  // Decision case (d): a mix of an out-of-repo path, an undocumented-directory
  // path, and one valid path (src/models); only the valid one should resolve.
  fs.writeFileSync(path.join(decs, 'adr-test-006.md'),
    decisionFixture('adr-test-006', 'Mixed paths', [], ['../outside', 'src/undocumented', 'src/models']), 'utf8');
  // Decision case (e): block-style affects_paths must parse and resolve exactly
  // like the flow-style form (regression guard for the silent-drop bug where a
  // block list collapsed to an empty scalar and linked nowhere). Written by hand
  // (decisionFixture emits flow-style) so the block syntax is exercised.
  fs.writeFileSync(path.join(decs, 'adr-test-007.md'),
    '---\nid: adr-test-007\ntitle: Block style paths\ndate: 2026-06-01\nstage: architect\n' +
    'affects_paths:\n  - src/models\nsupersedes: []\n---\n\n' +
    '# Block style paths\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\nx\n', 'utf8');

  const failures = [];
  function check(cond, msg) { if (!cond) failures.push(msg); }

  const r1 = run(tmp, {});
  check(r1.ok, 'first run should succeed: ' + JSON.stringify(r1.errors));

  const api = fs.readFileSync(path.join(mods, 'src-api.md'), 'utf8');
  const models = fs.readFileSync(path.join(mods, 'src-models.md'), 'utf8');
  const apiFm = parseFm(splitDoc(api).fmLines);
  const modelsFm = parseFm(splitDoc(models).fmLines);

  check(JSON.stringify(apiFm.depends_on) === JSON.stringify(['src/models']), 'api depends_on src/models, got ' + JSON.stringify(apiFm.depends_on));
  check(JSON.stringify(modelsFm.depended_on_by) === JSON.stringify(['src/api']), 'models depended_on_by src/api, got ' + JSON.stringify(modelsFm.depended_on_by));
  check(JSON.stringify(apiFm.concepts) === JSON.stringify(['auth']), 'api concepts [auth], got ' + JSON.stringify(apiFm.concepts));
  check(/API layer\./.test(api), 'api prose preserved');
  check(/Handles users\./.test(api), 'api Files prose preserved');
  check(/Depended on by: \[src\/api\]/.test(models), 'models Related back-link rendered');
  check(fs.existsSync(path.join(tmp, 'dependencies.md')), 'dependencies.md written');
  check(fs.existsSync(path.join(tmp, 'index.md')), 'index.md written');

  // Transactional writes: temp-then-rename must never leave a stray
  // .tmp-buildlinks file behind once the run completes.
  check(!fs.existsSync(path.join(mods, 'src-api.md') + '.tmp-buildlinks'), 'no leftover tmp-buildlinks file for src-api.md');
  check(!fs.existsSync(path.join(tmp, 'dependencies.md') + '.tmp-buildlinks'), 'no leftover tmp-buildlinks file for dependencies.md');

  // Decision case: affects_paths resolving to a module (src-api gets all 5
  // src/api decisions, accepted-first then newest-first: 002,004,005 then
  // 001,003) and, via implemented_by, to its concept (auth unions the same
  // set since it has one member module).
  const expectedApiDecisions = ['adr-test-002', 'adr-test-004', 'adr-test-005', 'adr-test-001', 'adr-test-003'];
  check(JSON.stringify(apiFm.decisions) === JSON.stringify(expectedApiDecisions),
    'api decisions ' + JSON.stringify(expectedApiDecisions) + ', got ' + JSON.stringify(apiFm.decisions));
  check(/## Decisions/.test(api) && /adr-test-002/.test(api), 'api module doc has injected ## Decisions section');
  const authContent = fs.readFileSync(path.join(cons, 'auth.md'), 'utf8');
  check(/## Decisions/.test(authContent), 'auth concept doc has rendered ## Decisions section');
  expectedApiDecisions.forEach(function (id) {
    check(authContent.indexOf(id) !== -1, 'auth concept ## Decisions includes ' + id);
  });

  // Decision case (d): out-of-repo and undocumented affects_paths are dropped
  // fail-closed; only the valid src/models path resolves. Decision case (e):
  // the block-style adr-test-007 resolves to src/models exactly like a flow-
  // style path would (same date, so ordered by id after 006).
  check(JSON.stringify(modelsFm.decisions) === JSON.stringify(['adr-test-006', 'adr-test-007']),
    'models decisions [adr-test-006, adr-test-007] (block-style path resolved, out-of-repo/undocumented dropped), got ' + JSON.stringify(modelsFm.decisions));
  check(apiFm.decisions.indexOf('adr-test-006') === -1, 'adr-test-006 does not affect src/api');
  check(/adr-test-007/.test(models), 'block-style decision injected into models ## Decisions section');

  // Direct parser check: block-style list parses identically to flow-style.
  const flowFm = parseFm(['affects_paths: [src/a, src/b]']);
  const blockFm = parseFm(['affects_paths:', '  - src/a', '  - src/b']);
  check(JSON.stringify(blockFm.affects_paths) === JSON.stringify(['src/a', 'src/b']),
    'parseFm reads block-style list, got ' + JSON.stringify(blockFm.affects_paths));
  check(JSON.stringify(blockFm.affects_paths) === JSON.stringify(flowFm.affects_paths),
    'block-style and flow-style parse to the same list');
  // A key with an empty value and NO following items stays an empty scalar.
  const emptyFm = parseFm(['supersedes:', 'title: x']);
  check(emptyFm.supersedes === '' && emptyFm.title === 'x',
    'empty-value key without block items stays scalar and does not swallow the next key');

  // Aggregate log and index rows.
  const decisionsAgg = fs.readFileSync(path.join(tmp, 'decisions.md'), 'utf8');
  check(/## Accepted/.test(decisionsAgg) && /## Superseded/.test(decisionsAgg), 'decisions.md grouped by status');
  check(/\[adr-test-002\]\(decisions\/adr-test-002\.md\)/.test(decisionsAgg), 'decisions.md links accepted decision');
  check(/\[adr-test-001\]\(decisions\/adr-test-001\.md\)/.test(decisionsAgg), 'decisions.md links superseded decision');
  check(/architect/.test(decisionsAgg), 'decisions.md shows stage');
  const indexContent = fs.readFileSync(path.join(tmp, 'index.md'), 'utf8');
  check(/## Decisions/.test(indexContent) && /adr-test-001/.test(indexContent), 'index.md has decision rows');

  // Decision case (a): supersession pair. 001 is superseded by 002.
  const dec001 = fs.readFileSync(path.join(decs, 'adr-test-001.md'), 'utf8');
  const dec002 = fs.readFileSync(path.join(decs, 'adr-test-002.md'), 'utf8');
  const dec001Fm = parseFm(splitDoc(dec001).fmLines);
  const dec002Fm = parseFm(splitDoc(dec002).fmLines);
  check(JSON.stringify(dec001Fm.superseded_by) === JSON.stringify(['adr-test-002']), '001 superseded_by [adr-test-002], got ' + JSON.stringify(dec001Fm.superseded_by));
  check(dec001Fm.status === 'superseded', '001 status superseded, got ' + dec001Fm.status);
  check(JSON.stringify(dec002Fm.superseded_by) === JSON.stringify([]), '002 superseded_by [], got ' + JSON.stringify(dec002Fm.superseded_by));
  check(dec002Fm.status === 'accepted', '002 status accepted, got ' + dec002Fm.status);

  // Decision case (b): two decisions superseding one ancestor.
  const dec003 = fs.readFileSync(path.join(decs, 'adr-test-003.md'), 'utf8');
  const dec003Fm = parseFm(splitDoc(dec003).fmLines);
  check(JSON.stringify(dec003Fm.superseded_by) === JSON.stringify(['adr-test-004', 'adr-test-005']), '003 superseded_by both replacements, got ' + JSON.stringify(dec003Fm.superseded_by));
  check(dec003Fm.status === 'superseded', '003 status superseded, got ' + dec003Fm.status);

  // Idempotence: a second run writes nothing (modules, concepts, and decisions unchanged).
  const r2 = run(tmp, {});
  check(r2.ok && r2.written.length === 0, 'second run is a no-op, wrote: ' + JSON.stringify(r2.written));

  // Fail-closed: plant a dangling concept reference and confirm --check fails.
  fs.writeFileSync(path.join(cons, 'ghost.md'),
    '---\nconcept: ghost\nimplemented_by: [does/not/exist]\n---\n\n# ghost\n', 'utf8');
  const r3 = run(tmp, {});
  // does/not/exist has no module, so no edge and no dangling link; this should still pass.
  check(r3.ok, 'unknown implemented_by dir is ignored, not fatal: ' + JSON.stringify(r3.errors));

  fs.rmSync(tmp, { recursive: true, force: true });

  // Decision case (c): a decisions-only graph (no modules/ or concepts/ dirs at all).
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-decisions-only-'));
  const decs2 = path.join(tmp2, 'decisions');
  fs.mkdirSync(decs2, { recursive: true });
  fs.writeFileSync(path.join(decs2, 'adr-solo-001.md'), decisionFixture('adr-solo-001', 'Solo choice', []), 'utf8');
  const r4 = run(tmp2, {});
  check(r4.ok, 'decisions-only graph should not fail: ' + JSON.stringify(r4.errors));
  const solo = fs.readFileSync(path.join(decs2, 'adr-solo-001.md'), 'utf8');
  const soloFm = parseFm(splitDoc(solo).fmLines);
  check(JSON.stringify(soloFm.superseded_by) === JSON.stringify([]), 'solo superseded_by [], got ' + JSON.stringify(soloFm.superseded_by));
  check(soloFm.status === 'accepted', 'solo status accepted, got ' + soloFm.status);
  const soloDecisionsAgg = fs.readFileSync(path.join(tmp2, 'decisions.md'), 'utf8');
  check(/adr-solo-001/.test(soloDecisionsAgg), 'decisions-only aggregate log renders solo decision');
  const r4b = run(tmp2, {});
  check(r4b.ok && r4b.written.length === 0, 'decisions-only second run is a no-op, wrote: ' + JSON.stringify(r4b.written));
  fs.rmSync(tmp2, { recursive: true, force: true });

  // Decision case: the injected-section cap. 12 decisions all affect one
  // module; only the 10 most recent should appear, with a truncation note.
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-cap-'));
  const mods4 = path.join(tmp4, 'modules');
  const cons4 = path.join(tmp4, 'concepts');
  const decs4 = path.join(tmp4, 'decisions');
  fs.mkdirSync(mods4, { recursive: true });
  fs.mkdirSync(cons4, { recursive: true });
  fs.mkdirSync(decs4, { recursive: true });
  fs.writeFileSync(path.join(mods4, 'src-cap.md'),
    '---\ndirectory: src/cap\nlast_commit: abc\nresolved_dependencies: []\nexternal_dependencies: []\n---\n\n# src/cap\n\nCapped module.\n', 'utf8');
  fs.writeFileSync(path.join(cons4, 'capcon.md'),
    '---\nconcept: capcon\nimplemented_by: [src/cap]\n---\n\n# capcon\n\nCapped concept.\n', 'utf8');
  const capIds = [];
  for (let i = 1; i <= 12; i++) {
    const id = 'adr-cap-' + String(i).padStart(3, '0');
    const date = '2026-01-' + String(i).padStart(2, '0');
    capIds.push(id);
    fs.writeFileSync(path.join(decs4, id + '.md'), decisionFixture(id, 'Cap decision ' + i, [], ['src/cap'], date), 'utf8');
  }
  const r6 = run(tmp4, {});
  check(r6.ok, 'cap fixture first run should succeed: ' + JSON.stringify(r6.errors));
  const capModule = fs.readFileSync(path.join(mods4, 'src-cap.md'), 'utf8');
  const capModuleFm = parseFm(splitDoc(capModule).fmLines);
  const expectedCapped = capIds.slice(2).reverse(); // newest 10: adr-cap-012 .. adr-cap-003
  check(capModuleFm.decisions.length === 10, 'capped module decisions length 10, got ' + capModuleFm.decisions.length);
  check(JSON.stringify(capModuleFm.decisions) === JSON.stringify(expectedCapped),
    'capped module decisions ' + JSON.stringify(expectedCapped) + ', got ' + JSON.stringify(capModuleFm.decisions));
  check(/see decisions\.md|See \[decisions\.md\]/i.test(capModule), 'capped module doc notes see decisions.md on truncation');
  check(capModule.indexOf('adr-cap-001') === -1, 'capped module doc excludes truncated oldest decision');
  const capConcept = fs.readFileSync(path.join(cons4, 'capcon.md'), 'utf8');
  expectedCapped.forEach(function (id) {
    check(capConcept.indexOf(id) !== -1, 'capped concept doc union includes ' + id);
  });
  check(capConcept.indexOf('adr-cap-001') === -1, 'capped concept doc excludes truncated oldest decision (via capped module union)');
  const r7 = run(tmp4, {});
  check(r7.ok && r7.written.length === 0, 'cap fixture second run is a no-op, wrote: ' + JSON.stringify(r7.written));
  fs.rmSync(tmp4, { recursive: true, force: true });

  // Decision case (e): a dangling supersedes target fails closed and writes nothing.
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-dangling-'));
  const decs3 = path.join(tmp3, 'decisions');
  fs.mkdirSync(decs3, { recursive: true });
  const danglingContent = decisionFixture('adr-dangling-001', 'Dangling supersedes', ['adr-ghost-099']);
  fs.writeFileSync(path.join(decs3, 'adr-dangling-001.md'), danglingContent, 'utf8');
  const r5 = run(tmp3, {});
  check(!r5.ok, 'dangling supersedes target should fail closed');
  check(r5.errors.some(function (e) { return /supersedes/.test(e); }), 'dangling supersedes error message present, got ' + JSON.stringify(r5.errors));
  check(r5.written.length === 0, 'dangling supersedes run writes nothing');
  const danglingAfter = fs.readFileSync(path.join(decs3, 'adr-dangling-001.md'), 'utf8');
  check(danglingAfter === danglingContent, 'dangling supersedes file left unchanged on disk');
  fs.rmSync(tmp3, { recursive: true, force: true });

  // Non-canonical affects_paths (`./`-prefixed, doubled slash) must resolve
  // to the same module directory as the canonical form (regression guard for
  // mapPathToDir's old raw-string-prefix compare).
  const tmp11 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-normalize-'));
  const mods11 = path.join(tmp11, 'modules');
  const decs11 = path.join(tmp11, 'decisions');
  fs.mkdirSync(mods11, { recursive: true });
  fs.mkdirSync(decs11, { recursive: true });
  fs.writeFileSync(path.join(mods11, 'src-norm.md'),
    '---\ndirectory: src/norm\nlast_commit: abc\nresolved_dependencies: []\nexternal_dependencies: []\n---\n\n# src/norm\n\nNormalize target.\n', 'utf8');
  fs.writeFileSync(path.join(decs11, 'adr-norm-001.md'),
    decisionFixture('adr-norm-001', 'Dot-slash path', [], ['./src/norm']), 'utf8');
  fs.writeFileSync(path.join(decs11, 'adr-norm-002.md'),
    decisionFixture('adr-norm-002', 'Double slash path', [], ['src//norm'], '2026-06-02'), 'utf8');
  const r11 = run(tmp11, {});
  check(r11.ok, 'non-canonical affects_paths fixture should succeed: ' + JSON.stringify(r11.errors));
  const normModule = fs.readFileSync(path.join(mods11, 'src-norm.md'), 'utf8');
  const normModuleFm = parseFm(splitDoc(normModule).fmLines);
  check(JSON.stringify(normModuleFm.decisions) === JSON.stringify(['adr-norm-002', 'adr-norm-001']),
    './-prefixed and doubled-slash affects_paths should both resolve to src/norm, got ' + JSON.stringify(normModuleFm.decisions));
  // Same normalization must apply to recall scoring.
  const recallDotSlash = recall(tmp11, ['./src/norm/file.ts']);
  check(recallDotSlash.length === 2, 'recall normalizes a ./-prefixed query path, got ' + JSON.stringify(recallDotSlash));
  fs.rmSync(tmp11, { recursive: true, force: true });

  // --- --recall self-test cases (ADR-003, api.md "Recall query") ---------

  // Fixture: three decisions affecting src/api at different depths/dates,
  // plus one unrelated decision.
  const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-recall-'));
  const decs5 = path.join(tmp5, 'decisions');
  fs.mkdirSync(decs5, { recursive: true });
  fs.writeFileSync(path.join(decs5, 'adr-recall-001.md'),
    decisionFixture('adr-recall-001', 'Shallow choice', [], ['src/api'], '2026-01-01'), 'utf8');
  fs.writeFileSync(path.join(decs5, 'adr-recall-002.md'),
    decisionFixture('adr-recall-002', 'Deep choice A', [], ['src/api/handlers'], '2026-01-02'), 'utf8');
  fs.writeFileSync(path.join(decs5, 'adr-recall-003.md'),
    decisionFixture('adr-recall-003', 'Deep choice B', [], ['src/api/handlers'], '2026-01-05'), 'utf8');
  fs.writeFileSync(path.join(decs5, 'adr-recall-004.md'),
    decisionFixture('adr-recall-004', 'Unrelated', [], ['docs/other'], '2026-01-03'), 'utf8');

  const filesBeforeRecall = fs.readdirSync(decs5).sort();

  // Prefix match + ranking: longer shared prefix first, then newer date breaks ties.
  const recallResult = recall(tmp5, ['src/api/handlers/users.ts']);
  check(recallResult.length === 3, 'recall matches 3 of 4 decisions, got ' + recallResult.length);
  check(JSON.stringify(recallResult.map(function (r) { return r.id; })) === JSON.stringify(['adr-recall-003', 'adr-recall-002', 'adr-recall-001']),
    'recall ranks by longest prefix then newer date, got ' + JSON.stringify(recallResult.map(function (r) { return r.id; })));
  check(recallResult[0].overlap_path === 'src/api/handlers', 'recall overlap_path is src/api/handlers, got ' + recallResult[0].overlap_path);
  check(recallResult[2].overlap_path === 'src/api', 'recall shallow overlap_path is src/api, got ' + recallResult[2].overlap_path);
  check(recallResult.every(function (r) { return r.id && r.title && r.date && r.stage && Array.isArray(r.affects_paths) && r.overlap_path; }),
    'recall entries carry id/title/date/stage/affects_paths/overlap_path');

  // No match: a query path that shares no leading segment with any decision.
  const recallNoMatch = recall(tmp5, ['lib/utils.ts']);
  check(Array.isArray(recallNoMatch) && recallNoMatch.length === 0, 'recall with no match returns [], got ' + JSON.stringify(recallNoMatch));

  // Absent decisions directory.
  const tmp6 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-recall-absent-'));
  const recallAbsent = recall(tmp6, ['src/api']);
  check(Array.isArray(recallAbsent) && recallAbsent.length === 0, 'recall with absent decisions dir returns [], got ' + JSON.stringify(recallAbsent));
  fs.rmSync(tmp6, { recursive: true, force: true });

  // Path-safety: shell metacharacters and null bytes are rejected fail-closed.
  check(hasDangerousPathArg('src/api;rm -rf /'), 'hasDangerousPathArg rejects shell metacharacter');
  check(hasDangerousPathArg('src/api' + String.fromCharCode(0) + 'hidden'), 'hasDangerousPathArg rejects null byte');
  check(!hasDangerousPathArg('src/api/handlers'), 'hasDangerousPathArg accepts a clean path');

  // CLI-level: --recall with a dangerous path argument fails closed, one-line stderr, nonzero exit.
  const selfPath = process.argv[1];
  const cliDangerous = spawnSync(process.execPath, [selfPath, '--recall', tmp5, 'src/api;rm -rf /'], { encoding: 'utf8' });
  check(cliDangerous.status !== 0, 'CLI --recall with dangerous path exits nonzero');
  check(cliDangerous.stderr.trim().split('\n').length === 1, 'CLI --recall dangerous-path stderr is one line, got ' + JSON.stringify(cliDangerous.stderr));

  // CLI-level: --recall combined with --check errors.
  const cliBothFlags = spawnSync(process.execPath, [selfPath, '--recall', '--check', tmp5, 'src/api'], { encoding: 'utf8' });
  check(cliBothFlags.status !== 0, 'CLI --recall + --check exits nonzero');
  check(cliBothFlags.stderr.trim().split('\n').length === 1, 'CLI --recall + --check stderr is one line, got ' + JSON.stringify(cliBothFlags.stderr));

  // CLI-level: a normal recall prints the expected JSON array to stdout, exits 0.
  const cliOk = spawnSync(process.execPath, [selfPath, '--recall', tmp5, 'src/api/handlers/users.ts'], { encoding: 'utf8' });
  check(cliOk.status === 0, 'CLI --recall exits 0, got ' + cliOk.status + ' stderr: ' + cliOk.stderr);
  let cliOkParsed = null;
  try { cliOkParsed = JSON.parse(cliOk.stdout); } catch (e) { /* leave null, checked below */ }
  check(Array.isArray(cliOkParsed) && cliOkParsed.length === 3, 'CLI --recall prints a JSON array of 3, got ' + cliOk.stdout);

  // CLI-level: no-match query prints [] and exits 0.
  const cliNoMatch = spawnSync(process.execPath, [selfPath, '--recall', tmp5, 'lib/utils.ts'], { encoding: 'utf8' });
  check(cliNoMatch.status === 0 && cliNoMatch.stdout.trim() === '[]', 'CLI --recall no-match prints [] and exits 0, got ' + JSON.stringify(cliNoMatch));

  // CLI-level: an absolute in-repo query path is converted to repo-relative
  // before scoring, so it ranks identically to the relative form (fix: query
  // paths used to be dropped by isOutOfRepo without ever being resolved).
  const repoRootForRecall = path.dirname(tmp5);
  const absoluteQueryPath = path.join(repoRootForRecall, 'src/api/handlers/users.ts');
  const cliAbsolute = spawnSync(process.execPath, [selfPath, '--recall', tmp5, absoluteQueryPath], { encoding: 'utf8' });
  check(cliAbsolute.status === 0, 'CLI --recall with absolute in-repo path exits 0, got ' + cliAbsolute.status + ' stderr: ' + cliAbsolute.stderr);
  let cliAbsoluteParsed = null;
  try { cliAbsoluteParsed = JSON.parse(cliAbsolute.stdout); } catch (e) { /* checked below */ }
  check(Array.isArray(cliAbsoluteParsed) &&
    JSON.stringify(cliAbsoluteParsed.map(function (r) { return r.id; })) === JSON.stringify(['adr-recall-003', 'adr-recall-002', 'adr-recall-001']),
    'CLI --recall absolute in-repo path ranks identically to the relative form, got ' + cliAbsolute.stdout);

  // CLI-level: when every query path is out-of-repo after resolution, recall
  // must fail loudly (nonzero exit, stderr diagnostic) instead of silently
  // printing [].
  const cliAllOutOfRepo = spawnSync(process.execPath,
    [selfPath, '--recall', tmp5, '/definitely/outside/repo.ts', '../escaping/path.ts'], { encoding: 'utf8' });
  check(cliAllOutOfRepo.status !== 0, 'CLI --recall with only out-of-repo paths exits nonzero, got ' + cliAllOutOfRepo.status);
  check(cliAllOutOfRepo.stdout.trim() === '', 'CLI --recall with only out-of-repo paths prints nothing to stdout, got ' + JSON.stringify(cliAllOutOfRepo.stdout));
  check(cliAllOutOfRepo.stderr.length > 0, 'CLI --recall with only out-of-repo paths writes a stderr diagnostic');

  // Recall never writes: the decisions dir is byte-identical after all recall calls above.
  const filesAfterRecall = fs.readdirSync(decs5).sort();
  check(JSON.stringify(filesBeforeRecall) === JSON.stringify(filesAfterRecall), 'recall wrote no new files in decisions dir');
  check(!fs.existsSync(path.join(tmp5, 'dependencies.md')) && !fs.existsSync(path.join(tmp5, 'decisions.md')) && !fs.existsSync(path.join(tmp5, 'index.md')),
    'recall wrote no aggregate files');

  fs.rmSync(tmp5, { recursive: true, force: true });

  // CRLF frontmatter guard: a module doc using CRLF line endings must still
  // be recognized as having frontmatter, not treated as bodyless and
  // corrupted by a freshly prepended empty frontmatter block.
  const tmp9 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-crlf-'));
  const mods9 = path.join(tmp9, 'modules');
  fs.mkdirSync(mods9, { recursive: true });
  const crlfContent = '---\r\ndirectory: src/crlf\r\nlast_commit: abc\r\nresolved_dependencies: []\r\nexternal_dependencies: []\r\n---\r\n\r\n# src/crlf\r\n\r\nCRLF module.\r\n';
  fs.writeFileSync(path.join(mods9, 'src-crlf.md'), crlfContent, 'utf8');
  const r9 = run(tmp9, {});
  check(r9.ok, 'CRLF module doc should be parsed correctly: ' + JSON.stringify(r9.errors));
  const crlfOut = fs.readFileSync(path.join(mods9, 'src-crlf.md'), 'utf8');
  check(/directory: src\/crlf/.test(crlfOut), 'CRLF module retains original directory key, got: ' + crlfOut.slice(0, 200));
  check((crlfOut.match(/^---$/gm) || []).length === 2, 'CRLF module has exactly one frontmatter block (not a corrupt second one prepended), got ' + JSON.stringify(crlfOut));
  check(/CRLF module\./.test(crlfOut), 'CRLF module prose preserved');
  fs.rmSync(tmp9, { recursive: true, force: true });

  // Frontmatter-less doc rejection: a module doc with NO frontmatter block at
  // all must fail closed with a clear per-file error, never have a fresh
  // frontmatter block silently prepended onto it.
  const tmp10 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-nofm-'));
  const mods10 = path.join(tmp10, 'modules');
  fs.mkdirSync(mods10, { recursive: true });
  const noFmContent = '# src/nofm\n\nNo frontmatter here at all.\n';
  fs.writeFileSync(path.join(mods10, 'src-nofm.md'), noFmContent, 'utf8');
  const r10 = run(tmp10, {});
  check(!r10.ok, 'frontmatter-less module doc should fail closed');
  check(r10.errors.some(function (e) { return /frontmatter/i.test(e) && /src-nofm\.md/.test(e); }),
    'frontmatter-less error names the file, got ' + JSON.stringify(r10.errors));
  const noFmAfter = fs.readFileSync(path.join(mods10, 'src-nofm.md'), 'utf8');
  check(noFmAfter === noFmContent, 'frontmatter-less module file left unchanged on disk');
  fs.rmSync(tmp10, { recursive: true, force: true });

  // Block-style orphan cleanup: replacing a hand-authored block-style managed
  // key must remove its `- item` continuation lines, not just the `key:`
  // line, and the preservation check must still pass.
  const tmp12 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-blockorphan-'));
  const mods12 = path.join(tmp12, 'modules');
  fs.mkdirSync(mods12, { recursive: true });
  fs.writeFileSync(path.join(mods12, 'src-orphan.md'),
    '---\ndirectory: src/orphan\nlast_commit: abc\nresolved_dependencies: []\nexternal_dependencies: []\n' +
    'depends_on:\n  - some/stale/dir\n  - another/stale/dir\ndepended_on_by: []\nconcepts: []\ndecisions: []\n' +
    '---\n\n# src/orphan\n\nOrphan block test.\n', 'utf8');
  const r12 = run(tmp12, {});
  check(r12.ok, 'block-orphan fixture should succeed: ' + JSON.stringify(r12.errors));
  const orphanOut = fs.readFileSync(path.join(mods12, 'src-orphan.md'), 'utf8');
  check(!/some\/stale\/dir/.test(orphanOut), 'stale block-style depends_on item removed, got ' + orphanOut.slice(0, 400));
  check(!/another\/stale\/dir/.test(orphanOut), 'second stale block-style depends_on item removed');
  check(/depends_on: \[\]/.test(orphanOut), 'depends_on rewritten as flow-style empty list, got ' + orphanOut.slice(0, 400));
  fs.rmSync(tmp12, { recursive: true, force: true });

  // Supersession cycle rejection: two decisions superseding each other must
  // fail closed (never leave both "superseded" with no accepted survivor).
  const tmp13 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-cycle-'));
  const decs13 = path.join(tmp13, 'decisions');
  fs.mkdirSync(decs13, { recursive: true });
  fs.writeFileSync(path.join(decs13, 'adr-cycle-a.md'), decisionFixture('adr-cycle-a', 'Cycle A', ['adr-cycle-b']), 'utf8');
  fs.writeFileSync(path.join(decs13, 'adr-cycle-b.md'), decisionFixture('adr-cycle-b', 'Cycle B', ['adr-cycle-a']), 'utf8');
  const r13 = run(tmp13, {});
  check(!r13.ok, 'a two-decision supersession cycle should fail closed');
  check(r13.errors.some(function (e) { return /cycle/i.test(e); }), 'cycle error message present, got ' + JSON.stringify(r13.errors));
  check(r13.written.length === 0, 'cycle run writes nothing');
  fs.rmSync(tmp13, { recursive: true, force: true });

  // Self-supersession: a decision supersedes itself must also fail closed.
  const tmp14 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-selfsup-'));
  const decs14 = path.join(tmp14, 'decisions');
  fs.mkdirSync(decs14, { recursive: true });
  fs.writeFileSync(path.join(decs14, 'adr-self-001.md'), decisionFixture('adr-self-001', 'Self supersession', ['adr-self-001']), 'utf8');
  const r14 = run(tmp14, {});
  check(!r14.ok, 'self-supersession should fail closed');
  check(r14.errors.some(function (e) { return /self-supersession|itself/i.test(e); }), 'self-supersession error message present, got ' + JSON.stringify(r14.errors));
  fs.rmSync(tmp14, { recursive: true, force: true });

  // Duplicate directory: two module docs claiming the same `directory` key
  // must fail closed with a clear error naming the directory.
  const tmp15 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-dupdir-'));
  const mods15 = path.join(tmp15, 'modules');
  fs.mkdirSync(mods15, { recursive: true });
  fs.writeFileSync(path.join(mods15, 'a.md'),
    '---\ndirectory: src/dup\nlast_commit: abc\nresolved_dependencies: []\nexternal_dependencies: []\n---\n\n# a\n\nA.\n', 'utf8');
  fs.writeFileSync(path.join(mods15, 'b.md'),
    '---\ndirectory: src/dup\nlast_commit: abc\nresolved_dependencies: []\nexternal_dependencies: []\n---\n\n# b\n\nB.\n', 'utf8');
  const r15 = run(tmp15, {});
  check(!r15.ok, 'duplicate directory across module docs should fail closed');
  check(r15.errors.some(function (e) { return /duplicate directory/i.test(e) && /src\/dup/.test(e); }),
    'duplicate directory error names the directory, got ' + JSON.stringify(r15.errors));
  fs.rmSync(tmp15, { recursive: true, force: true });

  // Decision id/filename mismatch must fail closed.
  const tmp16 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-idmismatch-'));
  const decs16 = path.join(tmp16, 'decisions');
  fs.mkdirSync(decs16, { recursive: true });
  fs.writeFileSync(path.join(decs16, 'adr-mismatch-001.md'), decisionFixture('adr-wrong-id', 'Mismatch', []), 'utf8');
  const r16 = run(tmp16, {});
  check(!r16.ok, 'decision id/filename mismatch should fail closed');
  check(r16.errors.some(function (e) { return /adr-mismatch-001\.md/.test(e) && /id/i.test(e); }),
    'id/filename mismatch error names the file, got ' + JSON.stringify(r16.errors));
  fs.rmSync(tmp16, { recursive: true, force: true });

  // `constructor` as a decision id must not break membership/lookup
  // structures (prototype-pollution-adjacent key name).
  check(JSON.stringify(dedupe(['constructor', 'constructor', 'other'])) === JSON.stringify(['constructor', 'other']),
    'dedupe handles "constructor" as a value correctly');
  const tmp17 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-ctorid-'));
  const decs17 = path.join(tmp17, 'decisions');
  fs.mkdirSync(decs17, { recursive: true });
  fs.writeFileSync(path.join(decs17, 'constructor.md'), decisionFixture('constructor', 'Ctor decision', []), 'utf8');
  fs.writeFileSync(path.join(decs17, 'adr-ctor-super.md'), decisionFixture('adr-ctor-super', 'Supersedes ctor', ['constructor']), 'utf8');
  const r17 = run(tmp17, {});
  check(r17.ok, '"constructor" as a decision id should run cleanly: ' + JSON.stringify(r17.errors));
  const ctorDoc = fs.readFileSync(path.join(decs17, 'constructor.md'), 'utf8');
  const ctorFm = parseFm(splitDoc(ctorDoc).fmLines);
  check(JSON.stringify(ctorFm.superseded_by) === JSON.stringify(['adr-ctor-super']), '"constructor" decision correctly superseded, got ' + JSON.stringify(ctorFm.superseded_by));
  check(ctorFm.status === 'superseded', '"constructor" decision status superseded, got ' + ctorFm.status);
  const ctorAgg = fs.readFileSync(path.join(tmp17, 'decisions.md'), 'utf8');
  check(/constructor/.test(ctorAgg), 'decisions.md aggregate includes the "constructor" decision');
  fs.rmSync(tmp17, { recursive: true, force: true });

  // Code-fence link exemption: a literal example link inside a fenced code
  // block in module body prose must not be treated as a real managed link
  // requiring resolution.
  const tmp18 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-fence-'));
  const mods18 = path.join(tmp18, 'modules');
  fs.mkdirSync(mods18, { recursive: true });
  fs.writeFileSync(path.join(mods18, 'src-fence.md'),
    '---\ndirectory: src/fence\nlast_commit: abc\nresolved_dependencies: []\nexternal_dependencies: []\n---\n\n' +
    '# src/fence\n\nExample body.\n\n```md\nSee [example](modules/does-not-exist.md) for reference.\n```\n', 'utf8');
  const r18 = run(tmp18, {});
  check(r18.ok, 'code-fenced example link should not trigger a dangling-link failure: ' + JSON.stringify(r18.errors));
  fs.rmSync(tmp18, { recursive: true, force: true });

  // last_run is meaningful: it must not churn when nothing else changed, but
  // must bump to today() when the rendered content genuinely changes.
  const tmp19 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-links-selftest-lastrun-'));
  const mods19 = path.join(tmp19, 'modules');
  fs.mkdirSync(mods19, { recursive: true });
  fs.writeFileSync(path.join(mods19, 'src-a.md'),
    '---\ndirectory: src/a\nlast_commit: abc\nresolved_dependencies: []\nexternal_dependencies: []\n---\n\n# src/a\n\nA.\n', 'utf8');
  const r19a = run(tmp19, {});
  check(r19a.ok, 'last_run fixture first run should succeed: ' + JSON.stringify(r19a.errors));
  const depsPath19 = path.join(tmp19, 'dependencies.md');
  const depsAfterFirst = fs.readFileSync(depsPath19, 'utf8');
  // Simulate an old recorded last_run (as if the file had not changed since
  // a long-ago run) by rewriting only that one field on disk.
  const staleDeps = depsAfterFirst.replace(/last_run: \d{4}-\d{2}-\d{2}/, 'last_run: 2000-01-01');
  fs.writeFileSync(depsPath19, staleDeps, 'utf8');
  const r19b = run(tmp19, {});
  check(r19b.ok && r19b.written.indexOf('dependencies.md') === -1,
    'unchanged model with a stale last_run must not churn (no date-only rewrite), wrote: ' + JSON.stringify(r19b.written));
  const depsStillStale = fs.readFileSync(depsPath19, 'utf8');
  check(/last_run: 2000-01-01/.test(depsStillStale), 'stale last_run is preserved when nothing else changed');
  // Now make a genuine model change (a new module) and confirm last_run
  // bumps to today(), proving the field is meaningful rather than frozen.
  fs.writeFileSync(path.join(mods19, 'src-b.md'),
    '---\ndirectory: src/b\nlast_commit: abc\nresolved_dependencies: []\nexternal_dependencies: []\n---\n\n# src/b\n\nB.\n', 'utf8');
  const r19c = run(tmp19, {});
  check(r19c.ok && r19c.written.indexOf('dependencies.md') !== -1,
    'a genuine model change should rewrite dependencies.md, wrote: ' + JSON.stringify(r19c.written));
  const depsAfterChange = fs.readFileSync(depsPath19, 'utf8');
  check(depsAfterChange.indexOf('last_run: ' + today()) !== -1,
    'last_run bumps to today() once real content changes, got ' + depsAfterChange.slice(0, 120));
  fs.rmSync(tmp19, { recursive: true, force: true });

  if (failures.length) {
    process.stderr.write('SELFTEST FAILED:\n' + failures.map(function (f) { return '  - ' + f; }).join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write('selftest ok\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.indexOf('--selftest') !== -1) { selftest(); return; }

  const check = args.indexOf('--check') !== -1;
  const recallFlag = args.indexOf('--recall') !== -1;
  const positional = args.filter(function (a) { return a.indexOf('--') !== 0; });

  if (recallFlag && check) {
    process.stderr.write('build-links: --recall and --check are mutually exclusive\n');
    process.exit(1);
  }

  if (recallFlag) {
    const rDocsDir = positional[0];
    const queryPaths = positional.slice(1);
    if (!rDocsDir) {
      process.stderr.write('Usage: node build-links.js --recall <docs_dir> <path> [<path> ...]\n');
      process.exit(1);
    }
    for (let i = 0; i < queryPaths.length; i++) {
      if (hasDangerousPathArg(queryPaths[i])) {
        process.stderr.write('build-links: rejected path argument (shell metacharacter or null byte)\n');
        process.exit(1);
      }
    }
    // Repo root is the parent of the docs dir argument: an absolute query
    // path that falls under it is converted to repo-relative before scoring,
    // instead of being silently dropped like any other out-of-repo path.
    const repoRoot = path.dirname(path.resolve(rDocsDir));
    const safePaths = [];
    queryPaths.forEach(function (raw) {
      const resolved = resolveRecallQueryPath(raw, repoRoot);
      if (isOutOfRepo(resolved)) {
        process.stderr.write('build-links: dropping out-of-repo path argument: ' + raw + '\n');
      } else {
        safePaths.push(resolved);
      }
    });
    if (!safePaths.length) {
      process.stderr.write('build-links: no query paths remain after dropping out-of-repo arguments\n');
      process.exit(1);
    }
    const results = recall(rDocsDir, safePaths);
    process.stdout.write(JSON.stringify(results) + '\n');
    return;
  }

  const docsDir = positional[0];
  if (!docsDir) {
    process.stderr.write('Usage: node build-links.js [--check] <docs_dir> | --recall <docs_dir> <path> [<path> ...] | --selftest\n');
    process.exit(1);
  }

  const result = run(docsDir, { check: check });
  if (!result.ok) {
    process.stderr.write('build-links FAILED (no files written):\n' +
      result.errors.map(function (e) { return '  - ' + e; }).join('\n') + '\n');
    process.exit(1);
  }
  if (check) {
    process.stdout.write('check ok' + (result.pending && result.pending.length ? ' (' + result.pending.length + ' file(s) would change)' : '') + '\n');
  } else {
    process.stdout.write('build-links ok: wrote ' + result.written.length + ' file(s)\n');
  }
}

main();
