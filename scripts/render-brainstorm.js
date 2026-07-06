#!/usr/bin/env node
'use strict';

// Renders a brainstorm directory to a single self-contained index.html.
// Landing view is a dashboard (pitch, status badges, completion checklist, finding
// counts, brief.md); domain files render as collapsible sections; review findings
// render as filterable cards from review.json. Legacy dirs (no brief.md, no
// review.json, old team-review.md/adversarial.md reports) still render.

const fs   = require('fs');
const path = require('path');

const brainstormDir = process.argv[2];
if (!brainstormDir) {
  process.stderr.write('Usage: node render-brainstorm.js <brainstorm-dir>\n');
  process.exit(1);
}

const absDir = path.resolve(brainstormDir);
if (!fs.existsSync(absDir)) {
  process.stderr.write('Directory not found: ' + absDir + '\n');
  process.exit(1);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Gather inputs
// ---------------------------------------------------------------------------

const COMPLETION_KEYS = [
  { key: 'pitch_confirmed',             label: 'Pitch confirmed' },
  { key: 'primary_persona',             label: 'Primary persona' },
  { key: 'happy_path_covered',          label: 'Happy path covered' },
  { key: 'failure_path_covered',        label: 'Failure path covered' },
  { key: 'mvp_split',                   label: 'MVP split' },
  { key: 'success_measure',             label: 'Success measure' },
  { key: 'out_of_scope',                label: 'Out of scope recorded' },
  { key: 'blocking_questions_resolved', label: 'Blocking questions resolved' },
];

function yamlValue(src, key) {
  const m = src.match(new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm'));
  if (!m) return null;
  return m[1].split('#')[0].trim().replace(/^["']|["']$/g, '') || null;
}

let meta = { title: path.basename(absDir), status: null, size: null, feature: null, completion: null };
const yamlPath = path.join(absDir, 'brainstorm.yaml');
if (fs.existsSync(yamlPath)) {
  const src = fs.readFileSync(yamlPath, 'utf8');
  meta.title   = yamlValue(src, 'title')   || meta.title;
  meta.status  = yamlValue(src, 'status');
  meta.size    = yamlValue(src, 'size');
  meta.feature = yamlValue(src, 'feature');
  if (/^completion:/m.test(src)) {
    meta.completion = {};
    COMPLETION_KEYS.forEach(function(c) {
      const v = yamlValue(src, c.key);
      meta.completion[c.key] = v === 'true';
    });
  }
}

// review.json (structured findings written by ail-brainstorm step 9b)
let review = null;
const reviewJsonPath = path.join(absDir, 'review.json');
if (fs.existsSync(reviewJsonPath)) {
  try {
    review = JSON.parse(fs.readFileSync(reviewJsonPath, 'utf8'));
  } catch (e) {
    process.stderr.write('Warning: review.json is not valid JSON; rendering without it (' + e.message + ')\n');
  }
}

// Markdown sections. brief.md renders inside the dashboard, not as its own section.
// review.md is skipped when review.json is present (the cards replace it); legacy
// team-review.md / adversarial.md render whenever they exist.
const SECTION_DEFS = [
  { id: 'overview',       label: 'Overview',       file: 'overview.md' },
  { id: 'personas',       label: 'Personas',       file: 'personas.md' },
  { id: 'flows',          label: 'Flows',          file: 'flows.md' },
  { id: 'edge-cases',     label: 'Edge Cases',     file: 'edge-cases.md' },
  { id: 'constraints',    label: 'Constraints',    file: 'constraints.md' },
  { id: 'open-questions', label: 'Open Questions', file: 'open-questions.md' },
  { id: 'review-md',      label: 'Review Report',  file: 'review.md', skip: function() { return !!review; } },
  { id: 'team-review',    label: 'Team Review',    file: 'team-review.md' },
  { id: 'adversarial',    label: 'Adversarial',    file: 'adversarial.md' },
];

const sections = SECTION_DEFS
  .map(function(def) {
    if (def.skip && def.skip()) return null;
    const p = path.join(absDir, def.file);
    if (!fs.existsSync(p)) return null;
    return { id: def.id, label: def.label, md: fs.readFileSync(p, 'utf8') };
  })
  .filter(Boolean);

let brief = null;
const briefPath = path.join(absDir, 'brief.md');
if (fs.existsSync(briefPath)) brief = fs.readFileSync(briefPath, 'utf8');

if (!sections.length && !brief) {
  process.stderr.write('No brainstorm markdown files found in: ' + absDir + '\n');
  process.exit(1);
}

const payload = { meta: meta, brief: brief, sections: sections, review: review };
// Escape </script> to prevent early tag termination in the browser
const dataJson = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>');

// ---------------------------------------------------------------------------
// Client-side code (serialized into the page; runs in the browser).
// D, marked, and mermaid are globals there.
// ---------------------------------------------------------------------------

function clientMain() {
  var D = window.__BRAINSTORM__;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function mermaidify(root) {
    root.querySelectorAll('pre code.language-mermaid').forEach(function(code) {
      var div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = code.textContent;
      code.parentElement.replaceWith(div);
    });
  }

  var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'loose' });

  var main = document.querySelector('main');
  var navList = document.querySelector('#sidebar ul');
  function addNav(id, label) {
    navList.appendChild(el('<li><a href="#' + id + '">' + esc(label) + '</a></li>'));
  }

  // ---- Dashboard -----------------------------------------------------------
  var dash = el('<section id="dashboard" class="dash"></section>');
  main.appendChild(dash);
  addNav('dashboard', 'Dashboard');

  var m = D.meta || {};
  var h = '<h1>' + esc(m.title) + '</h1>';
  if (m.feature) h += '<p class="pitch">' + esc(m.feature) + '</p>';

  var badges = [];
  if (m.status) badges.push('<span class="badge badge-status">' + esc(m.status) + '</span>');
  if (m.size) badges.push('<span class="badge">' + esc(m.size) + '</span>');
  if (D.review) {
    var pe = (D.review.personas_expected || []).length + (D.review.modes_expected || []).length;
    var pr = (D.review.personas_returned || []).length + (D.review.modes_returned || []).length;
    badges.push('<span class="badge' + (pr < pe ? ' badge-warn' : '') + '">review ' + pr + '/' + pe + '</span>');
  }
  if (badges.length) h += '<div class="badges">' + badges.join('') + '</div>';

  if (m.completion) {
    var labels = {
      pitch_confirmed: 'Pitch confirmed', primary_persona: 'Primary persona',
      happy_path_covered: 'Happy path covered', failure_path_covered: 'Failure path covered',
      mvp_split: 'MVP split', success_measure: 'Success measure',
      out_of_scope: 'Out of scope recorded', blocking_questions_resolved: 'Blocking questions resolved'
    };
    var done = 0, total = 0, items = '';
    Object.keys(labels).forEach(function(k) {
      total++;
      var ok = !!m.completion[k];
      if (ok) done++;
      items += '<li class="' + (ok ? 'ok' : 'nope') + '">' + (ok ? '&#10003;' : '&#10007;') + ' ' + esc(labels[k]) + '</li>';
    });
    h += '<div class="panel"><div class="panel-head">Completion contract <span class="count">' + done + '/' + total + '</span></div><ul class="checklist">' + items + '</ul></div>';
  }

  if (D.review && (D.review.findings || []).length) {
    var f = D.review.findings;
    var counts = { blocking: 0, advisory: 0, accepted: 0, rejected: 0, deferred: 0, pending: 0 };
    f.forEach(function(x) {
      counts[x.severity] = (counts[x.severity] || 0) + 1;
      counts[x.disposition] = (counts[x.disposition] || 0) + 1;
    });
    h += '<div class="panel"><div class="panel-head">Findings</div><div class="chips">' +
      '<a href="#review" class="chip chip-blocking">' + counts.blocking + ' blocking</a>' +
      '<a href="#review" class="chip">' + counts.advisory + ' advisory</a>' +
      '<a href="#review" class="chip chip-ok">' + counts.accepted + ' accepted</a>' +
      '<a href="#review" class="chip">' + counts.rejected + ' rejected</a>' +
      '<a href="#review" class="chip">' + counts.deferred + ' deferred</a>' +
      (counts.pending ? '<a href="#review" class="chip chip-warn">' + counts.pending + ' pending</a>' : '') +
      '</div></div>';
  }

  dash.innerHTML = h;

  if (D.brief) {
    var briefDiv = el('<div class="brief"></div>');
    briefDiv.innerHTML = marked.parse(D.brief);
    var bh1 = briefDiv.querySelector('h1');
    if (bh1) bh1.remove(); // dashboard already has the title
    mermaidify(briefDiv);
    dash.appendChild(briefDiv);
  } else {
    dash.appendChild(el('<p class="muted">brief.md has not been written yet; the one-page synthesis appears here once the brainstorm reaches that step.</p>'));
  }

  // ---- Collapsible domain sections ----------------------------------------
  (D.sections || []).forEach(function(s) {
    addNav(s.id, s.label);
    var sec = el(
      '<section id="' + s.id + '" class="sec">' +
      '<div class="sec-head" role="button" tabindex="0"><span class="chev">&#9656;</span><h2>' + esc(s.label) + '</h2></div>' +
      '<div class="sec-body"></div></section>'
    );
    var body = sec.querySelector('.sec-body');
    body.innerHTML = marked.parse(s.md);
    var sh1 = body.querySelector('h1');
    if (sh1) sh1.remove(); // section header already carries the label
    mermaidify(body);
    sec.querySelector('.sec-head').addEventListener('click', function() {
      sec.classList.toggle('collapsed');
    });
    main.appendChild(sec);
  });

  // ---- Review findings cards -----------------------------------------------
  if (D.review) {
    addNav('review', 'Review Findings');
    var r = D.review;
    var sec = el('<section id="review"><h2>Review Findings</h2></section>');

    var missing = [];
    (r.personas_expected || []).forEach(function(p) {
      if ((r.personas_returned || []).indexOf(p) < 0) missing.push(p);
    });
    (r.modes_expected || []).forEach(function(md) {
      if ((r.modes_returned || []).indexOf(md) < 0) missing.push(md);
    });
    if (missing.length) {
      sec.appendChild(el('<div class="callout">Partial review: ' + esc(missing.join(', ')) + ' did not return a result.</div>'));
    }

    var filters = el(
      '<div class="filters">' +
      '<span class="flabel">Severity</span>' +
      '<button class="fbtn active" data-group="sev" data-val="all">all</button>' +
      '<button class="fbtn" data-group="sev" data-val="blocking">blocking</button>' +
      '<button class="fbtn" data-group="sev" data-val="advisory">advisory</button>' +
      '<span class="flabel">Disposition</span>' +
      '<button class="fbtn active" data-group="dis" data-val="all">all</button>' +
      '<button class="fbtn" data-group="dis" data-val="pending">pending</button>' +
      '<button class="fbtn" data-group="dis" data-val="accepted">accepted</button>' +
      '<button class="fbtn" data-group="dis" data-val="rejected">rejected</button>' +
      '<button class="fbtn" data-group="dis" data-val="deferred">deferred</button>' +
      '</div>'
    );
    sec.appendChild(filters);

    var byOrigin = {};
    var originOrder = [];
    (r.findings || []).forEach(function(x) {
      if (!byOrigin[x.origin]) { byOrigin[x.origin] = []; originOrder.push(x.origin); }
      byOrigin[x.origin].push(x);
    });

    originOrder.forEach(function(origin) {
      var list = byOrigin[origin];
      var grp = el('<div class="fgroup"><h3>' + esc(origin) + ' <span class="count">' + list.length + '</span></h3></div>');
      list.forEach(function(x) {
        var card = el(
          '<div class="card" data-sev="' + esc(x.severity) + '" data-dis="' + esc(x.disposition || 'pending') + '">' +
          '<div class="card-head">' +
          '<span class="badge badge-' + esc(x.severity) + '">' + esc(x.severity) + '</span>' +
          '<span class="badge badge-dis-' + esc(x.disposition || 'pending') + '">' + esc(x.disposition || 'pending') + '</span>' +
          '<span class="fid">' + esc(x.id || '') + '</span>' +
          '<span class="files">' + esc((x.files || []).join(', ')) + '</span>' +
          '</div>' +
          '<p>' + esc(x.description) + '</p>' +
          (x.implication ? '<p class="dim"><strong>Implication:</strong> ' + esc(x.implication) + '</p>' : '') +
          (x.suggestion ? '<p class="dim"><strong>Suggestion:</strong> ' + esc(x.suggestion) + '</p>' : '') +
          (x.note ? '<p class="dim"><strong>Note:</strong> ' + esc(x.note) + '</p>' : '') +
          '</div>'
        );
        grp.appendChild(card);
      });
      sec.appendChild(grp);
    });

    if ((r.open_questions || []).length) {
      var oq = '<h3>Open questions raised</h3><ul>';
      r.open_questions.forEach(function(q) { oq += '<li>' + esc(q) + '</li>'; });
      sec.appendChild(el('<div class="fgroup">' + oq + '</ul></div>'));
    }
    if ((r.suggested_additions || []).length) {
      var sa = '<h3>Suggested additions</h3><ul>';
      r.suggested_additions.forEach(function(q) { sa += '<li>' + esc(q) + '</li>'; });
      sec.appendChild(el('<div class="fgroup">' + sa + '</ul></div>'));
    }

    main.appendChild(sec);

    var state = { sev: 'all', dis: 'all' };
    filters.addEventListener('click', function(e) {
      var b = e.target.closest('.fbtn');
      if (!b) return;
      state[b.dataset.group] = b.dataset.val;
      filters.querySelectorAll('.fbtn[data-group="' + b.dataset.group + '"]').forEach(function(x) {
        x.classList.toggle('active', x === b);
      });
      sec.querySelectorAll('.card').forEach(function(c) {
        var show = (state.sev === 'all' || c.dataset.sev === state.sev) &&
                   (state.dis === 'all' || c.dataset.dis === state.dis);
        c.classList.toggle('hidden', !show);
      });
      sec.querySelectorAll('.fgroup').forEach(function(g) {
        var cards = g.querySelectorAll('.card');
        if (!cards.length) return; // question/addition groups always show
        var visible = g.querySelectorAll('.card:not(.hidden)').length;
        g.classList.toggle('hidden', visible === 0);
      });
    });
  }

  // ---- Expand/collapse controls --------------------------------------------
  var ctl = el(
    '<div class="expand-ctl">' +
    '<button id="expand-all">expand all</button>' +
    '<button id="collapse-all">collapse all</button>' +
    '</div>'
  );
  document.getElementById('sidebar').appendChild(ctl);
  document.getElementById('expand-all').addEventListener('click', function() {
    document.querySelectorAll('.sec').forEach(function(s) { s.classList.remove('collapsed'); });
  });
  document.getElementById('collapse-all').addEventListener('click', function() {
    document.querySelectorAll('.sec').forEach(function(s) { s.classList.add('collapsed'); });
  });

  // Render mermaid while everything is visible, then collapse the domain
  // sections (mermaid sizes diagrams at render time; hiding them afterward is safe).
  function collapseAll() {
    document.querySelectorAll('.sec').forEach(function(s) { s.classList.add('collapsed'); });
  }
  try {
    var run = mermaid.run();
    if (run && run.then) { run.then(collapseAll, collapseAll); } else { collapseAll(); }
  } catch (e) { collapseAll(); }

  // Nav: expand the target section on click; track the active section on scroll.
  navList.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (!a) return;
    var target = document.querySelector(a.getAttribute('href'));
    if (target && target.classList.contains('sec')) target.classList.remove('collapsed');
  });
  var obs = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting)
        document.querySelectorAll('#sidebar a').forEach(function(a) {
          a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id);
        });
    });
  }, { rootMargin: '-5% 0px -80% 0px' });
  document.querySelectorAll('main section').forEach(function(s) { obs.observe(s); });
}

// ---------------------------------------------------------------------------
// Assemble the page
// ---------------------------------------------------------------------------

// Split closing tags so editors and linters do not misparse this source file
const CS = '<' + '/script>';
const CT = '<' + '/style>';

const css = [
  ':root {',
  '  --bg: #ffffff; --surface: #f8f9fa; --border: #e2e8f0;',
  '  --text: #1a202c; --muted: #718096; --accent: #4f46e5;',
  '  --ok: #16a34a; --bad: #dc2626; --warn: #d97706;',
  '  --sidebar-w: 240px;',
  '}',
  '@media (prefers-color-scheme: dark) {',
  '  :root {',
  '    --bg: #0f172a; --surface: #1e293b; --border: #334155;',
  '    --text: #e2e8f0; --muted: #94a3b8; --accent: #818cf8;',
  '    --ok: #4ade80; --bad: #f87171; --warn: #fbbf24;',
  '  }',
  '}',
  '* { box-sizing: border-box; margin: 0; padding: 0; }',
  'body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); display: grid; grid-template-columns: var(--sidebar-w) 1fr; min-height: 100vh; }',
  '#sidebar { position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 24px 16px; background: var(--surface); border-right: 1px solid var(--border); }',
  '#sidebar .brand { font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); margin-bottom: 4px; }',
  '#sidebar .title { font-size: 14px; font-weight: 600; margin-bottom: 20px; line-height: 1.4; }',
  '#sidebar ul { list-style: none; }',
  '#sidebar li { margin-bottom: 2px; }',
  '#sidebar a { display: block; padding: 6px 10px; border-radius: 6px; font-size: 13px; color: var(--muted); text-decoration: none; transition: background .1s, color .1s; }',
  '#sidebar a:hover { background: var(--border); color: var(--text); }',
  '#sidebar a.active { background: var(--accent); color: #fff; }',
  '.expand-ctl { margin-top: 20px; display: flex; gap: 6px; }',
  '.expand-ctl button { flex: 1; font-size: 11px; padding: 5px 4px; border: 1px solid var(--border); border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }',
  '.expand-ctl button:hover { color: var(--text); border-color: var(--muted); }',
  'main { padding: 48px 64px; max-width: 900px; }',
  'section { margin-bottom: 48px; scroll-margin-top: 24px; }',
  'h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; line-height: 1.3; }',
  'h2 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }',
  'h3 { font-size: 16px; font-weight: 600; margin: 24px 0 8px; }',
  'p { line-height: 1.75; margin-bottom: 12px; }',
  'ul, ol { padding-left: 22px; margin-bottom: 12px; }',
  'li { line-height: 1.7; margin-bottom: 2px; }',
  "code { font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace; font-size: .875em; background: var(--surface); padding: 2px 5px; border-radius: 4px; }",
  'pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; overflow-x: auto; margin-bottom: 16px; }',
  'pre code { background: none; padding: 0; font-size: .85em; }',
  'blockquote { border-left: 3px solid var(--accent); padding: 4px 0 4px 16px; color: var(--muted); margin-bottom: 12px; }',
  'table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 14px; }',
  'th, td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; }',
  'th { background: var(--surface); font-weight: 600; }',
  '.mermaid { margin: 24px 0; display: flex; justify-content: center; overflow-x: auto; }',
  'hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }',
  'a { color: var(--accent); }',
  '.muted, .dim { color: var(--muted); }',
  '.hidden { display: none; }',
  /* dashboard */
  '.pitch { font-size: 16px; color: var(--muted); margin-bottom: 12px; }',
  '.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 20px; }',
  '.badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; background: var(--surface); border: 1px solid var(--border); color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }',
  '.badge-status { border-color: var(--accent); color: var(--accent); }',
  '.badge-warn { border-color: var(--warn); color: var(--warn); }',
  '.badge-blocking { border-color: var(--bad); color: var(--bad); }',
  '.badge-advisory { border-color: var(--border); }',
  '.badge-dis-accepted { border-color: var(--ok); color: var(--ok); }',
  '.badge-dis-pending { border-color: var(--warn); color: var(--warn); }',
  '.panel { border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px; margin-bottom: 16px; background: var(--surface); }',
  '.panel-head { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 10px; }',
  '.panel-head .count { float: right; }',
  '.checklist { list-style: none; padding: 0; margin: 0; columns: 2; }',
  '.checklist li { font-size: 13px; margin-bottom: 4px; break-inside: avoid; }',
  '.checklist li.ok { color: var(--ok); }',
  '.checklist li.nope { color: var(--bad); }',
  '.chips { display: flex; flex-wrap: wrap; gap: 6px; }',
  '.chip { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); text-decoration: none; color: var(--muted); }',
  '.chip-blocking { border-color: var(--bad); color: var(--bad); }',
  '.chip-ok { border-color: var(--ok); color: var(--ok); }',
  '.chip-warn { border-color: var(--warn); color: var(--warn); }',
  '.brief { border-top: 1px solid var(--border); padding-top: 16px; margin-top: 8px; }',
  /* collapsible sections */
  '.sec-head { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); user-select: none; }',
  '.sec-head h2 { margin: 0; font-size: 17px; }',
  '.sec-head .chev { color: var(--muted); transition: transform .12s; transform: rotate(90deg); }',
  '.sec.collapsed .sec-head .chev { transform: rotate(0deg); }',
  '.sec-body { padding: 18px 12px 0; }',
  '.sec.collapsed .sec-body { display: none; }',
  /* findings */
  '.callout { border: 1px solid var(--warn); color: var(--warn); border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 14px; }',
  '.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 18px; }',
  '.flabel { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-left: 8px; }',
  '.flabel:first-child { margin-left: 0; }',
  '.fbtn { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: none; color: var(--muted); cursor: pointer; }',
  '.fbtn.active { background: var(--accent); border-color: var(--accent); color: #fff; }',
  '.fgroup h3 { margin-top: 20px; }',
  '.fgroup .count { font-size: 12px; color: var(--muted); font-weight: 400; }',
  '.card { border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; margin: 10px 0; }',
  '.card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }',
  '.card-head .fid { font-size: 12px; color: var(--muted); font-weight: 600; }',
  '.card-head .files { font-size: 12px; color: var(--muted); font-family: ui-monospace, monospace; margin-left: auto; }',
  '.card p { font-size: 14px; margin-bottom: 6px; }',
  '@media (max-width: 768px) {',
  '  body { grid-template-columns: 1fr; }',
  '  #sidebar { position: static; height: auto; }',
  '  main { padding: 24px; }',
  '  .checklist { columns: 1; }',
  '}',
].join('\n    ');

const html = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'  <title>' + escapeHtml(meta.title) + '</title>\n' +
'  <script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js">' + CS + '\n' +
'  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js">' + CS + '\n' +
'  <style>\n    ' + css + '\n  ' + CT + '\n' +
'</head>\n' +
'<body>\n' +
'  <nav id="sidebar">\n' +
'    <div class="brand">ai-lore brainstorm</div>\n' +
'    <div class="title">' + escapeHtml(meta.title) + '</div>\n' +
'    <ul></ul>\n' +
'  </nav>\n' +
'  <main></main>\n' +
'  <script>\n' +
'    window.__BRAINSTORM__ = ' + dataJson + ';\n' +
'    (' + clientMain.toString() + ')();\n' +
'  ' + CS + '\n' +
'</body>\n' +
'</html>';

const outPath = path.join(absDir, 'index.html');
fs.writeFileSync(outPath, html, 'utf8');
process.stdout.write(outPath + '\n');
