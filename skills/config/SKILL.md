---
name: ail-config
description: Validate and patch .ai-lore/config.yaml in the current project. Checks that all required fields are present, compares the config's plugin_version against the current plugin version (0.13.1), and applies semver migrations (auto-patches new optional keys for minor/patch bumps; prompts before breaking changes). Creates the config from the template with auto-detected toolchain values if it is missing. Safe to run standalone or as a pre-flight step before any other ai-lore skill. e.g. "check my ai-lore config", "/ail-config".
---

# ail-config

Validate and (if needed) patch `.ai-lore/config.yaml` for the current project. This skill is the canonical place to create or migrate a config; every other ai-lore skill may delegate here rather than duplicating detection logic.

**Current plugin version: 0.13.1**

---

## Config schema (v0.13.1)

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

Compare the `plugin_version` value in the config (call it `config_version`) against the current plugin version `0.13.1`.

**If `plugin_version` is absent** (v0.1 config -- this field did not exist before 0.4.0):
- This is a non-breaking migration. Auto-patch: add `plugin_version: 0.13.1` at the top of the file (after any leading comment block), then apply all migration table entries in order. Report what was added or removed.

**If `config_version == plugin_version`** (up to date):
- Validate all required fields are present and non-null (see schema). Report any missing required fields and offer to add sensible defaults. Otherwise proceed to the structural completeness check (step 3d).

**If `config_version` is a lower minor or patch than `0.13.1`** (e.g. `0.1.x`, `0.4.0`, `0.5.0`):
- Apply the migration table below, adding any new optional fields with their defaults. Report each change made. Do NOT remove or rename existing keys. Proceed to the structural completeness check (step 3d) after applying migrations.

**If `config_version` is a higher version than `0.13.1`**:
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
| 0.7.0 | 0.7.1 | No config changes. Bug fixes and internal improvements: state-check workflow now includes `review_status` in `cleanup_eligible` results so the ai-lore menu can show review state; ail-plan-waves gains a formal argument check section and brainstorm context loading step; ail-build-waves documents `ai-lore:test-check-executor` as the gate execution mechanism; ail-document workflow scripts extracted from inline prose to versioned `.js` files under `workflows/`; ail-brainstorm resume detection now respects the `html_generated` flag and Step 7 includes a Node.js prerequisite check. Update `plugin_version` to `0.7.1`. |
| 0.7.1 | 0.7.2 | No config changes. ail-brainstorm adds Step 1.5 (free-form initial description before the structured Phase 1 interview); Phase 1 now skips questions already answered in the initial description. Update `plugin_version` to `0.7.2`. |
| 0.7.2 | 0.7.3 | No config changes. ail-brainstorm handoff updated to target ail-architect instead of ail-plan-waves; Phase 3 interview questions reframed as user-facing constraints; technical.md renamed to constraints.md in brainstorm output; new "Stay user-facing" principle added. Update `plugin_version` to `0.7.3`. |
| 0.7.3 | 0.7.5 | No config changes. Bug fixes: all workflow scripts now guard args destructuring against undefined/null and emit a diagnostic log line on startup; plugin root derivation instructions clarified in all skills to prevent path construction errors; brainstorm-panel agent updated to read constraints.md instead of technical.md (syncing with the rename in 0.7.3). Update `plugin_version` to `0.7.5`. |
| 0.7.5 | 0.7.6 | New optional config field: add `plan.html_preview: false` under a `plan:` block. Also: ail-config now runs a structural completeness check (step 3d) after every path to guarantee all schema fields are present. Update `plugin_version` to `0.7.6`. |
| 0.7.6 | 0.8.0 | No config changes. Workflow scripts moved from external `workflows/*.js` files to inline `script` parameters in each SKILL.md. The `workflows/` directory has been removed. Update `plugin_version` to `0.8.0`. |
| 0.8.0 | 0.9.0 | No config changes. ail-document reworked into a concept-first knowledge graph: dense cross-directory concept docs under `.ai-lore-docs/concepts/`, an interlinked module/concept graph with edges in frontmatter, a `.ai-lore-docs/index.md` path lookup, and an optional user-owned `.ai-lore-docs/concepts.seed.yaml` inventory. New agent `concept-synthesizer`; `docs-synthesizer` reduced to overview-only; new deterministic linker `scripts/build-links.js` (requires Node.js). Update `plugin_version` to `0.9.0`. |
| 0.9.0 | 0.10.0 | No config changes. Added a decision node type to the ai-lore knowledge graph: design-time decisions are captured during ail-architect and ail-plan-waves, promoted into `.ai-lore-docs/` at ail-cleanup, and surfaced via `build-links.js --recall`, injected `## Decisions` sections, and a rendered `decisions.md` log. Update `plugin_version` to `0.10.0`. |
| 0.10.0 | 0.10.1 | No config changes. Bug fix: all inline Workflow scripts now normalize `args` through a shared `_args()` helper that JSON-parses string-delivered payloads (single or double encoded) before destructuring, and throw a `FATAL` error when a required field arrives empty instead of silently returning a zero-work result. Fixes ail-document (and other skills) documenting 0 directories when the harness delivered `args` as a JSON string. Update `plugin_version` to `0.10.1`. |
| 0.10.1 | 0.11.0 | No config changes. Repo-wide fix batch. Build flow: the build-wave Workflow now requires a `workdir` arg (the plan's worktree or the project root) threaded through task-executor, ac-verifier, and the gate; task-level `isolation: worktree` changes are explicitly merged back before the gate. Lifecycle: the state check and menu now surface `submitted` runs, and ail-cleanup gains a check-PR/teardown path plus an explicit promotion working directory (writes and linking happen in the plan worktree) and fetch-plus-merge (never unconfirmed rebase) base refresh. Reviews: ail-review and code-reviewer use three-dot (merge-base) diffs. Brainstorm: constraints.md rename completed in render-brainstorm.js and brainstorm-adversary; the interview is resumable (`interview_phase` in brainstorm.yaml replaces the unused `team_review`/`adversarial_review` flags); status is set complete before the architect handoff. Decisions: the capture routine's `--recall` call now uses `<plugin_root>`; build-links.js gains CRLF and frontmatter-schema fail-closed validation, supersession-cycle detection, path normalization, temp-then-rename writes, and recall handling of absolute paths. The config template now ships a `plugin_version` placeholder that writing skills must fill. Update `plugin_version` to `0.11.0`. |
| 0.11.0 | 0.12.0 | New optional config field: add `brainstorm.panel` under a `brainstorm:` block, defaulting to the five built-in persona ids (`product_manager`, `end_user_advocate`, `support_ops`, `business_stakeholder`, `feasibility_scout`). ail-brainstorm overhaul: the interview is sized (small or standard), the expert panel roster is WHAT-focused and configurable, panel and adversarial critique run as one merged review Workflow writing structured `review.json` plus `review.md` (replacing `team-review.md` and `adversarial.md`), a findings triage step applies accepted fixes back into the domain files, a one-page `brief.md` synthesis is written last, and a completion contract is tracked in `brainstorm.yaml`. Brainstorm statuses `team-review-done` and `adversarial-done` are replaced by `review-done` and `triaged` (old statuses are still recognized on resume). `render-brainstorm.js` rebuilt as a dashboard with collapsible sections and filterable finding cards. New skill `ail-persona` manages custom review personas under `.ai-lore/personas/`; the generic `brainstorm-panel` agent now receives its perspective spec from the caller. Update `plugin_version` to `0.12.0`. |
| 0.12.0 | 0.13.1 | No config changes. ail-architect redesigned as a fork-first design doc: the material design forks are interviewed via `AskUserQuestion` (with `--recall` hits folded into the option descriptions) before any draft is generated; draft files come from skeleton templates under `skills/architect/templates/` with brainstorm-style writing rules (soft budgets, conditional sections, one home per fact); `overview.md` gains goals and non-goals, a `## Decisions` section holding one subsection per resolved fork, components with owned repo paths, a conditional runtime view, and a risks and open questions section; a new conditional `rollout.md` covers migration, backwards compatibility, and rollback; the decision-capture checkpoint now promotes the `## Decisions` subsections to MADR files and rewrites the section into a link index; the critique roster is rebalanced within the same 8 agents (adversarial modes are now `coherence`, `devils_advocate`, `failure_modes`; panel perspectives are now `security`, `simplicity`, `consistency`, `testability`, `operability`) and the skill runs an inline fidelity check against the brainstorm at synthesis; ail-plan-waves additionally reads the linked decision files, seeds task `touches` from component owned paths, and surfaces unresolved risks as decomposition questions. Update `plugin_version` to `0.13.1`. |

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
   - If both lists are empty and no migration was applied: report "config OK at 0.13.1".

### 4. Create from template (config is missing)

If `.ai-lore/config.yaml` does not exist:

1. **Detect the toolchain** by invoking `ai-lore:toolchain-detector` with the repo root path. If it returns `ambiguous: true`, ask the user to clarify before proceeding.

2. Show the user the detected values (package_manager, gate commands, test_command) and confirm before writing.

3. Create `.ai-lore/` if it does not exist. Write `config.yaml` from `templates/config.yaml` with the detected values filled in and `plugin_version: 0.13.1` set. Report the created file path.

4. **Ensure `.ai-lore/` is gitignored.** Check the project root `.gitignore` for a line that matches `.ai-lore/` or `.ai-lore` (exact match or glob that covers it). If no such line exists, append `.ai-lore/` to `.gitignore` (create the file if it does not exist). Report what was done. Skip this step if there is no `.git/` directory (not a git repo).

### 5. Report

End with a one-line status: `config OK at 0.13.1`, `config migrated 0.5.0 -> 0.13.1`, or `config created at 0.13.1`. If any required fields are still missing after migration/creation (e.g. the user declined to fill in gate commands), list them explicitly so the user knows what to fix before running ail-build-waves.

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
