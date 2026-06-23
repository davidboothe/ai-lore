---
name: build-waves
description: Execute a wave plan written by plan-waves. Presents pending (incomplete) plans under .ai-lore/plans/ and asks which to build (skips that step if a plan is named). Orchestrates from the main session, running each wave as a parallel fan-out of sonnet/high sub-agents (one per atomic task) via the Workflow tool, gating each task on its acceptance criteria plus the project's checks, updating the plan's status frontmatter as it goes, and checkpointing with you between waves. Invoke to build a plan, e.g. "build-waves", "build-waves the unified-editor plan", "/build-waves".
---

# Build waves

> **Recommended model:** Opus, medium effort. This session IS the orchestrator (it must be the main session, since only the main session can call the Workflow tool). Run it from an Opus session so wave sequencing, gating, and recovery decisions are sound; the per-task build work runs on sonnet/high sub-agents.

Execute a plan produced by `plan-waves`: run its waves in order, each wave as a parallel batch of sub-agents (one per atomic task), gate every task, and record progress in the plan's frontmatter so the run is resumable.

Invoking this skill is the explicit opt-in to use the **Workflow tool** for orchestration.

## 0. Read project config and the run registry

- Read `.ai-lore/config.yaml` (see `templates/config.yaml`) for `gate`, `package_manager`, `test_command`, and `worker.{model,effort}`. If it is missing, **detect the toolchain** (see below), offer to write the file, and proceed with the detected values.
- Read `.ai-lore/runs.yaml` (see `templates/runs.yaml`) if present. This is the registry of plan builds for this repo: which plans are active, in which worktree/branch, their lock, and rollup progress. Create it empty if absent.

**Detecting the toolchain (when config.yaml is missing).** This plugin is codebase-agnostic. Identify the ecosystem from the manifest and lock files at the repo root, then infer `gate` and `test_command` from that ecosystem's conventional commands plus any project-declared scripts or tasks:

- **Node / JS / TS**: `package.json` (manager from lockfile: `pnpm-lock.yaml` -> pnpm, `package-lock.json` -> npm, `yarn.lock` -> yarn, `bun.lockb` -> bun); read `scripts` for real check/lint/typecheck/test.
- **Python**: `pyproject.toml` (manager: `uv.lock` -> uv, `poetry.lock` -> poetry, else pip/hatch) or `requirements.txt`; gate `ruff check .` plus `mypy .`, test `pytest`.
- **Rust**: `Cargo.toml` -> cargo; gate `cargo clippy --all-targets` plus `cargo build`, test `cargo test`.
- **Go**: `go.mod` -> go; gate `go vet ./...` plus `go build ./...`, test `go test ./...`.
- **Ruby**: `Gemfile` -> bundler. **Java / Kotlin**: `pom.xml` -> maven, `build.gradle` -> gradle. **.NET**: `*.sln` / `*.csproj` -> dotnet.
- Honor a `Makefile`, `justfile`, or `Taskfile.yml` with obvious `lint` / `test` / `check` targets, preferring those when present.

If the repo is polyglot or the commands are ambiguous, ask the user rather than guessing.

## 1. Select the plan

- **If the user named a plan** (slug or path), use it. Skip the rest of this step.
- **Otherwise**, scan `.ai-lore/plans/*/plan.md`, read each frontmatter, and list every plan whose `status` is not `complete`, newest first (slugs are date-prefixed). For each show: title, slug, progress (`wave 2/4, 3/7 tasks done`, from frontmatter), and whether the registry shows it **locked** (already being built by another session) or running in a worktree. Ask which to build. If there are none, say so and suggest `plan-waves`.

## 2. Pre-flight

Read `plan.md` and every file in `tasks/`. Then:

- Validate the plan is runnable: each wave's `depends_on` waves exist, same-wave tasks have disjoint `touches` (or are `isolation: worktree`), task ids match the manifest. If something is inconsistent, surface it and ask before proceeding rather than building a broken plan.
- **Check the lock.** If the registry shows this plan locked by another session, warn and ask before continuing (the lock is advisory; the user may override a stale lock). Otherwise acquire it: write `lock: { owner: <this session>, since: <now> }` for this plan in `runs.yaml`.
- **Decide the build location** (see "Concurrency" below): if any other plan is `in_progress` in the registry, this plan builds in its **own git worktree on its own branch** (isolation by default). If no other plan is active, it may build in the main checkout (`worktree: "."`). Record the choice in the run's registry entry, including **`base_branch`** (the branch the worktree was cut from, or the current branch when building in the main checkout); `cleanup` targets PRs at it.
- Determine the **next runnable wave**: the lowest-id wave whose `status` is not `complete` and whose `depends_on` waves are all `complete`. This makes the run **resumable**: already-complete waves and tasks are skipped.
- Confirm the starting point with the user (which wave, how many tasks, which checkout/worktree), then begin.

## Concurrency, worktrees, and the registry

Run state lives in `plan.md` / `tasks/*.md` frontmatter, and `.ai-lore/` is gitignored (per-clone execution state). To build several plans at once without tangling their status or their file edits:

- **One worktree per concurrently-built plan.** A plan that starts while another is active is built in its own git worktree (created under `config.worktrees.dir`, e.g. `../<repo>-wt/<slug>`) on its own branch (`plan/<topic>`). Because each worktree holds exactly one plan, that plan's status frontmatter has a **single writer**, so it never gets complicated by concurrency. When the plan completes, merge or PR its branch.
- **The registry `.ai-lore/runs.yaml` is the only cross-plan shared file.** It maps each plan to its `worktree`, `branch`, `lock`, and rollup `progress`, so any session can see what is running where without reading into other worktrees. Keep it small; it is a pointer index, not a copy of plan content. Last-writer-wins is fine for its tiny records.
- **The lock is advisory**, keyed by plan in the registry: set on pickup, cleared on finish or clean exit, overridable by the user when stale.
- The within-plan worktree isolation that `plan-waves` may mark on individual tasks (`isolation: worktree`) is a separate, transient mechanism for same-wave file overlaps; it composes with, but is independent of, this whole-plan isolation.

## 3. Run one wave at a time (Workflow tool)

Process exactly **one wave per Workflow call** so you can checkpoint between waves. For the current wave, build only its tasks whose `status` is not `complete`.

Author a Workflow script that fans the wave's tasks out in parallel. Each task becomes one `agent()` call with:

- `model` and `effort` from config (`worker.model` / `worker.effort`, default `sonnet` / `high`). Pass them in via `args`.
- `isolation: 'worktree'` only when the task's frontmatter says `isolation: worktree`.
- A `schema` that forces a compact structured return (see return contract below) so sub-agents return only what matters, not narration or diffs.
- A prompt that passes the **task file path** and minimal context, and instructs the worker to: read its task file, do the todos, mirror the cited existing pattern, self-check each AC with evidence, and return only the schema. The worker must not touch files outside its `touches` set.

Sketch (adapt task list and paths per wave):

```js
export const meta = {
  name: 'build-wave',
  description: 'Build one wave of a plan: parallel sub-agents, one per atomic task',
  phases: [{ title: 'Build' }],
}
const TASKS = args.tasks            // [{ id, file, isolation }] for the current wave
const WORKER = args.worker          // { model, effort } from .ai-lore/config.yaml
const RETURN = {
  type: 'object',
  required: ['task_id', 'outcome', 'ac', 'files_changed', 'summary'],
  properties: {
    task_id: { type: 'string' },
    outcome: { enum: ['complete', 'blocked'] },
    ac: { type: 'array', items: { type: 'object',
      required: ['criterion', 'pass'],
      properties: { criterion: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' } } } },
    files_changed: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },     // under 80 words
    blocker: { type: 'string' },
  },
}
const results = await parallel(TASKS.map(t => () =>
  agent(
    `You are building one atomic task of a larger plan. Read the task file at ${t.file} and execute it.\n` +
    `Do its todos, follow the project's CLAUDE.md conventions, and edit ONLY the files in the task's "touches" list.\n` +
    `Self-check every acceptance criterion and report pass/fail with brief evidence.\n` +
    `Return ONLY the structured result: outcome, ac, files_changed, a summary under 80 words, and a blocker if blocked. No diffs, no narration.`,
    { label: `task:${t.id}`, phase: 'Build', model: WORKER.model, effort: WORKER.effort, schema: RETURN,
      ...(t.isolation === 'worktree' ? { isolation: 'worktree' } : {}) }
  )
)).filter(Boolean)
return results
```

Pass `args` as `{ tasks: [...], worker: { model, effort } }`. Before launching, mark each task you are about to build `in_progress` in its task file and reflect the wave as `in_progress` in `plan.md`.

## 4. Gate and record (the orchestrator's job)

This main session is the **sole writer of status frontmatter** (workers return data; they do not edit the manifest). After the Workflow call returns:

1. For each result, decide the task outcome. A task is **complete** only if the worker reports `outcome: complete` AND every AC passed.
2. Run the **project gate** once for the wave: the commands in `config.gate` (whatever this project uses, e.g. `pnpm check` / `cargo clippy` / `pytest`), run in the plan's checkout or worktree. If the gate fails, do not mark dependent work complete; attribute the failure to the offending task(s) where possible.
3. Update state (this session is the sole writer):
   - In each task file: set `status` to `complete` or `blocked`.
   - In `plan.md`: set the wave `status` to `complete` if all its tasks are complete, else `blocked`. Update the overall plan `status` (`in_progress`, or `complete` when the last wave passes, or `blocked`).
   - In `.ai-lore/runs.yaml`: update this run's `progress` (wave, tasks done/total) and `updated` timestamp.
4. **Commit the wave** once it has passed the gate: one commit in the plan's checkout/worktree whose message names the wave and its tasks (e.g. `build-waves: wave 2 (tasks 2-1, 2-2)`). One commit per wave keeps history atomic and gives `cleanup` a committed branch to PR or merge. Note: `.ai-lore/` is gitignored, so the status frontmatter you just wrote is not part of the commit; the commit is the code only. Do this after the gate passes, never per task (parallel tasks share one worktree index).
5. A task that fails its AC or the gate is `blocked`, never `complete`. Surface blockers clearly; do not paper over them.

## 5. Checkpoint between waves

After recording, report a compact summary: wave name, tasks complete vs blocked, files changed, gate result, and any blockers. Then **pause for the user's go-ahead** before starting the next wave. If the user says to run autonomously ("just run them all"), continue wave to wave without pausing, still gating and recording each, and stop only on a gate failure or a blocked task.

## 6. Finish

When the final wave is complete: set the plan `status: complete`, verify the plan's **global acceptance criteria**, then in `runs.yaml` set the run `status: complete` and clear its `lock`. Report: waves run, tasks completed, anything left blocked, the branch/worktree, and the files touched across the run.

Then **ask whether to launch `cleanup`** to ship the work (open a PR or merge the branch and tear down the worktree). If the user agrees, invoke the `cleanup` skill for this plan; if not, leave the branch/worktree in place for later (the registry entry is what `cleanup` picks up).

Always clear the registry `lock` on exit, even on a blocked or aborted run, so the plan is not left falsely locked.

## Recovery

If a task is blocked: report the blocker and ask whether to retry it (re-run just that task), amend the task file, or stop. On a later `build-waves` invocation the plan resumes from frontmatter, so a partial run is safe to pick up where it left off.

## Principles

- **Main session orchestrates; sub-agents build.** Only the main session calls Workflow; workers are sonnet/high and return compact structured results.
- **One wave per Workflow call.** Enables the between-wave checkpoint and keeps frontmatter updates deterministic.
- **Frontmatter is the single source of truth for progress,** written only by the orchestrator. This is what makes runs resumable.
- **Gate before complete.** Worker self-report plus the project's gate (from `config.gate`); failing either means blocked, not complete.
- **Config-driven, not hardcoded.** Package manager, gate, test command, and worker model/effort all come from `.ai-lore/config.yaml`; nothing assumes a particular language.
- **One worktree per concurrent plan; the registry is the only shared file.** Single-writer status per plan, advisory lock to prevent double-builds.
- **No em dashes** in anything written back to the plan or registry files.
