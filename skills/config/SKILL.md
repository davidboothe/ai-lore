---
name: ail-config
description: Validate and patch .ai-lore/config.yaml in the current project. Checks that all required fields are present, compares the config's plugin_version against the current plugin version (0.7.0), and applies semver migrations (auto-patches new optional keys for minor/patch bumps; prompts before breaking changes). Creates the config from the template with auto-detected toolchain values if it is missing. Safe to run standalone or as a pre-flight step before any other ai-lore skill. e.g. "check my ai-lore config", "/ail-config".
---

# ail-config

Validate and (if needed) patch `.ai-lore/config.yaml` for the current project. This skill is the canonical place to create or migrate a config; every other ai-lore skill may delegate here rather than duplicating detection logic.

**Current plugin version: 0.7.0**

---

## Config schema (v0.7.0)

All fields and their types:

| Field | Type | Required | Default | Since |
|---|---|---|---|---|
| `plugin_version` | string | yes (after 0.4.0) | (set by this skill) | 0.4.0 |
| `package_manager` | string | no | auto-detected | 0.1.0 |
| `gate` | list of strings | yes | auto-detected | 0.1.0 |
| `test_command` | string | yes | auto-detected | 0.1.0 |
| `worktrees.default` | boolean | no | `true` | 0.1.0 |
| `worktrees.dir` | string | no | `.ai-lore/worktrees` | 0.1.0 |

---

## Workflow

### 1. Locate the config

Look for `.ai-lore/config.yaml` relative to the project root (the directory containing `.git`). If the file does not exist, go to **Step 4** (create from template).

### 2. Read and parse the config

Read `.ai-lore/config.yaml`. Parse the YAML. If the file is unparseable, report the error and stop; do not overwrite a corrupted file silently.

### 3. Determine migration status

Compare the `plugin_version` value in the config (call it `config_version`) against the current plugin version `0.7.0`.

**If `plugin_version` is absent** (v0.1 config -- this field did not exist before 0.4.0):
- This is a non-breaking migration. Auto-patch: add `plugin_version: 0.7.0` at the top of the file (after any leading comment block), then apply all migration table entries in order. Report what was added or removed.

**If `config_version == plugin_version`** (up to date):
- Validate all required fields are present and non-null (see schema). Report any missing required fields and offer to add sensible defaults. Otherwise report "config OK at 0.7.0" and stop.

**If `config_version` is a lower minor or patch than `0.7.0`** (e.g. `0.1.x`, `0.4.0`, `0.5.0`):
- Apply the migration table below, adding any new optional fields with their defaults. Report each change made. Do NOT remove or rename existing keys.

**If `config_version` is a higher version than `0.7.0`**:
- The config was written by a newer plugin. Report this and warn the user they may be running an older plugin against a newer config. Do not modify the config.

**If `config_version` has a different major version** (e.g. config says `1.x` but plugin is `0.x`, or vice versa):
- This is a potentially breaking migration. Do NOT auto-patch. Show the user what changed and ask for explicit confirmation before modifying anything.

#### Migration table (cumulative, apply in order)

| From version | To version | Change |
|---|---|---|
| (absent / 0.1.x) | 0.4.0 | Add `plugin_version: 0.4.0` |
| 0.3.x | 0.4.0 | Remove deprecated `worker` block (`worker.model`, `worker.effort`); model and effort are now defined in the `ai-lore:task-executor` agent. Auto-patch: delete the `worker:` key and its children if present. |
| 0.4.0 | 0.4.1 | No config changes. Added `ail-document` skill. Update `plugin_version` to `0.4.1`. |
| 0.4.1 | 0.5.0 | No config changes. Minor version bump: `ail-document` integrations into plan, build, task-executor, and cleanup. Update `plugin_version` to `0.5.0`. |
| 0.5.0 | 0.6.0 | No config changes. Added `ail-review` skill and `ai-lore:code-reviewer` agent. The `runs.yaml` registry gains two optional fields (`review_status`, `review_file`) written by `ail-review`; no migration needed for existing runs. Update `plugin_version` to `0.6.0`. |
| 0.6.0 | 0.6.1 | No config changes. Sub-skills renamed: `ai-lore-config` -> `ail-config`, `ai-lore-plan-waves` -> `ail-plan-waves`, `ai-lore-build-waves` -> `ail-build-waves`, `ai-lore-review` -> `ail-review`, `ai-lore-cleanup` -> `ail-cleanup`, `ai-lore-document` -> `ail-document`. Update `plugin_version` to `0.6.1`. |
| 0.6.1 | 0.6.2 | No config changes. Workflow scripts extracted from SKILL.md prose into versioned `.js` files under `workflows/` (`state-check.js`, `build-wave.js`, `review-dimensions.js`). Skills now invoke them via `Workflow({ scriptPath })` instead of inline script strings. Update `plugin_version` to `0.6.2`. |
| 0.6.2 | 0.7.0 | No config changes. Added `ail-brainstorm` skill with 5-perspective panel review, 3-mode adversarial critique, and HTML preview generation via `scripts/render-brainstorm.js`. New agent files: `brainstorm-panel.md`, `brainstorm-adversary.md`. New workflow scripts: `brainstorm-team.js`, `brainstorm-adversary.js`. Update `plugin_version` to `0.7.0`. |

### 4. Create from template (config is missing)

If `.ai-lore/config.yaml` does not exist:

1. **Detect the toolchain** by invoking `ai-lore:toolchain-detector` with the repo root path. If it returns `ambiguous: true`, ask the user to clarify before proceeding.

2. Show the user the detected values (package_manager, gate commands, test_command) and confirm before writing.

3. Create `.ai-lore/` if it does not exist. Write `config.yaml` from `templates/config.yaml` with the detected values filled in and `plugin_version: 0.7.0` set. Report the created file path.

4. **Ensure `.ai-lore/` is gitignored.** Check the project root `.gitignore` for a line that matches `.ai-lore/` or `.ai-lore` (exact match or glob that covers it). If no such line exists, append `.ai-lore/` to `.gitignore` (create the file if it does not exist). Report what was done. Skip this step if there is no `.git/` directory (not a git repo).

### 5. Report

End with a one-line status: `config OK at 0.7.0`, `config migrated 0.5.0 -> 0.7.0`, or `config created at 0.7.0`. If any required fields are still missing after migration/creation (e.g. the user declined to fill in gate commands), list them explicitly so the user knows what to fix before running ail-build-waves.

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
- **No em dashes** in any file written by this skill (commas, semicolons, parentheses, periods instead).
