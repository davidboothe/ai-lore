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
 *   node build-links.js <docs_dir>            write on delta (default)
 *   node build-links.js --check <docs_dir>    validate only, write nothing (fail closed)
 *   node build-links.js --selftest            run built-in fixtures, exit nonzero on mismatch
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Node-type-aware managed regions. Each node type owns a disjoint set of
// frontmatter keys and body headings that this script is the sole writer of.
const MANAGED_KEYS = {
  module: ['depends_on', 'depended_on_by', 'concepts'],
  concept: [],
  decision: ['superseded_by', 'status'],
};
const MANAGED_HEADINGS = {
  module: ['## Concepts', '## Related'],
  concept: [],
  decision: [],
};

// ---------------------------------------------------------------------------
// Frontmatter + document parsing (constrained YAML subset: flat scalars and
// flow-style lists only; no multiline, no nesting).
// ---------------------------------------------------------------------------

function splitDoc(content) {
  const lines = content.split('\n');
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

function parseFm(fmLines) {
  const fm = {};
  fmLines.forEach(function (line) {
    const p = parseFmLine(line);
    if (p) fm[p.key] = parseValue(p.raw);
  });
  return fm;
}

function serializeList(arr) {
  return '[' + arr.join(', ') + ']';
}

// Surgically set a frontmatter key: replace its line in place, or append it.
function setFmKey(fmLines, key, serializedValue) {
  const out = fmLines.slice();
  for (let i = 0; i < out.length; i++) {
    const p = parseFmLine(out[i]);
    if (p && p.key === key) { out[i] = key + ': ' + serializedValue; return out; }
  }
  out.push(key + ': ' + serializedValue);
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
  const keptFm = d.fmLines.filter(function (l) {
    const p = parseFmLine(l);
    return !p || keys.indexOf(p.key) === -1;
  });
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

function mapPathToDir(p, dirs) {
  let best = null;
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    if (p === d || p.indexOf(d + '/') === 0) {
      if (best === null || d.length > best.length) best = d;
    }
  }
  return best;
}

function uniqSort(arr) {
  return Array.from(new Set(arr)).sort();
}

// Tarjan SCC; returns components with size > 1 (or self-loops) as cycles.
function findCycles(nodes, edges) {
  let index = 0;
  const stack = [];
  const onStack = {};
  const idx = {};
  const low = {};
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
        modules.push({ file: 'modules/' + f, slug: f.replace(/\.md$/, ''), content: content, fm: fm });
      });
  }
  if (fs.existsSync(conceptsDir)) {
    fs.readdirSync(conceptsDir).filter(function (f) { return /\.md$/.test(f); }).sort()
      .forEach(function (f) {
        const content = fs.readFileSync(path.join(conceptsDir, f), 'utf8');
        const fm = parseFm(splitDoc(content).fmLines);
        concepts.push({ file: 'concepts/' + f, slug: f.replace(/\.md$/, ''), fm: fm });
      });
  }
  if (fs.existsSync(decisionsDir)) {
    fs.readdirSync(decisionsDir).filter(function (f) { return /\.md$/.test(f); }).sort()
      .forEach(function (f) {
        const content = fs.readFileSync(path.join(decisionsDir, f), 'utf8');
        const d = splitDoc(content);
        const fm = parseFm(d.fmLines);
        decisions.push({ file: 'decisions/' + f, slug: f.replace(/\.md$/, ''), content: content, fm: fm });
      });
  }
  return { modules: modules, concepts: concepts, decisions: decisions };
}

// Derive decision-to-decision managed state: superseded_by is the inverse of
// each decision's source `supersedes` list; status is fully derived from it.
// A `supersedes` target that does not resolve to a known decision id is
// reported in danglingRefs so the caller can fail closed.
function computeDecisionModel(decisionRecords) {
  const byId = {};
  decisionRecords.forEach(function (d) { byId[d.fm.id] = d; });

  const supersededBy = {};
  decisionRecords.forEach(function (d) { supersededBy[d.fm.id] = []; });

  const danglingRefs = [];
  decisionRecords.forEach(function (d) {
    const sup = Array.isArray(d.fm.supersedes) ? d.fm.supersedes : [];
    sup.forEach(function (target) {
      if (!byId[target]) { danglingRefs.push({ from: d.fm.id, to: target }); return; }
      supersededBy[target].push(d.fm.id);
    });
  });
  Object.keys(supersededBy).forEach(function (id) { supersededBy[id] = uniqSort(supersededBy[id]); });

  const status = {};
  decisionRecords.forEach(function (d) {
    status[d.fm.id] = supersededBy[d.fm.id].length ? 'superseded' : 'accepted';
  });

  return { supersededBy: supersededBy, status: status, danglingRefs: danglingRefs };
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
function computeModel(moduleRecords, conceptRecords) {
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

  return {
    dirs: dirSet.slice().sort(),
    slugForDir: bySlugDir,
    dependsOn: dependsOn,
    dependedOnBy: dependedOnBy,
    conceptsByDir: conceptsByDir,
    dependsGraph: dependsOn,
  };
}

function renderModuleManaged(record, model) {
  const dir = record.fm.directory;
  const deps = model.dependsOn[dir] || [];
  const rdeps = model.dependedOnBy[dir] || [];
  const cons = uniqSort(model.conceptsByDir[dir] || []);

  const d = splitDoc(record.content);
  let fmLines = d.fmLines;
  const values = { depends_on: serializeList(deps), depended_on_by: serializeList(rdeps), concepts: serializeList(cons) };
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

  return assembleDoc(fmLines, bodyLines);
}

function renderDependencies(model, prevContent) {
  const fm = [
    '---',
    'last_run: ' + fmField(prevContent, 'last_run', today()),
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
}

function renderIndex(model, conceptRecords, prevContent) {
  const fm = [
    '---',
    'last_run: ' + fmField(prevContent, 'last_run', today()),
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
  return fm.join('\n') + lines.join('\n') + '\n';
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

// Produce the full map of {relativePath: newContent} for all managed outputs.
function computeOutputs(docsDir, docSet) {
  const model = computeModel(docSet.modules, docSet.concepts);
  const decisionModel = computeDecisionModel(docSet.decisions);
  const outputs = {};
  docSet.modules.forEach(function (m) {
    outputs[m.file] = renderModuleManaged(m, model);
  });
  docSet.decisions.forEach(function (d) {
    outputs[d.file] = renderDecisionManaged(d, decisionModel);
  });
  const depsPath = path.join(docsDir, 'dependencies.md');
  const idxPath = path.join(docsDir, 'index.md');
  outputs['dependencies.md'] = renderDependencies(model, fs.existsSync(depsPath) ? fs.readFileSync(depsPath, 'utf8') : '');
  outputs['index.md'] = renderIndex(model, docSet.concepts, fs.existsSync(idxPath) ? fs.readFileSync(idxPath, 'utf8') : '');
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
  const linkRe = /\]\((\.\.\/concepts\/[^)]+|\.\/[^)]+|modules\/[^)]+|concepts\/[^)]+)\)/g;
  Object.keys(outputs).forEach(function (rel) {
    const dir = path.dirname(rel); // 'modules', 'concepts', or '.'
    const text = outputs[rel];
    let mm;
    while ((mm = linkRe.exec(text)) !== null) {
      let target = mm[1];
      const resolved = path.normalize(path.join(dir === '.' ? '' : dir, target));
      if (!known[resolved]) errors.push('dangling link in ' + rel + ': ' + target);
    }
  });

  // 4. Idempotence: re-parse outputs as input and recompute; expect no delta.
  const rebuiltModules = docSet.modules.map(function (m) {
    const c = outputs[m.file];
    return { file: m.file, slug: m.slug, content: c, fm: parseFm(splitDoc(c).fmLines) };
  });
  const model2 = computeModel(rebuiltModules, docSet.concepts);
  const outputs2 = {};
  rebuiltModules.forEach(function (m) { outputs2[m.file] = renderModuleManaged(m, model2); });
  rebuiltModules.forEach(function (m) {
    if (outputs2[m.file] !== outputs[m.file]) errors.push('idempotence: second pass differs for ' + m.file);
  });

  // 5. Idempotence for decisions: re-parse outputs as input and recompute; expect no delta.
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
  const computed = computeOutputs(absDir, docSet);
  const errors = validate(absDir, docSet, computed);
  if (errors.length) return { ok: false, errors: errors, written: [] };

  if (opts.check) return { ok: true, errors: [], written: [], pending: pendingChanges(absDir, computed.outputs) };

  // Transactional: everything validated; now flush changed files only.
  const written = [];
  Object.keys(computed.outputs).forEach(function (rel) {
    const abs = path.join(absDir, rel);
    const next = computed.outputs[rel];
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (prev !== next) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, next, 'utf8');
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

function decisionFixture(id, title, supersedes) {
  return '---\nid: ' + id + '\ntitle: ' + title + '\ndate: 2026-06-01\nstage: architect\n' +
    'affects_paths: [src/api]\nsupersedes: [' + supersedes.join(', ') + ']\n---\n\n' +
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
  // superseding one ancestor (003 <- 004, 003 <- 005).
  fs.writeFileSync(path.join(decs, 'adr-test-001.md'), decisionFixture('adr-test-001', 'Original choice', []), 'utf8');
  fs.writeFileSync(path.join(decs, 'adr-test-002.md'), decisionFixture('adr-test-002', 'Revised choice', ['adr-test-001']), 'utf8');
  fs.writeFileSync(path.join(decs, 'adr-test-003.md'), decisionFixture('adr-test-003', 'Ancestor choice', []), 'utf8');
  fs.writeFileSync(path.join(decs, 'adr-test-004.md'), decisionFixture('adr-test-004', 'First replacement', ['adr-test-003']), 'utf8');
  fs.writeFileSync(path.join(decs, 'adr-test-005.md'), decisionFixture('adr-test-005', 'Second replacement', ['adr-test-003']), 'utf8');

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
  fs.rmSync(tmp2, { recursive: true, force: true });

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
  const positional = args.filter(function (a) { return a.indexOf('--') !== 0; });
  const docsDir = positional[0];
  if (!docsDir) {
    process.stderr.write('Usage: node build-links.js [--check] <docs_dir> | --selftest\n');
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
