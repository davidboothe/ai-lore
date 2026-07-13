---
name: ail-document
description: Document a codebase as a concept-first knowledge graph. Scans directories, fans out parallel agents to produce a capped per-directory reference, synthesizes dense cross-directory concept docs (recipes, gotchas, key files), and links everything into a traversable graph under .ai-lore-docs/. Edges live in frontmatter; a deterministic linker computes back-edges, cycles, coupling, and a path lookup index, and also processes the committed decisions node set (supersession, module/concept Decisions sections, the decisions.md aggregate). Tracks the last-documented commit in .ai-lore-docs/state.yaml; on later runs detects what changed and offers a targeted update or full re-doc. Codebase-agnostic. Requires Node.js. e.g. "/ail-document", "/ail-document src/api", "/ail-document src/api src/models --include-tests".
---

# ail-document

Document a codebase as an interlinked, concept-first knowledge graph. Concept docs are the dense, primary agent entry point (recipes, gotchas, key files across directories); per-directory module docs are the capped file-level reference. The docs are the graph: edges live in frontmatter, neighbors are markdown links. Outputs are committed markdown under `.ai-lore-docs/`.

The graph has three node types: module docs (`.ai-lore-docs/modules/`), concept docs (`.ai-lore-docs/concepts/`), and decision nodes (`.ai-lore-docs/decisions/`, committed by `ail-cleanup` promotion, not written by this skill). This skill's runs are the only place decision nodes get linked into modules and concepts; see Step E.

> **Model:** any for orchestration. **Requires Node.js:** the deterministic linker `scripts/build-links.js` is load-bearing (it computes all back-edges, cycles, coupling, `dependencies.md`, and `index.md`). If Node is unavailable, this skill stops rather than committing a partial graph.

> **Plugin root:** several steps invoke `node <plugin_root>/scripts/build-links.js`. Derive `<plugin_root>` the same way the other ai-lore skills do (the directory containing this plugin's `scripts/`).

---

## 0. Parse arguments

Extract from the invocation:

- **Directory paths**: any non-flag arguments (e.g. `src/api src/models`). If none, full-project mode.
- **`--include-tests`**: document test files. Default: `false`.
- **`--status`**: report state and stop (see Argument passthrough).

---

## 1. Pre-flight

1. `git rev-parse --show-toplevel` for the project root; `git rev-parse HEAD` (full) and `git rev-parse --short HEAD` (short). Store both.
2. **Hard Node.js check:** run `node --version`. If it fails (not found or non-zero), STOP and report: "ail-document requires Node.js for the deterministic linker. Install Node and re-run. Nothing was written." Do not proceed; do not commit a partial graph.
3. Read `.ai-lore-docs/state.yaml` if present (see schema in step 9).

---

## 2. Discovery (git ls-files, secrets denylist)

Enumerate documentable directories from **tracked** files only (honors `.gitignore`, excludes generated/vendored/untracked):

```bash
git ls-files -- <target paths or nothing for full repo>
```

From the file list, derive the set of directories that contain at least one **source** file (same source-extension filter as before: `*.ts *.tsx *.js *.jsx *.py *.go *.rs *.rb *.java *.kt *.cs *.cpp *.c *.h *.swift *.scala *.ex *.exs *.ml *.mli`). Exclude any directory under `.ai-lore`, `.ai-lore-docs`, `node_modules`, `dist`, `build`, `.next`, `coverage`, `__pycache__`, `target`.

**Secrets denylist:** never feed sensitive files to workers. Exclude files matching `.env*`, `*.pem`, `*.key`, `*secret*`, `*credential*`, `id_rsa*`, and similar. Pass this denylist expectation to the workers as well.

**Note (filename vs content screening):** this denylist is a FILENAME glob list that excludes whole files from being read; it was tuned for code, not free-text prose. It is not a content scanner and does not screen the text this skill or the linker writes. Content-level secret/PII screening of committed decision prose (the MADR body and frontmatter of `.ai-lore-docs/decisions/*.md`) is owned by `ail-cleanup` promotion, which defines its own content secret/PII pattern set inline. If this filename denylist is ever extended toward content scanning, it must be reviewed separately for free-text prose PII; that extension is out of scope here.

**Full-project mode:** all discovered source directories are `target_dirs`.
**Scoped mode:** verify each specified path is a tracked directory; use as `target_dirs` (do not descend).

---

## 3. Migration detection

If `state.yaml` exists and either (a) its `plugin_version` predates 0.9.0, or (b) module docs under `modules/` lack the new frontmatter keys (`resolved_dependencies`, `depends_on`), this is an older-format doc set.

Do **not** parse the old prose to recover edges. Instead trigger a **targeted re-doc** (workers re-read source and return the new structured data). Offer the user an immediate **full re-doc** as an alternative via `AskUserQuestion`:

> "Existing docs are from an older ail-document format. I will re-document changed and new directories to build the knowledge graph. Do a full re-doc instead (re-document everything now)?"

Options: "Targeted (recommended)", "Full re-doc". Then continue with the chosen scope.

---

## 4. Determine scope (existing state only)

Skip if this is a fresh run (no `state.yaml`).

For each previously documented directory, compare its `last_commit` against HEAD:

```bash
git log --oneline <last_commit>..HEAD -- <dir>
```

Collect `stale_dirs` (changed since documented), `fresh_dirs` (unchanged), `new_dirs` (in `target_dirs`, not yet in state). If `stale_dirs` and `new_dirs` are both empty, docs are up to date regardless of whether HEAD itself moved (HEAD can advance via commits outside every documented directory); report "docs already up to date" and stop. In that case, still update `state.yaml`'s tracked commit fields (each directory's `last_commit` and `overview_last_commit`) to HEAD before stopping, so the next run's diff starts from HEAD instead of re-walking the same already-irrelevant range.

If any `stale_dirs` or `new_dirs` exist, ask (unless migration already forced a choice):

> "Docs exist from commit `<short_commit>`. Since then: `<N>` files changed across `<M>` directories (`<stale_dir_list>`). Update targeted or full?"

Options: "Targeted update (recommended)", "Full re-doc". Targeted: `dirs_to_document = stale_dirs + new_dirs`. Full: `dirs_to_document = target_dirs`. If only `new_dirs` and no `stale_dirs`, default to targeted without asking.

---

## 5. Step A: Fan out directory-documenter agents (Workflow)

Call `Workflow` with the inline script below. Pass the `script` verbatim. **Pass `args` as an actual JSON object, not a JSON-encoded string.**

```js
export const meta = {
  name: 'document-dirs',
  description: 'Fan out directory-documenter agents, one per directory',
  phases: [{ title: 'Document directories' }],
}

const DIR_SCHEMA = {
  type: 'object',
  required: ['directory', 'summary', 'files', 'patterns', 'resolved_dependencies', 'external_dependencies', 'candidate_concepts', 'extension_hints', 'gotchas'],
  properties: {
    directory: { type: 'string' },
    summary: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'purpose'],
        properties: {
          path: { type: 'string' },
          purpose: { type: 'string' },
          exports: { type: 'array', items: { type: 'string' } },
          key_dependencies: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    patterns: { type: 'string' },
    resolved_dependencies: { type: 'array', items: { type: 'string' } },
    external_dependencies: { type: 'array', items: { type: 'string' } },
    candidate_concepts: { type: 'array', items: { type: 'string' } },
    extension_hints: {
      type: 'array',
      items: {
        type: 'object',
        required: ['to_add', 'steps'],
        properties: { to_add: { type: 'string' }, steps: { type: 'string' } },
      },
    },
    gotchas: { type: 'array', items: { type: 'string' } },
  },
}

function _args(a) {
  // Workflow may deliver args as an object or as a (possibly double-encoded) JSON string.
  for (let i = 0; i < 2 && typeof a === 'string' && a.length; i++) {
    try { a = JSON.parse(a) } catch { break }
  }
  return (a && typeof a === 'object' && !Array.isArray(a)) ? a : {}
}
const { dirs: dirs_raw, include_tests, head_commit } = _args(args)
const dirs = Array.isArray(dirs_raw) ? dirs_raw : []
log(`dirs: ${dirs.length} directories`)
if (dirs.length === 0) {
  log(`FATAL: document-dirs received no directories; typeof args=${typeof args}`)
  throw new Error(`document-dirs: expected a non-empty dirs array in args, got none (typeof args=${typeof args})`)
}

const results = (await parallel(dirs.map(d => () =>
  agent(
    `Document directory "${d}" in this repo.\n` +
    `include_tests: ${include_tests}\n` +
    `head_commit: ${head_commit}\n\n` +
    `Read every source file directly in this directory (not recursively), resolve its imports ` +
    `to repo-relative paths, and return structured output only.`,
    {
      label: `doc:${d}`,
      phase: 'Document directories',
      agentType: 'ai-lore:directory-documenter',
      schema: DIR_SCHEMA,
    }
  )
))).filter(Boolean)

return results
```

Call: `Workflow({ script: <the js block above verbatim>, args: { dirs: <dirs_to_document>, include_tests: <bool>, head_commit: <full HEAD commit> } })`. Capture as `dir_results`.

The script's `.filter(Boolean)` silently drops any agent call that failed or returned nothing; a dropped directory never gets a module doc unless caught here. After the call, compare `dir_results.length` against `dirs_to_document.length`. If they differ, diff the directory names (`dir_results` entries carry `directory`) against `dirs_to_document` and report the missing directories by name to the user, e.g. "N of M directories did not return a result: `<dir-1>`, `<dir-2>`. These have no module doc this run; re-run ail-document on them to retry." Do not silently proceed as if the run were complete.

---

## 6. Step B: Write module docs (reference) and prune

For each result in `dir_results`, derive the slug: replace `/` and `.` with `-`, strip leading `-`, append `.md` (`.` -> `root.md`). This must match `build-links.js` `slugify`.

Write each `.ai-lore-docs/modules/<slug>.md`. The orchestrator writes the **source** frontmatter keys and the prose; the managed keys (`depends_on`, `depended_on_by`, `concepts`) start as empty placeholders and are filled by the linker in Step E. Format:

```markdown
---
directory: <result.directory>
last_commit: <full HEAD commit>
last_run: <today YYYY-MM-DD>
resolved_dependencies: [<result.resolved_dependencies joined with ", ">]
external_dependencies: [<result.external_dependencies joined with ", ">]
depends_on: []
depended_on_by: []
concepts: []
---

# <result.directory>

<result.summary>

## Files

<for each file in result.files:>
### `<basename of file.path>`

<file.purpose>
<if exports:> Exports: `<exports joined with "`, `">`
<if key_dependencies:> Depends on: `<key_dependencies joined with "`, `">`
<end for each>

<if result.patterns:>
## Patterns

<result.patterns>

## Extension Hints

<for each hint in result.extension_hints:>
- To add <hint.to_add>: <hint.steps>
<end for>

## Gotchas

<for each g in result.gotchas:>
- <g>
<end for>

## Concepts

none

## Related

Depends on: none
Depended on by: none
```

Keep module docs as a capped reference: if a directory has many files, summarize rather than enumerate every one. Frontmatter must stay in the constrained subset (flat scalars and flow-style `[a, b]` lists only; no multiline).

**Prune:** for every directory currently in `state.yaml.directories` whose path no longer exists on disk (deleted/renamed), delete its `modules/<slug>.md` and remove it from state. The linker recomputes edges from whatever module docs remain, so inbound links to pruned dirs disappear automatically.

Create `.ai-lore-docs/modules/` if needed.

---

## 7. Step C: Concept assignment and orphan resolution

1. **Load the inventory.** Read `.ai-lore-docs/concepts.seed.yaml` if present (user-editable, authoritative). Each entry is `{ slug, title, owns_paths }`. On a first run it is absent (empty inventory).

2. **Assign deterministically.** For each documented directory, assign it to the concept whose `owns_paths` is the longest matching prefix/glob. No LLM in this step.

3. **Orphans.** Any directory matching no concept is an orphan. If there are orphans, cluster them (by shared top-level path) and, per cluster, ask the user via `AskUserQuestion`:

   > "These directories are not covered by any concept: `<cluster>`. Recommendation: <attach to existing concept X | create new concept 'Y'>. What should I do?"

   Options: "Attach to <existing>", "Create new concept", "Skip for now". On "create new", propose a `slug` (lowercase, hyphenated, frozen), `title`, and `owns_paths`; on confirmation, append the entry to `concepts.seed.yaml`. **Never rename or remove an existing slug without explicit confirmation.**

4. **Determine which concepts to compose.** A concept needs (re)composition if any of its member directories were documented this run (in `dirs_to_document`) or its membership changed. Build `concepts_to_compose = [{ slug, title, members: [{ directory, docs_file }] }]`.

5. **Compose (Workflow).** Fan out `concept-synthesizer`, one per concept to compose:

```js
export const meta = {
  name: 'synthesize-concepts',
  description: 'Compose dense cross-directory concept docs, one agent per concept',
  phases: [{ title: 'Compose concepts' }],
}

const CONCEPT_SCHEMA = {
  type: 'object',
  required: ['slug', 'title', 'summary', 'key_files', 'extension_points', 'gotchas', 'implemented_by'],
  properties: {
    slug: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    key_files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'role', 'module_slug'],
        properties: { path: { type: 'string' }, role: { type: 'string' }, module_slug: { type: 'string' } },
      },
    },
    extension_points: {
      type: 'array',
      items: {
        type: 'object',
        required: ['to_add', 'steps'],
        properties: { to_add: { type: 'string' }, steps: { type: 'string' } },
      },
    },
    gotchas: { type: 'array', items: { type: 'string' } },
    implemented_by: { type: 'array', items: { type: 'string' } },
  },
}

function _args(a) {
  // Workflow may deliver args as an object or as a (possibly double-encoded) JSON string.
  for (let i = 0; i < 2 && typeof a === 'string' && a.length; i++) {
    try { a = JSON.parse(a) } catch { break }
  }
  return (a && typeof a === 'object' && !Array.isArray(a)) ? a : {}
}
const { docs_dir, concepts: concepts_raw } = _args(args)
const concepts = Array.isArray(concepts_raw) ? concepts_raw : []
log(`docs_dir: ${docs_dir ?? '(undefined)'}; concepts: ${concepts.length} to compose`)
if (!docs_dir) {
  log(`FATAL: synthesize-concepts received no docs_dir; typeof args=${typeof args}`)
  throw new Error(`synthesize-concepts: expected docs_dir in args, got none (typeof args=${typeof args})`)
}
if (concepts.length === 0) {
  log(`FATAL: synthesize-concepts received no concepts; typeof args=${typeof args}`)
  throw new Error(`synthesize-concepts: expected a non-empty concepts array in args, got none (typeof args=${typeof args})`)
}

const results = (await parallel(concepts.map(c => () =>
  agent(
    `Compose the concept document for "${c.slug}".\n` +
    `slug: ${c.slug}\n` +
    `title: ${c.title}\n` +
    `docs_dir: ${docs_dir}\n` +
    `members: ${JSON.stringify(c.members || [])}\n\n` +
    `Read the member module docs and return structured concept data only.`,
    {
      label: `concept:${c.slug}`,
      phase: 'Compose concepts',
      agentType: 'ai-lore:concept-synthesizer',
      schema: CONCEPT_SCHEMA,
    }
  )
))).filter(Boolean)

return results
```

Call: `Workflow({ script: <the js block above verbatim>, args: { docs_dir: ".ai-lore-docs", concepts: <concepts_to_compose> } })`. Capture as `concept_results`.

As in Step A, the script's `.filter(Boolean)` silently drops any failed or empty agent result. After the call, compare `concept_results.length` against `concepts_to_compose.length`. If they differ, diff the slugs (`concept_results` entries carry `slug`) against `concepts_to_compose` and report the missing concepts by name to the user, e.g. "N of M concepts did not return a result: `<slug-1>`, `<slug-2>`. These concept docs were not composed this run; re-run ail-document to retry." Do not silently proceed as if all concepts were composed.

For large repos, batch `concepts_to_compose` by top-level area if the set is very large; the Workflow already runs them in parallel.

---

## 8. Step D: Write concept docs and update the concept map

For each result in `concept_results`, write `.ai-lore-docs/concepts/<slug>.md`:

```markdown
---
concept: <slug>
title: <title>
last_run: <today YYYY-MM-DD>
source_commit: <full HEAD commit>
implemented_by: [<implemented_by joined with ", ">]
---

# <title>

<summary>

## Key Files

<for each kf in key_files:>
- [<kf.path>](../modules/<kf.module_slug>.md): <kf.role>
<end for>

## Extension Points

<for each ep in extension_points:>
- To add <ep.to_add>: <ep.steps>
<end for>

## Gotchas

<for each g in gotchas:>
- <g>
<end for>

## Implemented by

<for each dir in implemented_by:>
- [<dir>](../modules/<slug-of-dir>.md)
<end for>
```

Only rewrite a concept doc whose content actually changed (write-on-delta; do not touch unchanged concept docs). Create `.ai-lore-docs/concepts/` if needed.

---

## 9. Step E: Run the deterministic linker (build-links.js)

Everything the linker needs (source frontmatter on module docs, concept `implemented_by`) is now on disk. Run:

```bash
node <plugin_root>/scripts/build-links.js .ai-lore-docs
```

The linker reads all module + concept frontmatter, resolves `depends_on` (mapping each module's `resolved_dependencies` to the documented directory that is its longest path prefix), inverts to `depended_on_by`, derives each module's `concepts` from concept `implemented_by`, detects cycles, computes coupling, and rewrites (via surgical key-level edits) the managed module frontmatter keys + `## Concepts`/`## Related` sections, plus `dependencies.md` and `index.md`. It is idempotent, transactional, write-on-delta, and **fail-closed**: on any validation failure it writes nothing and exits non-zero.

**Decision node processing (same run, same command).** The linker also treats `.ai-lore-docs/decisions/*.md` as a node set (committed there by `ail-cleanup` promotion; this skill never writes decision source files). On every `ail-document` run it: derives `superseded_by` as the inverse of each decision's `supersedes` and derives `status` (`superseded` when `superseded_by` is non-empty, else `accepted`); resolves each decision's `affects_paths` to the module doc whose directory is the longest documented-directory match, and from there to that module's concept(s); injects a capped, managed `## Decisions` section (with a `decisions:` managed key) into every affected module doc; and renders a render-time `## Decisions` section into affected concept docs as the deduplicated union of member modules' decision lists (no separate stored key on the concept). It also renders the global aggregate `.ai-lore-docs/decisions.md` log and adds decision rows to `index.md`. An `affects_paths` entry that points at a directory this skill has not documented yet is unresolved: module/concept linking for that entry is skipped this run (fail-closed, not an error) and retried automatically on the next `ail-document` run; recall and the `decisions.md` aggregate never depend on resolution, so the decision stays visible even while unresolved. A repo with decision nodes but no module/concept docs yet (a decisions-only graph) is tolerated: the aggregate log still renders, with no injection until directories are documented.

If the linker exits non-zero, STOP: report its stderr, do not commit, and leave the docs as they are (the linker already refused to write). This is a real error to surface, not to work around.

**Manual-merge detection (warning, not error).** Before reporting the run's results (Step H), check each plan directory under `.ai-lore/plans/*/decisions/` (gitignored, per-plan, in-flight decision source files) for decision ids with no matching file under the committed `.ai-lore-docs/decisions/`. This catches decisions dropped by a merge or rebase that happened outside `ail-cleanup` promotion (which is normally the only path that commits decision files). For each plan slug with unmatched ids, print a warning of the form:

> Warning: plan `<slug>` has decisions not found in `.ai-lore-docs/decisions/`: `<id-1>, <id-2>`. If these were meant to ship, promote them via `ail-cleanup`; otherwise they may have been lost in a manual merge.

This is a warning surfaced in the run report, never an error: it does not stop the run, does not block the commit in Step H, and does not write or delete any file.

Now update `.ai-lore-docs/state.yaml` (read existing or start fresh). Read `plugin_version` from `.ai-lore/config.yaml`; do not hardcode.

```yaml
plugin_version: "<value from .ai-lore/config.yaml>"
directories:
  <dir>:
    last_commit: <full HEAD commit>
    last_run: <today YYYY-MM-DD>
    docs_file: "modules/<slug>.md"
  # one entry per documented dir; preserve fresh_dirs entries unchanged; drop pruned dirs
concepts:
  <slug>:
    title: <title>
    members: [<member directories>]
    docs_file: "concepts/<slug>.md"
    last_run: <today YYYY-MM-DD>
overview_last_commit: <full HEAD commit>
overview_last_run: <today YYYY-MM-DD>
```

---

## 10. Step F: Synthesize overview (Workflow, overview-only)

Fan out a single overview agent that reads the concept tier plus module summaries:

```js
export const meta = {
  name: 'synthesize-overview',
  description: 'Produce overview.md from concept docs and module summaries',
  phases: [{ title: 'Synthesize overview' }],
}

const SYNTH_SCHEMA = { type: 'object', required: ['content'], properties: { content: { type: 'string' } } }

function _args(a) {
  // Workflow may deliver args as an object or as a (possibly double-encoded) JSON string.
  for (let i = 0; i < 2 && typeof a === 'string' && a.length; i++) {
    try { a = JSON.parse(a) } catch { break }
  }
  return (a && typeof a === 'object' && !Array.isArray(a)) ? a : {}
}
const { docs_dir, head_commit, run_date, changed_concepts: cc_raw, prior_overview } = _args(args)
const changed_concepts = Array.isArray(cc_raw) ? cc_raw : []
log(`docs_dir: ${docs_dir ?? '(undefined)'}; changed_concepts: ${changed_concepts.length}`)
if (!docs_dir) {
  log(`FATAL: synthesize-overview received no docs_dir; typeof args=${typeof args}`)
  throw new Error(`synthesize-overview: expected docs_dir in args, got none (typeof args=${typeof args})`)
}

const overview = await agent(
  `You are producing the architecture overview (overview.md), organized by concept.\n` +
  `docs_dir: ${docs_dir}\n` +
  `head_commit: ${head_commit}\n` +
  `run_date: ${run_date}\n` +
  `changed_concepts: ${JSON.stringify(changed_concepts)}\n` +
  `prior_overview: ${!!prior_overview}\n\n` +
  `Read all concept docs and module-frontmatter summaries, then synthesize overview.md content. Return structured output only.`,
  { label: 'synthesize:overview', phase: 'Synthesize overview', agentType: 'ai-lore:docs-synthesizer', schema: SYNTH_SCHEMA }
)

return { overview_content: overview ? overview.content : '' }
```

Call: `Workflow({ script: <the js block above verbatim>, args: { docs_dir: ".ai-lore-docs", head_commit: <short HEAD>, run_date: <today>, changed_concepts: <slugs composed this run>, prior_overview: <bool> } })`. Write `synth.overview_content` to `.ai-lore-docs/overview.md` only if changed.

---

## 11. Step G: Coverage confirmation

Re-diff `git ls-files` (source files) against the set of files covered by documented directories. Report any tracked source files/directories that map to no module doc (and thus no concept). This is a report, not a blocker; it keeps "exhaustive" honest. Orphaned directories should already have been resolved in Step C.

---

## 12. Step H: Commit

1. Ensure `.ai-lore-docs/` is not gitignored (remove or comment any ignoring line; report the change). On first run, `git add .ai-lore-docs/`.
2. Stage only changed files under `.ai-lore-docs/` and commit:

   ```
   docs: update .ai-lore-docs to <short HEAD commit>
   ```

3. Report: directories documented, concepts composed, whether overview/dependencies/decisions/index changed, the commit hash, and any manual-merge detection warnings from Step E.
4. **CLAUDE.md / AGENTS.md reference.** Prefer `CLAUDE.md`, else `AGENTS.md`, else offer to create `CLAUDE.md`. If it has no `.ai-lore-docs` reference yet, offer to add:

```markdown
## Codebase Documentation

Generated by ai-lore. An interlinked, concept-first knowledge graph you traverse by following links:

- Start here: `.ai-lore-docs/concepts/` (dense, cross-directory feature docs with recipes and gotchas)
- Find the doc for a path: [Index](.ai-lore-docs/index.md)
- System map: [Overview](.ai-lore-docs/overview.md); module-to-module edges: [Dependencies](.ai-lore-docs/dependencies.md)
- Per-directory reference: `.ai-lore-docs/modules/`
```

   If the user accepts, append and commit (`docs: add ai-lore-docs reference to CLAUDE.md`).

---

## Argument passthrough

If invoked with `--status`, skip all documentation steps and report from `.ai-lore-docs/state.yaml`: last run date, commit, which directories are stale vs current, and the concept inventory. Do not ask questions or run agents.

---

## Principles

- **The docs are the source of truth.** Edges live in frontmatter; neighbors are markdown links. There is no separate graph store (no `graph.json`). An agent traverses by following links.
- **Concepts are primary; recipes live on concept docs.** Concept docs are dense and cross-directory; module docs are the capped file-level reference.
- **Concepts are a stable, self-maintaining inventory.** Deterministic glob assignment; frozen slugs; the LLM plus human only engage on orphaned (new) code. Never silently rename or remove a concept.
- **build-links.js is load-bearing and fails closed.** It is the sole writer of managed module frontmatter (`depends_on`, `depended_on_by`, `concepts`, `decisions`) and the `## Concepts`/`## Related`/`## Decisions` sections, and it renders `dependencies.md`, `decisions.md`, and `index.md`. Requires Node.js; on validation failure it writes nothing. Run `node scripts/build-links.js --selftest` before releasing a plugin version.
- **Three node types make up the graph:** module docs, concept docs, and decision nodes. This skill writes and links module and concept docs; decision nodes are written only by `ail-cleanup` promotion, but this skill's linker run is what derives their `superseded_by`/`status`, resolves `affects_paths`, injects `## Decisions` sections, and renders `decisions.md`.
- **Discovery uses `git ls-files` plus a secrets denylist.** Only tracked source is documented; sensitive files are never read into committed docs. The denylist is filename-based, not a content scanner; see the note in Step 2.
- **Write only on delta.** Never rewrite an unchanged doc; keep git diffs to real changes.
- **Output is committed, not gitignored.** The entire purpose of `.ai-lore-docs/` is to live in the repo.
- **Workers return data; the orchestrator and linker write files.** Structured output only from agents.
