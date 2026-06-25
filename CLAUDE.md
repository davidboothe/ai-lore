# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ai-lore is a Claude Code plugin (no build step, no runtime). It ships six skills -- `ai-lore` (master entry point), `ail-config` (config validation and migration), `ail-plan-waves`, `ail-build-waves`, `ail-review`, and `ail-cleanup` -- that decompose a goal into waves of atomic tasks, orchestrate their parallel execution via the Workflow tool, review the finished code across four dimensions, and ship the result as a PR or merge.

## Development workflow

There is no build, lint, or test pipeline. The plugin is pure Markdown skill definitions and YAML config templates. To develop:

1. Clone the repo.
2. Point the Claude Code marketplace at the local path:
   ```
   /plugin marketplace add /absolute/path/to/ai-lore
   /plugin install ai-lore@ai-lore
   ```
3. Changes take effect after reloading Claude Code.

To verify skills are loaded: `/plugin` opens the plugin manager; the skills appear as `/ai-lore`, `/ail-config`, `/ail-plan-waves`, `/ail-build-waves`, `/ail-review`, `/ail-cleanup`.

## Architecture

The plugin has six skills. The typical flow is:

```
ai-lore  ->  ail-config  ->  (state check)  ->  ail-plan-waves
                                             ->  ail-build-waves
                                             ->  ail-review
                                             ->  ail-cleanup
```

`ai-lore` is the master entry point. It always runs `ail-config` first, then reads project state via a deterministic Workflow script, and routes to the right skill based on what is waiting. The pipeline skills can also be invoked directly.

**State** lives under `.ai-lore/` in the **target project** (gitignored, per-clone):
- `config.yaml` -- gate commands, test command, worktree settings, and `plugin_version`.
- `runs.yaml` -- registry of active builds (the only cross-plan shared file; last-writer-wins). Includes optional `review_status` and `review_file` fields written by `ail-review`.
- `plans/<YYYY-MM-DD-slug>/plan.md` -- plan manifest with YAML frontmatter (status for plan + each wave).
- `plans/<YYYY-MM-DD-slug>/tasks/<wave-n>-<topic>.md` -- one file per atomic task with frontmatter, todos, and AC.
- `plans/<YYYY-MM-DD-slug>/review.md` -- findings report written by `ail-review` (one per review run).

### ai-lore

The master entry point. Accepts an optional argument for direct routing (e.g. `/ai-lore plan a login page`, `/ai-lore build`, `/ai-lore review`, `/ai-lore cleanup`). When invoked without an argument, it: runs `ail-config`, executes a Workflow state-check script to read `runs.yaml` and plan frontmatter, and presents a context-aware menu (plan something new, build a pending plan, resume an active build, review a completed build, ship a completed build, investigate a blocked build). Routes to the chosen skill.

### ail-config

Validates and patches `.ai-lore/config.yaml` in the target project. Embeds the current plugin version (`0.7.0`) as a constant and compares it against `plugin_version` in the config to detect when migration is needed. Auto-patches new optional keys for minor/patch bumps; prompts for potentially breaking changes. Creates the config from the template with auto-detected toolchain values if it is missing. All other skills may delegate to this one rather than duplicating detection logic.

### ail-plan-waves

Brainstorms a goal, asks questions, decomposes into atomic tasks packed into dependency-ordered waves (tasks in a wave have disjoint `touches`), and writes the plan folder. Always brainstorms before writing -- never plans straight from the prompt. Outputs `plan.md` and per-task files following the templates in `skills/plan-waves/templates/`.

Wave packing rule: same-wave tasks must have disjoint `touches`. If overlap is unavoidable, mark the task `isolation: worktree` so ail-build-waves runs it in an isolated worktree and merges after.

### ail-build-waves

The orchestrator. Runs from the **main session** (only it can call the Workflow tool). For each wave, it:
1. Marks tasks `in_progress`, fans them out via the Workflow tool (one `agent()` call per task, all in parallel).
2. Collects structured results (workers return `{ outcome, ac, files_changed, summary, blocker }` -- no narration).
3. Runs the project gate (`config.gate`) once for the wave.
4. Writes status frontmatter back to task files and `plan.md` -- the **orchestrator is the sole writer of status frontmatter**.
5. Commits the wave's code (one commit per wave, naming the wave and task ids).
6. Checkpoints with the user before the next wave.

By default each plan builds in its own git worktree on a `plan/<topic>` branch, cut from the committed tip of the base branch. This keeps uncommitted work in the main checkout out of the build. The worktree location comes from `config.worktrees.dir`.

### ail-review

Fans out four parallel dimension agents (correctness, security, quality, test coverage) via the Workflow tool to review the code changes on a completed plan's branch. Writes a findings report to `.ai-lore/plans/<slug>/review.md`, prints an inline summary, and records `review_status` in `runs.yaml`. Report-only: it surfaces findings but does not gate cleanup. Offers to proceed to cleanup when the review is done. Invokable standalone or offered automatically by `ail-build-waves` after the final wave.

### ail-cleanup

Reads the registry, targets the completed plan's branch/worktree, and either opens a PR or merges locally then tears down. Remote detection: `dev.azure.com` / `*.visualstudio.com` -> `azure-devops` MCP; `github.com` -> `gh` CLI; anything else -> manual fallback. Always confirms before pushing, opening a PR, merging into a non-main branch, or deleting a worktree/branch.

Teardown order is enforced: merge first, remove worktree, delete branch.

## Key invariants

- **No em dashes** in any file written by these skills (plan files, task files, registry, config, PR bodies). Use commas, semicolons, parentheses, or periods instead.
- **Status frontmatter is written only by the ail-build-waves orchestrator**, never by task sub-agents. Workers return structured data; the orchestrator updates files.
- **`runs.yaml` is the only cross-plan shared file.** Everything else is per-plan and single-writer.
- **AC must be objectively checkable.** Avoid "works correctly"; prefer "`<test_command> <file>` passes" or "symbol X is exported from file Y".
- **The plugin is codebase-agnostic.** Gate and test commands come from `.ai-lore/config.yaml` or are auto-detected from manifest files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.). Never hardcode a toolchain.
- **ail-build-waves requires Opus.** The ail-plan-waves skill also recommends Opus for decomposition quality. ail-review, ail-config, and ail-cleanup work on any model (their sub-agents run on sonnet).
- **ail-config embeds the canonical plugin version.** When bumping the plugin version, update `plugin_version` in `skills/config/SKILL.md`, all three `config.yaml` templates, and both manifest files.
- **ail-review is report-only.** It never blocks cleanup or modifies the plan's branch. Findings are written to `review.md` and the inline summary; the user decides what to act on.

## File layout

```
.claude-plugin/
  plugin.json          # plugin metadata (name, version, author)
  marketplace.json     # marketplace index pointing to plugin.json
agents/
  task-executor.md        # sonnet/high: executes one atomic task per wave; returns structured result
  test-check-executor.md  # haiku/low: runs tests and checks; returns pass or full failure output
  plan-reviewer.md        # sonnet/medium: adversarially reviews a plan before build; catches structural issues
  code-reviewer.md        # sonnet/medium: reviews one dimension of code changes (correctness, security, quality, or test_coverage); returns structured findings
  blocker-investigator.md # sonnet/medium: investigates a blocked task and proposes a concrete resolution
  pr-body-writer.md       # haiku/low: writes PR title and body from plan summary and wave history
  ac-verifier.md          # haiku/low: independently reruns ACs claimed as passing by task-executor
  toolchain-detector.md   # haiku/low: detects package manager, gate, and test command from manifest files
skills/
  ai-lore/
    SKILL.md           # master entry point (config check, state Workflow, menu, routing)
  config/
    SKILL.md           # config validation, version migration, toolchain detection
    templates/
      config.yaml      # canonical config template (plugin_version, gate, test_command, worktrees)
  plan-waves/
    SKILL.md           # full skill spec (brainstorm, decompose, wave packing)
    templates/         # config.yaml, plan.md, task.md
  build-waves/
    SKILL.md           # full skill spec (orchestration, Workflow, gating, recovery)
    templates/         # config.yaml, runs.yaml
  review/
    SKILL.md           # full skill spec (fan-out dimension agents, synthesize, write review.md)
  cleanup/
    SKILL.md           # full skill spec (PR/merge/teardown, ADO setup)
    templates/         # ado.yaml
workflows/
  state-check.js       # Workflow script for ai-lore state read (ai-lore skill, step 2)
  build-wave.js        # Workflow script for one wave fan-out (ail-build-waves skill, step 3)
  review-dimensions.js # Workflow script for parallel dimension review (ail-review skill, step 3)
```

The SKILL.md files are the authoritative specs for how each skill behaves. When editing skill behavior, that is where to look and edit.

The `workflows/` directory contains the Workflow tool scripts referenced by skills via `scriptPath`. Skills derive the plugin root from the known absolute path of their own SKILL.md file (strip the trailing `/skills/<name>/SKILL.md`) and call `Workflow({ scriptPath: '<plugin_root>/workflows/<name>.js' })`. This makes workflow logic a versioned, diffable artifact rather than prose embedded in SKILL.md.
