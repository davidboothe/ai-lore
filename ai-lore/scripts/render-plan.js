#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const planDir = process.argv[2];
if (!planDir) {
  process.stderr.write('Usage: node render-plan.js <plan-dir>\n');
  process.exit(1);
}

const absDir = path.resolve(planDir);
if (!fs.existsSync(absDir)) {
  process.stderr.write('Directory not found: ' + absDir + '\n');
  process.exit(1);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripFrontmatter(content) {
  const m = content.match(/^---\r?\n[\s\S]*?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : content;
}

function extractFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}

function fmScalar(fm, key) {
  const m = fm.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'));
  if (!m) return '';
  return m[1].trim().replace(/^["']|["']$/g, '');
}

// Read plan.md
const planPath = path.join(absDir, 'plan.md');
if (!fs.existsSync(planPath)) {
  process.stderr.write('plan.md not found in: ' + absDir + '\n');
  process.exit(1);
}

const planRaw  = fs.readFileSync(planPath, 'utf8');
const planFm   = extractFrontmatter(planRaw);
const planBody = stripFrontmatter(planRaw);

const planTitle   = fmScalar(planFm, 'title')   || path.basename(absDir);
const planStatus  = fmScalar(planFm, 'status')  || 'pending';
const planCreated = fmScalar(planFm, 'created') || '';
const planSlug    = fmScalar(planFm, 'slug')    || path.basename(absDir);

// Read task files
const tasksDir = path.join(absDir, 'tasks');
var tasks = [];
if (fs.existsSync(tasksDir)) {
  tasks = fs.readdirSync(tasksDir)
    .filter(function(f) { return f.endsWith('.md'); })
    .sort()
    .map(function(file) {
      const raw  = fs.readFileSync(path.join(tasksDir, file), 'utf8');
      const fm   = extractFrontmatter(raw);
      const body = stripFrontmatter(raw);
      return {
        id:     fmScalar(fm, 'id')     || file.replace(/\.md$/, ''),
        wave:   fmScalar(fm, 'wave')   || '?',
        title:  fmScalar(fm, 'title')  || file.replace(/\.md$/, ''),
        status: fmScalar(fm, 'status') || 'pending',
        body:   body,
      };
    });
}

// Group tasks by wave, preserving order of first appearance
var waveOrder = [];
var waveMap   = {};
tasks.forEach(function(t) {
  if (!waveMap[t.wave]) {
    waveOrder.push(t.wave);
    waveMap[t.wave] = [];
  }
  waveMap[t.wave].push(t);
});

function statusColor(s) {
  var colors = {
    pending:     '#94a3b8',
    in_progress: '#f59e0b',
    blocked:     '#ef4444',
    complete:    '#22c55e',
  };
  return colors[s] || '#94a3b8';
}

function statusBadge(s) {
  return '<span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;background:' +
    statusColor(s) + ';color:#fff;">' + escapeHtml(s) + '</span>';
}

// Build sidebar nav
var navParts = ['<li><a href="#plan-overview">Plan Overview</a></li>'];
waveOrder.forEach(function(waveId) {
  navParts.push('<li class="wave-label">Wave ' + escapeHtml(waveId) + '</li>');
  waveMap[waveId].forEach(function(t) {
    navParts.push(
      '<li><a href="#task-' + escapeHtml(t.id) + '" class="task-link">' +
      escapeHtml(t.id) + ' ' + escapeHtml(t.title) +
      '</a></li>'
    );
  });
});

// Build section placeholders
var sectionParts = ['<section id="plan-overview"></section>'];
tasks.forEach(function(t) {
  sectionParts.push('<section id="task-' + escapeHtml(t.id) + '"></section>');
});

// Build data map for client-side rendering
var dataMap = {};
dataMap['plan-overview'] = planBody;
tasks.forEach(function(t) { dataMap['task-' + t.id] = t.body; });

// Encode content; escape </script> to prevent early tag termination
var CS = '<' + '/script>';
var CT = '<' + '/style>';
var dataJson = JSON.stringify(dataMap).replace(/<\/script>/gi, '<\\/script>');

var metaLine = 'Status: ' + statusBadge(planStatus);
if (planCreated) metaLine += ' &nbsp; Created: ' + escapeHtml(planCreated);

var html =
'<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'  <title>' + escapeHtml(planTitle) + ' -- Plan</title>\n' +
'  <script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js">' + CS + '\n' +
'  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js">' + CS + '\n' +
'  <style>\n' +
'    :root {\n' +
'      --bg: #ffffff; --surface: #f8f9fa; --border: #e2e8f0;\n' +
'      --text: #1a202c; --muted: #718096; --accent: #4f46e5;\n' +
'      --warn-bg: #fffbeb; --warn-border: #f59e0b; --warn-text: #92400e;\n' +
'      --sidebar-w: 260px;\n' +
'    }\n' +
'    @media (prefers-color-scheme: dark) {\n' +
'      :root {\n' +
'        --bg: #0f172a; --surface: #1e293b; --border: #334155;\n' +
'        --text: #e2e8f0; --muted: #94a3b8; --accent: #818cf8;\n' +
'        --warn-bg: #1c1400; --warn-border: #f59e0b; --warn-text: #fbbf24;\n' +
'      }\n' +
'    }\n' +
'    * { box-sizing: border-box; margin: 0; padding: 0; }\n' +
'    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); display: grid; grid-template-columns: var(--sidebar-w) 1fr; min-height: 100vh; }\n' +
'    #sidebar { position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 24px 16px; background: var(--surface); border-right: 1px solid var(--border); }\n' +
'    .brand { font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); margin-bottom: 4px; }\n' +
'    .plan-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; line-height: 1.4; }\n' +
'    .plan-meta { font-size: 11px; color: var(--muted); margin-bottom: 16px; }\n' +
'    #sidebar ul { list-style: none; }\n' +
'    #sidebar li { margin-bottom: 2px; }\n' +
'    .wave-label { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); padding: 10px 10px 2px; font-weight: 600; }\n' +
'    #sidebar a { display: block; padding: 5px 10px; border-radius: 6px; font-size: 12px; color: var(--muted); text-decoration: none; transition: background .1s, color .1s; }\n' +
'    #sidebar a:hover { background: var(--border); color: var(--text); }\n' +
'    #sidebar a.active { background: var(--accent); color: #fff; }\n' +
'    .task-link { padding-left: 18px !important; }\n' +
'    #content-wrapper { display: flex; flex-direction: column; overflow-y: auto; }\n' +
'    #warning-banner { position: sticky; top: 0; z-index: 10; background: var(--warn-bg); border-bottom: 2px solid var(--warn-border); color: var(--warn-text); padding: 10px 48px; font-size: 13px; font-weight: 500; }\n' +
'    #warning-banner code { font-family: ui-monospace, monospace; font-size: 12px; background: rgba(0,0,0,.08); padding: 1px 4px; border-radius: 3px; }\n' +
'    main { padding: 48px 64px; max-width: 900px; }\n' +
'    section { margin-bottom: 80px; scroll-margin-top: 52px; }\n' +
'    h1 { font-size: 28px; font-weight: 700; margin-bottom: 16px; line-height: 1.3; }\n' +
'    h2 { font-size: 20px; font-weight: 600; margin: 32px 0 12px; }\n' +
'    h3 { font-size: 16px; font-weight: 600; margin: 24px 0 8px; }\n' +
'    p { line-height: 1.75; margin-bottom: 12px; }\n' +
'    ul, ol { padding-left: 22px; margin-bottom: 12px; }\n' +
'    li { line-height: 1.7; margin-bottom: 2px; }\n' +
"    code { font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace; font-size: .875em; background: var(--surface); padding: 2px 5px; border-radius: 4px; }\n" +
'    pre { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; overflow-x: auto; margin-bottom: 16px; }\n' +
'    pre code { background: none; padding: 0; font-size: .85em; }\n' +
'    blockquote { border-left: 3px solid var(--accent); padding: 4px 0 4px 16px; color: var(--muted); margin-bottom: 12px; }\n' +
'    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 14px; }\n' +
'    th, td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; }\n' +
'    th { background: var(--surface); font-weight: 600; }\n' +
'    .mermaid { margin: 24px 0; display: flex; justify-content: center; overflow-x: auto; }\n' +
'    hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }\n' +
'    a { color: var(--accent); }\n' +
'    input[type="checkbox"] { margin-right: 6px; }\n' +
'    @media (max-width: 768px) {\n' +
'      body { grid-template-columns: 1fr; }\n' +
'      #sidebar { position: static; height: auto; }\n' +
'      main { padding: 24px; }\n' +
'      #warning-banner { padding: 10px 24px; }\n' +
'    }\n' +
'  ' + CT + '\n' +
'</head>\n' +
'<body>\n' +
'  <nav id="sidebar">\n' +
'    <div class="brand">ai-lore plan</div>\n' +
'    <div class="plan-title">' + escapeHtml(planTitle) + '</div>\n' +
'    <div class="plan-meta">' + metaLine + '</div>\n' +
'    <ul>\n' +
navParts.join('\n') + '\n' +
'    </ul>\n' +
'  </nav>\n' +
'  <div id="content-wrapper">\n' +
'    <div id="warning-banner">\n' +
'      Read-only preview -- do not edit this file.\n' +
'      Edit the source files under <code>.ai-lore/plans/' + escapeHtml(planSlug) + '/</code> instead;\n' +
'      this HTML is overwritten each time the plan is updated.\n' +
'    </div>\n' +
'    <main>\n' +
sectionParts.join('\n') + '\n' +
'    </main>\n' +
'  </div>\n' +
'  <script>\n' +
'    var D = ' + dataJson + ';\n' +
'    var dark = window.matchMedia(\'(prefers-color-scheme: dark)\').matches;\n' +
'    mermaid.initialize({ startOnLoad: false, theme: dark ? \'dark\' : \'default\', securityLevel: \'loose\' });\n' +
'\n' +
'    Object.keys(D).forEach(function(id) {\n' +
'      var el = document.getElementById(id);\n' +
'      if (!el) return;\n' +
'      el.innerHTML = marked.parse(D[id]);\n' +
'      el.querySelectorAll(\'pre code\').forEach(function(code) {\n' +
'        if (code.classList.contains(\'language-mermaid\')) {\n' +
'          var div = document.createElement(\'div\');\n' +
'          div.className = \'mermaid\';\n' +
'          div.textContent = code.textContent;\n' +
'          code.parentElement.replaceWith(div);\n' +
'        }\n' +
'      });\n' +
'    });\n' +
'\n' +
'    mermaid.run();\n' +
'\n' +
'    var obs = new IntersectionObserver(function(entries) {\n' +
'      entries.forEach(function(e) {\n' +
'        if (e.isIntersecting)\n' +
'          document.querySelectorAll(\'#sidebar a\').forEach(function(a) {\n' +
'            a.classList.toggle(\'active\', a.getAttribute(\'href\') === \'#\' + e.target.id);\n' +
'          });\n' +
'      });\n' +
'    }, { rootMargin: \'-5% 0px -80% 0px\' });\n' +
'\n' +
'    document.querySelectorAll(\'main section\').forEach(function(s) { obs.observe(s); });\n' +
'  ' + CS + '\n' +
'</body>\n' +
'</html>';

var outPath = path.join(absDir, 'plan.html');
fs.writeFileSync(outPath, html, 'utf8');
process.stdout.write(outPath + '\n');
