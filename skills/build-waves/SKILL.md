---
name: ail-build-waves
description: Execute a wave plan written by ail-plan-waves. Presents pending (incomplete) plans under .ai-lore/plans/ and asks which to build (skips that step if a plan is named). Orchestrates from the main session, running each wave as a parallel fan-out of task-executor sub-agents (one per atomic task) via the Workflow tool, gating each task on its acceptance criteria plus the project's checks, updating the plan's status frontmatter as it goes, and checkpointing with you between waves. Invoke to build a plan, e.g. "ail-build-waves", "ail-build-waves the unified-editor plan", "/ail-build-waves".
---

# Build waves

> **Recommended model:** Opus, medium effort. This session IS the orchestrator (it must be the main session, since only the main session can call the Workflow tool). Run it from an Opus session so wave sequencing, gating, and recovery decisions are sound; the per-task build work runs on `ai-lore:task-executor` sub-agents.

Execute a plan produced by `ail-plan-waves`: run its waves in order, each wave as a parallel batch of sub-agents (one per atomic task), gate every task, and record progress in the plan's frontmatter so the run is resumable.

Invoking this skill is the explicit opt-in to use the **Workflow tool** for orchestration.

## 0. Read project config and the run registry

- Read `.ai-lore/config.yaml` for `gate`, `package_manager`, `test_command`, and `worktrees.{default,dir}`. If it is missing, invoke `ai-lore:toolchain-detector` with the repo root path to detect the toolchain. If the detector returns `ambiguous: true`, ask the user to clarify before proceeding. Offer to write the config from the canonical template at `<plugin_root>/skills/config/templates/config.yaml` (where `<plugin_root>` is derived by stripping `/skills/build-waves/SKILL.md` from this skill file's absolute path), then proceed with the detected values (`worktrees.default` defaults to `true`).
- Read `.ai-lore/runs.yaml` (see `templates/runs.yaml`) if present. This is the registry of plan builds for this repo: which plans are active, in which worktree/branch, their lock, and rollup progress. Create it empty if absent.

## 1. Select the plan

- **If the user named a plan** (slug or path), use it. Skip the rest of this step.
- **Otherwise**, scan `.ai-lore/plans/*/plan.md`, read each frontmatter, and list every plan whose `status` is not `complete`, newest first (slugs are date-prefixed). For each show: title, slug, progress (`wave 2/4, 3/7 tasks done`, from frontmatter), and whether the registry shows it **locked** (already being built by another session) or running in a worktree. Ask which to build. If there are none, say so and suggest `ail-plan-waves`.

## 2. Pre-flight

Read `plan.md` and every file in `tasks/`. Then:

- Validate the plan is runnable: each wave's `depends_on` waves exist, same-wave tasks have disjoint `touches` (or are `isolation: worktree`), task ids match the manifest. If something is inconsistent, surface it and ask before proceeding rather than building a broken plan.
- **Run `ai-lore:plan-reviewer`** against the plan directory. If it returns blocking issues (overlapping touches without isolation, missing dependency edges), surface them and require the user to fix the plan before continuing. Advisory issues (subjective ACs, insufficient context) are shown as warnings but do not block the build.
- **Check the lock.** If the registry shows this plan locked by another session, warn and ask before continuing (the lock is advisory; the user may override a stale lock). Otherwise acquire it: write `lock: { owner: <this session>, since: <now> }` for this plan in `runs.yaml`.
- **Decide the build location** (see "Concurrency" below): **default to a dedicated git worktree on its own branch**, cut from the committed tip of a clean base. This is the default whether or not another plan is active, because a worktree only ever sees committed work, so in-progress, uncommitted edits in the main checkout can never leak into the build. Build directly in the main checkout (`worktree: "."`) only when the user explicitly asks, or when `worktrees.default` is `false` in config. Record the choice in the run's registry entry, including **`base_branch`** (the branch the worktree was cut from, or the current branch when building in the main checkout); `ail-cleanup` targets PRs at it.
- **Ensure a stable base.** Choose the base branch (default: the current branch, falling back to `main`/`master`) and cut the worktree from its committed tip, so the build always starts from a known-good state. If the base has uncommitted changes the user means to build on, warn that a worktree will not include them (offer to let them commit or stash first); otherwise that exclusion is exactly the isolation we want.
- Determine the **next runnable wave**: the lowest-id wave whose `status` is not `complete` and whose `depends_on` waves are all `complete`. This makes the run **resumable**: already-complete waves and tasks are skipped.
- Confirm the starting point with the user (which wave, how many tasks, which checkout/worktree), then begin.

## Concurrency, worktrees, and the registry

Run state lives in `plan.md` / `tasks/*.md` frontmatter, and `.ai-lore/` is gitignored (per-clone execution state). Worktrees serve two purposes here: keeping each build isolated from in-progress work, and letting several plans build at once without tangling their status or their file edits.

- **One worktree per plan, by default.** Every build runs in its own git worktree (created under `config.worktrees.dir`, e.g. `.ai-lore/worktrees/<slug>`) on its own branch (`plan/<topic>`), cut from the committed tip of its base branch. That delivers a **stable, isolated base** (uncommitted work in the main checkout cannot leak in) and **safe concurrency** (each worktree holds exactly one plan, so that plan's status frontmatter has a single writer) at the same time. Building in the main checkout is an explicit opt-out, not the default. When the plan completes, merge or PR its branch.
- **The registry `.ai-lore/runs.yaml` is the only cross-plan shared file.** It maps each plan to its `worktree`, `branch`, `lock`, and rollup `progress`, so any session can see what is running where without reading into other worktrees. Keep it small; it is a pointer index, not a copy of plan content. Last-writer-wins is fine for its tiny records.
- **The lock is advisory**, keyed by plan in the registry: set on pickup, cleared on finish or clean exit, overridable by the user when stale.
- The within-plan worktree isolation that `ail-plan-waves` may mark on individual tasks (`isolation: worktree`) is a separate, transient mechanism for same-wave file overlaps; it composes with, but is independent of, this whole-plan isolation.

## 3. Run one wave at a time (Workflow tool)

Process exactly **one wave per Workflow call** so you can checkpoint between waves. For the current wave, build only its tasks whose `status` is not `complete`.

Execute the bundled workflow script that fans the wave's tasks out in parallel. Each task becomes one `agent()` call using `ai-lore:task-executor`, with `isolation: 'worktree'` only when the task frontmatter says so, and a schema that forces a compact structured return.

**Find the plugin root:** This skill file is at `<plugin_root>/skills/build-waves/SKILL.md`. Strip the trailing `/skills/build-waves/SKILL.md` from this file's absolute path to get `<plugin_root>`.

Call `Workflow({ scriptPath: '<plugin_root>/workflows/build-wave.js', args: { tasks: [...] } })` where `tasks` is `[{ id, file, isolation }]` for each task in the current wave.

Before launching, mark each task you are about to build `in_progress` in its task file and reflect the wave as `in_progress` in `plan.md`.

The return contract each worker must satisfy:

```
{ task_id, outcome: 'complete'|'blocked', ac: [{ criterion, pass, evidence }], files_changed: [...], summary, blocker? }
```

## 4. Gate and record (the orchestrator's job)

This main session is the **sole writer of status frontmatter** (workers return data; they do not edit the manifest). After the Workflow call returns:

1. For each result where the worker reports `outcome: complete`, invoke `ai-lore:ac-verifier` with the task file path and the AC list from the worker result. Run all ac-verifier calls in parallel. A task is **complete** only if the worker reports `outcome: complete` AND the verifier confirms all verifiable ACs pass.
2. Run the **project gate** once for the wave: for each command in `config.gate`, invoke `ai-lore:test-check-executor` with the command string, run from the plan's checkout or worktree directory. Run gate commands sequentially (one failure stops the rest). If any command fails, do not mark dependent work complete; use the executor's returned `output` field to attribute the failure to the offending task(s) where possible. The `test-check-executor` agent is also the right tool for running task-level acceptance criteria that are shell commands, when `ac-verifier` determines an AC is mechanically runnable.
3. Update state (this session is the sole writer):
   - In each task file: set `status` to `complete` or `blocked`.
   - In `plan.md`: set the wave `status` to `complete` if all its tasks are complete, else `blocked`. Update the overall plan `status` (`in_progress`, or `complete` when the last wave passes, or `blocked`).
   - In `.ai-lore/runs.yaml`: update this run's `progress` (wave, tasks done/total) and `updated` timestamp.
4. **Commit the wave** once it has passed the gate: one commit in the plan's checkout/worktree whose message names the wave and its tasks (e.g. `ail-build-waves: wave 2 (tasks 2-1, 2-2)`). One commit per wave keeps history atomic and gives `ail-cleanup` a committed branch to PR or merge. Note: `.ai-lore/` is gitignored, so the status frontmatter you just wrote is not part of the commit; the commit is the code only. Do this after the gate passes, never per task (parallel tasks share one worktree index).
5. A task that fails its AC or the gate is `blocked`, never `complete`. Surface blockers clearly; do not paper over them.

## 5. Checkpoint between waves

After recording, report a compact summary: wave name, tasks complete vs blocked, files changed, gate result, and any blockers. Then **pause for the user's go-ahead** before starting the next wave. If the user says to run autonomously ("just run them all"), continue wave to wave without pausing, still gating and recording each, and stop only on a gate failure or a blocked task.

## 6. Finish

When the final wave is complete: set the plan `status: complete`, verify the plan's **global acceptance criteria**, then in `runs.yaml` set the run `status: complete` and clear its `lock`. Report: waves run, tasks completed, anything left blocked, the branch/worktree, and the files touched across the run.

**Offer code review.** Ask the user: "Run ail-review before cleanup? It fans out parallel agents across correctness, security, quality, and test coverage and produces a report at `.ai-lore/plans/<slug>/review.md`." If the user agrees, invoke `ail-review` for this plan; it will offer to proceed to cleanup when it finishes. If the user declines, proceed to the cleanup offer below.

**Ask whether to launch `ail-cleanup`** to ship the work (open a PR or merge the branch and tear down the worktree). If the user agrees, invoke the `ail-cleanup` skill for this plan; if not, leave the branch/worktree in place for later (the registry entry is what `ail-cleanup` picks up). Skip this prompt if `ail-review` was run and the user already answered the cleanup question there.

Also check if `.ai-lore-docs/` exists in the project root. If it does, note that the build changed files and the docs for those directories are now stale. Offer a targeted documentation update: collect the unique directories from `files_changed` across all completed task results, then invoke `ail-document` with only those directories (e.g. `ail-document src/api src/models`). If `.ai-lore-docs/` does not exist, offer to run a first-time documentation pass with `/ail-document` (no arguments). Present this as a yes/no prompt alongside the cleanup offer; do not block the cleanup flow waiting on docs, and do not run both simultaneously.

Always clear the registry `lock` on exit, even on a blocked or aborted run, so the plan is not left falsely locked.

## Recovery

If a task is blocked: invoke `ai-lore:blocker-investigator` with the task file path and the blocker message. Present its `resolution_type` and `suggestion` to the user alongside the options to retry, amend, or stop. If the resolution type is `amend_todos`, offer to apply the suggested todos directly to the task file. On a later `ail-build-waves` invocation the plan resumes from frontmatter, so a partial run is safe to pick up where it left off.

## Principles

- **Main session orchestrates; sub-agents build.** Only the main session calls Workflow; workers run as `ai-lore:task-executor` and return compact structured results.
- **One wave per Workflow call.** Enables the between-wave checkpoint and keeps frontmatter updates deterministic.
- **Frontmatter is the single source of truth for progress,** written only by the orchestrator. This is what makes runs resumable.
- **Gate before complete.** Worker self-report plus the project's gate (from `config.gate`); failing either means blocked, not complete.
- **Config-driven, not hardcoded.** Package manager, gate, and test command all come from `.ai-lore/config.yaml`; nothing assumes a particular language.
- **Worktree by default; the registry is the only shared file.** Every build runs in its own worktree cut from a clean committed base (opt out only on request), giving an isolated stable base and single-writer status per plan; an advisory lock prevents double-builds.
- **No em dashes** in anything written back to the plan or registry files.
