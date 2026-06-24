---
name: document
description: Document a codebase by scanning its directories and fanning out parallel documentation agents. Produces per-module docs, an architecture overview, and a dependency map under .ai-lore-docs/ in the target project. Tracks the last-documented commit in .ai-lore-docs/state.yaml; on subsequent runs detects what changed and offers a targeted update or full re-doc. Codebase-agnostic. e.g. "/ai-lore-document", "/ai-lore-document src/api", "/ai-lore-document src/api src/models --include-tests".
---

# ai-lore-document

Document a codebase using parallel sub-agents, one per directory. Outputs are committed markdown files under `.ai-lore-docs/` in the project.

> **Model:** any. This skill does orchestration and file writing; the heavy reading work runs in sub-agents.

---

## 0. Parse arguments

Extract from the invocation:

- **Directory paths**: any non-flag arguments (e.g. `src/api src/models`). If none, full-project mode.
- **`--include-tests`**: flag indicating test files should be documented. Default: `false`.

---

## 1. Establish project root and HEAD commit

Run `git rev-parse --show-toplevel` to confirm the project root. Run `git rev-parse HEAD` for the current commit hash (full). Run `git rev-parse --short HEAD` for the short form. Store both.

---

## 2. Read existing state

Check for `.ai-lore-docs/state.yaml` at the project root.

**If it does not exist:** this is a fresh run. Set `fresh_run = true`. Skip to step 3.

**If it exists:** parse it. Identify:
- `directories`: map of previously documented directory paths to their `last_commit` and `docs_file`.
- `overview_last_commit`, `dependencies_last_commit`.

Compare each documented directory's `last_commit` against the current HEAD. Run:

```bash
git log --oneline <last_commit>..HEAD -- <dir>
```

for each previously documented directory to see if any commits touch it. Collect:
- `stale_dirs`: directories where commits exist since `last_commit`.
- `fresh_dirs`: directories where nothing has changed since `last_commit`.
- `new_dirs`: target directories that have no entry in `state.yaml` yet.

If HEAD equals every directory's `last_commit` and there are no new dirs, the docs are already up to date. Report this and stop.

---

## 3. Determine target directories

**Full-project mode (no paths specified):**

Run the following to find all directories containing source files, excluding generated/tool paths:

```bash
find . -mindepth 1 -maxdepth 5 -type d \
  -not -path './.git*' \
  -not -path '*/node_modules*' \
  -not -path './.ai-lore*' \
  -not -path './.ai-lore-docs*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  -not -path '*/.next/*' \
  -not -path '*/coverage/*' \
  -not -path '*/__pycache__*' \
  -not -path '*/.pytest_cache*' \
  -not -path '*/target/*' \
  -not -path '*/.cargo/*' \
  | sort
```

For each candidate directory, verify it contains at least one source file at that level (not recursively):

```bash
find <dir> -maxdepth 1 -type f \( \
  -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o \
  -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.rb" -o \
  -name "*.java" -o -name "*.kt" -o -name "*.cs" -o -name "*.cpp" -o \
  -name "*.c" -o -name "*.h" -o -name "*.swift" -o -name "*.scala" -o \
  -name "*.ex" -o -name "*.exs" -o -name "*.ml" -o -name "*.mli" \
\)
```

Keep only directories where this returns at least one file. These are `target_dirs`.

**Scoped mode (one or more paths specified):**

Verify each specified path exists and is a directory. Use it as `target_dirs` (do not descend further -- document the directory as given).

---

## 4. Offer targeted vs full update (existing state only)

Skip this step if `fresh_run = true`.

If any `stale_dirs` or `new_dirs` exist among `target_dirs`:

Ask the user (using `AskUserQuestion`):

> "Docs exist from commit `<short_commit>`. Since then: `<N>` files changed across `<M>` directories (`<stale_dir_list>`). How do you want to update?"

Options:
- "Targeted update -- re-document only changed and new directories" (default)
- "Full re-doc -- re-document everything in scope"

If the user chooses targeted: set `dirs_to_document = stale_dirs + new_dirs` (within `target_dirs`). Keep `fresh_dirs` as-is (their module docs will not be regenerated, but synthesis will re-read them from disk).

If the user chooses full: set `dirs_to_document = target_dirs`.

If there are only `new_dirs` and no `stale_dirs` (all previously documented dirs are current), default to targeted without asking.

---

## 5. Fan out directory-documenter agents (Workflow)

Author and execute a Workflow script that fans out one `ai-lore:directory-documenter` agent per directory in `dirs_to_document`.

```js
export const meta = {
  name: 'document-dirs',
  description: 'Fan out directory-documenter agents, one per directory',
  phases: [{ title: 'Document directories' }],
}

const DIR_SCHEMA = {
  type: 'object',
  required: ['directory', 'summary', 'files', 'patterns', 'outbound_dependencies'],
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
    outbound_dependencies: { type: 'array', items: { type: 'string' } },
  },
}

const { dirs, include_tests, head_commit } = args

const results = (await parallel(dirs.map(d => () =>
  agent(
    `Document directory "${d}" in this repo.\n` +
    `include_tests: ${include_tests}\n` +
    `head_commit: ${head_commit}\n\n` +
    `Read every source file directly in this directory (not recursively), ` +
    `document each one, and return structured output only.`,
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

Pass `args` as `{ dirs: <dirs_to_document>, include_tests: <bool>, head_commit: <full HEAD commit> }`.

Capture the array of directory results as `dir_results`.

---

## 6. Write module docs

For each result in `dir_results`, derive the docs filename from the directory path: replace `/` and `.` with `-`, strip leading `-`, append `.md`. Examples: `src/api` -> `src-api.md`, `.` -> `root.md`, `lib/utils` -> `lib-utils.md`.

Write each module doc to `.ai-lore-docs/modules/<slug>.md` using this format:

```markdown
---
directory: <result.directory>
last_commit: <full HEAD commit>
last_run: <today's date YYYY-MM-DD>
---

# <result.directory>

<result.summary>

## Files

<for each file in result.files:>
### `<basename of file.path>`

<file.purpose>

<if file.exports is non-empty:>
**Exports:** `<exports joined with "`, `">`

<if file.key_dependencies is non-empty:>
**Key dependencies:** `<key_dependencies joined with "`, `">`

---
<end for each file>

<if result.patterns is non-empty:>
## Patterns

<result.patterns>

<if result.outbound_dependencies is non-empty:>
## Dependencies

**Depends on:** <outbound_dependencies joined with ", ">
```

Create `.ai-lore-docs/modules/` if it does not exist.

---

## 7. Synthesize overview and dependency docs (Workflow)

After writing all module docs to disk, author and execute a second Workflow script that runs both synthesis agents in parallel:

```js
export const meta = {
  name: 'synthesize-docs',
  description: 'Run overview and dependency synthesis agents in parallel after module docs are on disk',
  phases: [{ title: 'Synthesize' }],
}

const SYNTH_SCHEMA = {
  type: 'object',
  required: ['content'],
  properties: {
    content: { type: 'string' },
  },
}

const { docs_dir, head_commit, run_date, scopes } = args

const [overview, deps] = await parallel([
  () => agent(
    `You are producing the architecture overview document (overview.md).\n` +
    `type: overview\n` +
    `docs_dir: ${docs_dir}\n` +
    `head_commit: ${head_commit}\n` +
    `run_date: ${run_date}\n` +
    `scopes: ${JSON.stringify(scopes)}\n\n` +
    `Read all .md files in ${docs_dir}/modules/, then synthesize overview.md content. Return structured output only.`,
    {
      label: 'synthesize:overview',
      phase: 'Synthesize',
      agentType: 'ai-lore:docs-synthesizer',
      schema: SYNTH_SCHEMA,
    }
  ),
  () => agent(
    `You are producing the dependency map document (dependencies.md).\n` +
    `type: dependencies\n` +
    `docs_dir: ${docs_dir}\n` +
    `head_commit: ${head_commit}\n` +
    `run_date: ${run_date}\n` +
    `scopes: ${JSON.stringify(scopes)}\n\n` +
    `Read all .md files in ${docs_dir}/modules/, then synthesize dependencies.md content. Return structured output only.`,
    {
      label: 'synthesize:dependencies',
      phase: 'Synthesize',
      agentType: 'ai-lore:docs-synthesizer',
      schema: SYNTH_SCHEMA,
    }
  ),
])

return { overview_content: overview ? overview.content : '', deps_content: deps ? deps.content : '' }
```

Pass `args` as `{ docs_dir: ".ai-lore-docs", head_commit: <short HEAD commit>, run_date: <today YYYY-MM-DD>, scopes: <target_dirs> }`.

Capture results as `synth`.

---

## 8. Write overview and dependency docs

Write `.ai-lore-docs/overview.md` with `synth.overview_content`.

Write `.ai-lore-docs/dependencies.md` with `synth.deps_content`.

Create `.ai-lore-docs/` at the project root if it does not exist.

---

## 9. Update state.yaml

Read the existing `.ai-lore-docs/state.yaml` if present (or start with an empty structure). Write the updated version:

```yaml
plugin_version: "0.6.0"
directories:
  <dir_path>:
    last_commit: <full HEAD commit>
    last_run: <today YYYY-MM-DD>
    docs_file: "modules/<slug>.md"
  <...one entry per directory in dirs_to_document, plus preserved entries for fresh_dirs>
overview_last_commit: <full HEAD commit>
overview_last_run: <today YYYY-MM-DD>
dependencies_last_commit: <full HEAD commit>
dependencies_last_run: <today YYYY-MM-DD>
```

Preserve all `fresh_dirs` entries from the existing state unchanged.

---

## 10. Ensure .ai-lore-docs is not gitignored

Check the project's `.gitignore`. If it contains a line that would exclude `.ai-lore-docs/` or `.ai-lore-docs`, remove or comment it out and report the change. The purpose of this directory is to be committed.

If `.ai-lore-docs/` is not yet tracked by git (first run), run `git add .ai-lore-docs/` explicitly.

---

## 11. Auto-commit

Stage all changes under `.ai-lore-docs/`:

```bash
git add .ai-lore-docs/
```

Commit with the message:

```
docs: update .ai-lore-docs to <short HEAD commit>
```

Report: how many directories documented, whether overview and deps were updated, the commit hash.

---

## Argument passthrough

If the user invoked `/ai-lore-document` with `--status`, skip all documentation steps and report the current state from `.ai-lore-docs/state.yaml`: last run date, commit, which directories are stale vs current. Do not ask questions or run agents.

---

## Principles

- **Output is committed, not gitignored.** The entire purpose of `.ai-lore-docs/` is to live in the repo. Check and correct if it is being ignored.
- **Two Workflow calls, not one.** Module docs must be on disk before synthesis agents run. The synthesizer reads from disk so it can incorporate docs from unchanged dirs.
- **Targeted updates re-run synthesis.** Even when only a subset of dirs changed, the overview and dependency map are always regenerated, because they depend on the full set of module docs.
- **State tracks per-directory commit hashes.** This makes it possible to know precisely which dirs are stale without reading every file.
- **Workers return data; this skill writes files.** Directory-documenter and docs-synthesizer return structured output. All file writes happen in this skill.
- **No em dashes** in any file written by this skill (commas, semicolons, parentheses, periods instead).
