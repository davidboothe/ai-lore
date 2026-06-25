#!/usr/bin/env node
'use strict';

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

const SECTION_DEFS = [
  { id: 'overview',       label: 'Overview',       file: 'overview.md' },
  { id: 'personas',       label: 'Personas',       file: 'personas.md' },
  { id: 'flows',          label: 'Flows',          file: 'flows.md' },
  { id: 'edge-cases',     label: 'Edge Cases',     file: 'edge-cases.md' },
  { id: 'technical',      label: 'Technical',      file: 'technical.md' },
  { id: 'open-questions', label: 'Open Questions', file: 'open-questions.md' },
  { id: 'team-review',    label: 'Team Review',    file: 'team-review.md' },
  { id: 'adversarial',    label: 'Adversarial',    file: 'adversarial.md' },
];

// Read title from brainstorm.yaml
let title = path.basename(absDir);
const yamlPath = path.join(absDir, 'brainstorm.yaml');
if (fs.existsSync(yamlPath)) {
  const m = fs.readFileSync(yamlPath, 'utf8').match(/^title:\s*(.+)$/m);
  if (m) title = m[1].trim().replace(/^["']|["']$/g, '');
}

const sections = SECTION_DEFS
  .map(function(def) {
    const p = path.join(absDir, def.file);
    if (!fs.existsSync(p)) return null;
    return { id: def.id, label: def.label, content: fs.readFileSync(p, 'utf8') };
  })
  .filter(Boolean);

if (!sections.length) {
  process.stderr.write('No brainstorm markdown files found in: ' + absDir + '\n');
  process.exit(1);
}

// Encode content as JSON; escape </script> to prevent early tag termination in the browser
const dataJson = JSON.stringify(
  sections.reduce(function(acc, s) { acc[s.id] = s.content; return acc; }, {})
).replace(/<\/script>/gi, '<\\/script>');

const nav = sections
  .map(function(s) {
    return '      <li><a href="#' + s.id + '">' + escapeHtml(s.label) + '</a></li>';
  })
  .join('\n');

const mainSections = sections
  .map(function(s) { return '    <section id="' + s.id + '"></section>'; })
  .join('\n');

// Split closing tags so editors and linters do not misparse this source file
const CS = '<' + '/script>';
const CT = '<' + '/style>';

const html = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'  <title>' + escapeHtml(title) + '</title>\n' +
'  <script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js">' + CS + '\n' +
'  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js">' + CS + '\n' +
'  <style>\n' +
'    :root {\n' +
'      --bg: #ffffff; --surface: #f8f9fa; --border: #e2e8f0;\n' +
'      --text: #1a202c; --muted: #718096; --accent: #4f46e5;\n' +
'      --sidebar-w: 240px;\n' +
'    }\n' +
'    @media (prefers-color-scheme: dark) {\n' +
'      :root {\n' +
'        --bg: #0f172a; --surface: #1e293b; --border: #334155;\n' +
'        --text: #e2e8f0; --muted: #94a3b8; --accent: #818cf8;\n' +
'      }\n' +
'    }\n' +
'    * { box-sizing: border-box; margin: 0; padding: 0; }\n' +
'    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); display: grid; grid-template-columns: var(--sidebar-w) 1fr; min-height: 100vh; }\n' +
'    #sidebar { position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 24px 16px; background: var(--surface); border-right: 1px solid var(--border); }\n' +
'    #sidebar .brand { font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); margin-bottom: 4px; }\n' +
'    #sidebar .title { font-size: 14px; font-weight: 600; margin-bottom: 20px; line-height: 1.4; }\n' +
'    #sidebar ul { list-style: none; }\n' +
'    #sidebar li { margin-bottom: 2px; }\n' +
'    #sidebar a { display: block; padding: 6px 10px; border-radius: 6px; font-size: 13px; color: var(--muted); text-decoration: none; transition: background .1s, color .1s; }\n' +
'    #sidebar a:hover { background: var(--border); color: var(--text); }\n' +
'    #sidebar a.active { background: var(--accent); color: #fff; }\n' +
'    main { padding: 48px 64px; max-width: 860px; }\n' +
'    section { margin-bottom: 80px; scroll-margin-top: 24px; }\n' +
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
'    @media (max-width: 768px) {\n' +
'      body { grid-template-columns: 1fr; }\n' +
'      #sidebar { position: static; height: auto; }\n' +
'      main { padding: 24px; }\n' +
'    }\n' +
'  ' + CT + '\n' +
'</head>\n' +
'<body>\n' +
'  <nav id="sidebar">\n' +
'    <div class="brand">ai-lore brainstorm</div>\n' +
'    <div class="title">' + escapeHtml(title) + '</div>\n' +
'    <ul>\n' +
nav + '\n' +
'    </ul>\n' +
'  </nav>\n' +
'  <main>\n' +
mainSections + '\n' +
'  </main>\n' +
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

const outPath = path.join(absDir, 'index.html');
fs.writeFileSync(outPath, html, 'utf8');
process.stdout.write(outPath + '\n');
