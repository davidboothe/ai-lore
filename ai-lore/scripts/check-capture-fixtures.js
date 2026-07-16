#!/usr/bin/env node
'use strict';

/*
 * check-capture-fixtures.js - golden-transcript acceptance gate for the decision
 * capture routine (skills/architect/SKILL.md and skills/plan-waves/SKILL.md).
 *
 * An LLM-driven routine cannot be re-run deterministically in a shell check, so
 * this script does NOT re-execute capture. It does two objective jobs:
 *
 *   1. Validate every expected decision fixture is a well-formed decision node
 *      (frontmatter parseable with id/title/date/stage/affects_paths; body has
 *      the three MADR headings: ## Context, ## Decision, ## Consequences).
 *   2. Validate each transcript's manifest is internally consistent: every
 *      declared-captured choice has exactly one matching expected decision
 *      file, and every declared-skipped choice has none.
 *
 * A human runs the capture routine against a transcript and eyeballs the
 * produced decisions against fixtures/decision-capture/expected/<transcript>/;
 * this script only guarantees the reference material itself is valid so that
 * comparison is meaningful. See fixtures/decision-capture/README.md.
 *
 * Usage:
 *   node scripts/check-capture-fixtures.js [fixtures-dir]
 *
 * fixtures-dir defaults to fixtures/decision-capture next to this script;
 * pass a path to point the gate at a scratch copy for testing the gate itself.
 *
 * Exit 0 when all fixtures are valid and consistent, non-zero with a specific
 * one-line stderr message on the first failure found.
 */

const fs = require('fs');
const path = require('path');

// An optional argv[2] overrides the fixtures directory, so this gate stays
// testable against a scratch copy without touching the repo's own fixtures.
const FIXTURES_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'fixtures', 'decision-capture');
const REQUIRED_FM_KEYS = ['id', 'title', 'date', 'stage', 'affects_paths'];
const REQUIRED_HEADINGS = ['## Context', '## Decision', '## Consequences'];
const MANIFEST_START = '<!-- MANIFEST-START -->';
const MANIFEST_END = '<!-- MANIFEST-END -->';
const MANIFEST_LINE_RE = /^(CAPTURED|SKIPPED)\s+id=(\S+)\s+choice="([^"]*)"$/;
// supersedes is optional, but when present each entry must look like a
// decision id (the capture routine's own id format), not an arbitrary string.
const SUPERSEDES_ID_RE = /^adr-[a-z0-9][a-z0-9-]*$/;

function fail(msg) {
  process.stderr.write('check-capture-fixtures: ' + msg + '\n');
  process.exit(1);
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    fail('cannot read ' + p + ': ' + err.message);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (flat scalars + flow-style lists only). This checker
// intentionally accepts ONLY flow-style lists, e.g. affects_paths: [a, b],
// because the capture routine mandates flow style for decision frontmatter.
// build-links.js separately tolerates block-style lists too, but a
// block-style list in one of these fixtures is a fixture error, not a
// format this checker should accept.
// ---------------------------------------------------------------------------

function splitDoc(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return null;
  return { fmLines: lines.slice(1, end), bodyLines: lines.slice(end + 1) };
}

function stripQuotes(s) {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
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
    const m = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
    if (m) fm[m[1]] = parseValue(m[2]);
  });
  return fm;
}

// ---------------------------------------------------------------------------
// Job 1: validate an expected decision fixture.
// ---------------------------------------------------------------------------

function validateDecisionFile(filePath) {
  const content = readFile(filePath);
  const split = splitDoc(content);
  if (!split) fail('malformed decision fixture (missing --- frontmatter block): ' + filePath);

  const fm = parseFm(split.fmLines);

  REQUIRED_FM_KEYS.forEach(function (key) {
    if (!(key in fm)) fail('decision fixture missing frontmatter key "' + key + '": ' + filePath);
  });
  if (typeof fm.id !== 'string' || fm.id.trim() === '') {
    fail('decision fixture has an empty "id": ' + filePath);
  }
  if (typeof fm.title !== 'string' || fm.title.trim() === '') {
    fail('decision fixture has an empty "title": ' + filePath);
  }
  if (typeof fm.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fm.date)) {
    fail('decision fixture "date" is not YYYY-MM-DD: ' + filePath);
  }
  if (fm.stage !== 'architect' && fm.stage !== 'plan-waves') {
    fail('decision fixture "stage" must be "architect" or "plan-waves", got "' + fm.stage + '": ' + filePath);
  }
  if (!Array.isArray(fm.affects_paths) || fm.affects_paths.length === 0) {
    fail('decision fixture "affects_paths" must be a non-empty list: ' + filePath);
  }
  // supersedes is not required (a decision may not supersede anything), but
  // when present it must be a flow-style list of decision ids. The referenced
  // id is not required to exist in this fixture set: it may legitimately
  // point at a decision outside the fixtures (see transcript-3's README note).
  if ('supersedes' in fm) {
    if (!Array.isArray(fm.supersedes)) {
      fail('decision fixture "supersedes" must be a flow-style list: ' + filePath);
    }
    fm.supersedes.forEach(function (id) {
      if (!SUPERSEDES_ID_RE.test(id)) {
        fail('decision fixture "supersedes" entry "' + id + '" is not a valid decision id: ' + filePath);
      }
    });
  }

  const body = split.bodyLines.join('\n');
  REQUIRED_HEADINGS.forEach(function (heading) {
    if (body.indexOf(heading) === -1) {
      fail('decision fixture missing required heading "' + heading + '": ' + filePath);
    }
  });

  return fm;
}

// ---------------------------------------------------------------------------
// Job 2: parse and validate a transcript manifest.
// ---------------------------------------------------------------------------

function extractManifestLines(content, transcriptPath) {
  const startIdx = content.indexOf(MANIFEST_START);
  const endIdx = content.indexOf(MANIFEST_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    fail('transcript missing a delimited ' + MANIFEST_START + ' / ' + MANIFEST_END + ' block: ' + transcriptPath);
  }
  if (content.indexOf(MANIFEST_START, startIdx + 1) !== -1) {
    fail('transcript contains more than one ' + MANIFEST_START + ' block: ' + transcriptPath);
  }
  if (content.indexOf(MANIFEST_END, endIdx + 1) !== -1) {
    fail('transcript contains more than one ' + MANIFEST_END + ' block: ' + transcriptPath);
  }
  const block = content.slice(startIdx + MANIFEST_START.length, endIdx);
  return block.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l !== ''; });
}

function parseManifest(content, transcriptPath) {
  const lines = extractManifestLines(content, transcriptPath);
  const entries = [];
  const seenIds = {};
  lines.forEach(function (line) {
    const m = line.match(MANIFEST_LINE_RE);
    if (!m) {
      fail('unparseable manifest line "' + line + '" in ' + transcriptPath);
    }
    const type = m[1] === 'CAPTURED' ? 'captured' : 'skipped';
    const id = m[2];
    const choice = m[3];
    if (seenIds[id]) {
      fail('duplicate manifest id "' + id + '" in ' + transcriptPath);
    }
    seenIds[id] = true;
    entries.push({ type: type, id: id, choice: choice });
  });
  if (entries.length === 0) {
    fail('manifest has no captured or skipped entries: ' + transcriptPath);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fail('fixtures directory not found: ' + FIXTURES_DIR);
  }

  const transcriptFiles = fs.readdirSync(FIXTURES_DIR)
    .filter(function (f) { return /^transcript-\d+\.md$/.test(f); })
    .sort();

  if (transcriptFiles.length === 0) {
    fail('no transcript-*.md fixtures found under ' + FIXTURES_DIR);
  }

  // Every expected/<name>/ directory must belong to a transcript-<name>.md;
  // an orphaned directory (renamed or leftover transcript) would otherwise
  // sit unexamined forever, since the main loop below is keyed off transcript
  // files, not expected directories.
  const expectedRootDir = path.join(FIXTURES_DIR, 'expected');
  if (fs.existsSync(expectedRootDir)) {
    fs.readdirSync(expectedRootDir).forEach(function (name) {
      if (!fs.statSync(path.join(expectedRootDir, name)).isDirectory()) return;
      const matchingTranscript = path.join(FIXTURES_DIR, name + '.md');
      if (!fs.existsSync(matchingTranscript)) {
        fail('orphaned expected directory "' + path.join('expected', name) +
          '" has no matching transcript file at ' + matchingTranscript);
      }
    });
  }

  let decisionsChecked = 0;

  transcriptFiles.forEach(function (fileName) {
    const transcriptId = fileName.replace(/\.md$/, '');
    const transcriptPath = path.join(FIXTURES_DIR, fileName);
    const content = readFile(transcriptPath);
    const entries = parseManifest(content, transcriptPath);

    const expectedDir = path.join(FIXTURES_DIR, 'expected', transcriptId);
    const capturedIds = {};

    entries.forEach(function (entry) {
      const expectedFile = path.join(expectedDir, entry.id + '.md');
      const exists = fs.existsSync(expectedFile);

      if (entry.type === 'captured') {
        if (!exists) {
          fail('manifest declares "' + entry.id + '" as captured but no expected decision file exists at ' +
            expectedFile + ' (transcript: ' + transcriptPath + ')');
        }
        const fm = validateDecisionFile(expectedFile);
        if (fm.id !== entry.id) {
          fail('expected decision file frontmatter id "' + fm.id + '" does not match manifest id "' +
            entry.id + '": ' + expectedFile);
        }
        capturedIds[entry.id] = true;
        decisionsChecked++;
      } else {
        if (exists) {
          fail('manifest declares "' + entry.id + '" as skipped but an expected decision file exists at ' +
            expectedFile + ' (transcript: ' + transcriptPath + ')');
        }
      }
    });

    if (fs.existsSync(expectedDir)) {
      const actualFiles = fs.readdirSync(expectedDir).filter(function (f) { return f.endsWith('.md'); });
      actualFiles.forEach(function (f) {
        const id = f.replace(/\.md$/, '');
        if (!capturedIds[id]) {
          fail('expected decision file ' + path.join(expectedDir, f) +
            ' has no matching "captured" entry in ' + transcriptPath);
        }
      });
    }
  });

  process.stdout.write('check-capture-fixtures: ' + transcriptFiles.length + ' transcripts, ' +
    decisionsChecked + ' expected decisions validated. OK\n');
  process.exit(0);
}

main();
