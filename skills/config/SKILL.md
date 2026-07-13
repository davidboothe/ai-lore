---
name: ail-config
description: Validate and patch .ai-lore/config.yaml in the current project. Checks that all required fields are present, compares the config's plugin_version against the current plugin version (0.14.0), and applies semver migrations (auto-patches new optional keys for minor/patch bumps; prompts before breaking changes). Creates the config from the template with auto-detected toolchain values if it is missing. Safe to run standalone or as a pre-flight step before any other ai-lore skill. e.g. "check my ai-lore config", "/ail-config".
---

# ail-config

Validate and (if needed) patch `.ai-lore/config.yaml` for the current project. This skill is the canonical place to create or migrate a config; every other ai-lore skill may delegate here rather than duplicating detection logic.

**Current plugin version: 0.14.0**

---

## Config schema (v0.14.0)

All fields and their types:

| Field | Type | Required | Default | Since |
|---|---|---|---|---|
| `plugin_version` | string | yes (after 0.4.0) | (set by this skill) | 0.4.0 |
| `package_manager` | string | no | auto-detected | 0.1.0 |
| `gate` | list of strings | yes | auto-detected | 0.1.0 |
| `test_command` | string | yes | auto-detected | 0.1.0 |
| `worktrees.default` | boolean | no | `true` | 0.1.0 |
| `worktrees.dir` | string | no | `.ai-lore/worktrees` | 0.1.0 |
| `plan.html_preview` | boolean | no | `false` | 0.7.6 |
| `brainstorm.panel` | list of strings | no | the five built-in persona ids (see template) | 0.12.0 |

---

## Workflow

### 1. Locate the config

Look for `.ai-lore/config.yaml` relative to the project root (the directory containing `.git`). If the file does not exist, go to **Step 4** (create from template).

### 2. Read and parse the config

Read `.ai-lore/config.yaml`. Parse the YAML. If the file is unparseable, report the error and stop; do not overwrite a corrupted file silently.

### 3. Determine migration status

Compare the `plugin_version` value in the config (call it `config_version`) against the current plugin version `0.14.0`.

**If `plugin_version` is absent** (v0.1 config -- this field did not exist before 0.4.0):
- This is a non-breaking migration. Auto-patch: add `plugin_version: 0.14.0` at the top of the file (after any leading comment block), then apply all applicable migration files in order. Report what was added or removed.

**If `config_version == plugin_version`** (up to date):
- Validate all required fields are present and non-null (see schema). Report any missing required fields and offer to add sensible defaults. Otherwise proceed to the structural completeness check (step 3d).

**If `config_version` is a lower minor or patch than `0.14.0`** (e.g. `0.1.x`, `0.4.0`, `0.5.0`):
- Apply each applicable migration in order by reading the corresponding file from the index below and following its instructions. Report each change made. Do NOT remove or rename existing keys. Proceed to the structural completeness check (step 3d) after applying all migrations.

**If `config_version` is a higher version than `0.14.0`**:
- The config was written by a newer plugin. Report this and warn the user they may be running an older plugin against a newer config. Do not modify the config.

**If `config_version` has a different major version** (e.g. config says `1.x` but plugin is `0.x`, or vice versa):
- This is a potentially breaking migration. Do NOT auto-patch. Show the user what changed and ask for explicit confirmation before modifying anything.

#### Migration index (cumulative, apply in order)

Each row points to a migration file in `skills/config/migrations/`. **Load only the files that apply to the current version gap** — do not load all files when only one or two are needed.

| From version | To version | Migration file |
|---|---|---|
| (absent / 0.1.x) | 0.4.0 | `migrations/0.4.0-absent.md` |
| 0.3.x | 0.4.0 | `migrations/0.4.0-from-0.3.md` |
| 0.4.0 | 0.4.1 | `migrations/0.4.1.md` |
| 0.4.1 | 0.5.0 | `migrations/0.5.0.md` |
| 0.5.0 | 0.6.0 | `migrations/0.6.0.md` |
| 0.6.0 | 0.6.1 | `migrations/0.6.1.md` |
| 0.6.1 | 0.6.2 | `migrations/0.6.2.md` |
| 0.6.2 | 0.7.0 | `migrations/0.7.0.md` |
| 0.7.0 | 0.7.1 | `migrations/0.7.1.md` |
| 0.7.1 | 0.7.2 | `migrations/0.7.2.md` |
| 0.7.2 | 0.7.3 | `migrations/0.7.3.md` |
| 0.7.3 | 0.7.5 | `migrations/0.7.5.md` |
| 0.7.5 | 0.7.6 | `migrations/0.7.6.md` |
| 0.7.6 | 0.8.0 | `migrations/0.8.0.md` |
| 0.8.0 | 0.9.0 | `migrations/0.9.0.md` |
| 0.9.0 | 0.10.0 | `migrations/0.10.0.md` |
| 0.10.0 | 0.10.1 | `migrations/0.10.1.md` |
| 0.10.1 | 0.11.0 | `migrations/0.11.0.md` |
| 0.11.0 | 0.12.0 | `migrations/0.12.0.md` |
| 0.12.0 | 0.13.1 | `migrations/0.13.1.md` |
| 0.13.1 | 0.14.0 | `migrations/0.14.0.md` |

### 3d. Structural completeness check (always runs after steps 3, 4)

This step runs after every path -- migration, up-to-date, or create -- to guarantee the config contains exactly the fields the current plugin version expects. It catches fields that were removed by manual edits, missed by a migration, or added to the schema after the last ail-config run.

1. For each row in the schema table (in "Since" order):
   - If the field is present in the config: skip.
   - If the field is absent and **optional** (Required = "no"): auto-insert it at the logical position in the file (group it with related fields; e.g., `plan.html_preview` goes under `plan:`). Use the Default value from the schema table. Add it to a "patched" list.
   - If the field is absent and **required** (Required = "yes"): add it to a "missing-required" list. Do not auto-fill; a real value is needed.
2. Nested fields (e.g., `plan.html_preview`): if the parent key (`plan:`) is absent, create it, then add the child key beneath it.
3. After scanning all rows:
   - If the patched list is non-empty: write the updated config and report: "Structural patch: added N missing optional field(s):" followed by each field and its inserted default.
   - If the missing-required list is non-empty: report each field and note that ail-build-waves will fail until they are supplied. List them prominently.
   - If both lists are empty and no migration was applied: report "config OK at 0.14.0".

### 4. Create from template (config is missing)

If `.ai-lore/config.yaml` does not exist:

1. **Detect the toolchain** by invoking `ai-lore:toolchain-detector` with the repo root path. If it returns `ambiguous: true`, ask the user to clarify before proceeding.

2. Show the user the detected values (package_manager, gate commands, test_command) and confirm before writing.

3. Create `.ai-lore/` if it does not exist. Write `config.yaml` from `templates/config.yaml` with the detected values filled in and `plugin_version: 0.14.0` set. Report the created file path.

4. **Ensure `.ai-lore/` is gitignored.** Check the project root `.gitignore` for a line that matches `.ai-lore/` or `.ai-lore` (exact match or glob that covers it). If no such line exists, append `.ai-lore/` to `.gitignore` (create the file if it does not exist). Report what was done. Skip this step if there is no `.git/` directory (not a git repo).

### 5. Report

End with a one-line status: `config OK at 0.14.0`, `config migrated 0.5.0 -> 0.14.0`, or `config created at 0.14.0`. If any required fields are still missing after migration/creation (e.g. the user declined to fill in gate commands), list them explicitly so the user knows what to fix before running ail-build-waves.

### 6. Onboarding nudge (fresh config only)

Skip this step if the config already existed (migration or up-to-date paths).

If the config was just created in step 4:

1. Print a brief suggestion:

   > "Config created. To give ai-lore (and Claude) full architectural context in every session, run `/ail-document` to generate committed codebase documentation. After it completes, a reference can be added to your project's `CLAUDE.md` or `AGENTS.md`."

2. Ask the user (using `AskUserQuestion`):

   > "Would you like to document the codebase now?"

   Options:
   - "Yes, run ail-document now"
   - "No, I'll do it later"

   If the user chooses yes, invoke `ail-document`. If no, continue without action.

---

## Principles

- **Never silently overwrite.** Always report what changed and why.
- **Auto-patch only non-breaking changes** (new optional keys). Prompt for anything that renames, removes, or reinterprets an existing key.
- **Never add secrets.** Auth and tokens belong to MCP servers, not this config.
- **Codebase-agnostic.** All inferred commands come from project manifest files; never hardcode a toolchain.
