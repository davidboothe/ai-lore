---
name: ail-plan-waves
description: Brainstorm and plan a piece of work as parallel "waves" of atomic tasks, then write it to .ai-lore/plans/<slug>/ for ail-build-waves to execute. Always asks questions and gives recommendations with reasons before committing a plan. Decomposes work into waves whose tasks run in parallel (disjoint files), each task carrying its own todos and checkable acceptance criteria, with a status-tracking frontmatter manifest. Invoke when starting to plan a feature, refactor, or migration for parallel execution, e.g. "ail-plan-waves the unified editor", "let's wave-plan the export pipeline", "/ail-plan-waves".
---

# Plan waves

> **Recommended model:** Opus. This is heavy decomposition and dependency analysis; the plan is the contract every `ail-build-waves` worker reads, so getting the wave boundaries and acceptance criteria right matters more than speed.

Turn a goal into an ordered set of **waves**. A wave is a group of **atomic tasks** that have no dependencies on each other, so they run in parallel. Later waves depend on earlier ones. Each atomic task is a unit one sub-agent can own end to end: it carries its own todos and its own acceptance criteria (AC). The output is a folder under `.ai-lore/plans/` that `ail-build-waves` executes mechanically.

This skill **always brainstorms and asks questions.** Never write a plan straight from the prompt. Surface the decisions, recommend, and get sign-off first.

## 0. Argument check

Before anything else, note the arguments passed to this skill:

- **`goal`**: a goal or topic string pre-seeded by the caller (e.g. from `/ai-lore plan <goal text>`). If present, use it as the starting goal and skip asking for one in step 4.
- **`brainstorm_dir`**: absolute path to a completed brainstorm directory under `.ai-lore/brainstorm/<slug>/`. If present, read the brainstorm files in step 3 before any other grounding.
- **`slug`**: a pre-existing slug (e.g. from `ail-architect` or a prior session) to use instead of generating a new one in step 8. If present, check for an approved architecture at `.ai-lore/plans/<slug>/architecture/overview.md` in step 2.

## Inputs

- A **goal or topic** to plan (a feature, refactor, migration, cleanup). Any shape: a sentence, a doc link, a rough idea.
- If the goal is vague, that is expected. Brainstorm it into shape rather than asking the user to pre-specify.

## Output location

Plans live **in the current project** at `.ai-lore/plans/<slug>/`, where `<slug>` is `YYYY-MM-DD-topic` (date-prefixed, kebab-case topic). Use today's date. Plans are repo-bound: task files reference this repo's paths. `.ai-lore/` is gitignored (per-clone execution state).

A plan folder contains:

- `plan.md`: the manifest. Status frontmatter (plan + every wave) plus the goal, context, global AC, and a wave/task index. See `templates/plan.md`.
- `tasks/<wave>-<n>-<topic>.md`: one file per atomic task. Status frontmatter (status, isolation, `touches`, `depends_on`) plus context, todos, AC, and the return contract. See `templates/task.md`.

## Workflow

### 1. Read (or create) project config

Read `.ai-lore/config.yaml` for the project's `package_manager`, `gate`, and `test_command`. If it is missing, invoke `ai-lore:toolchain-detector` with the repo root path. If the detector returns `ambiguous: true`, ask the user to clarify. Then offer to write `.ai-lore/config.yaml` from the canonical config template at `<plugin_root>/skills/config/templates/config.yaml` (where `<plugin_root>` is this file's absolute path with exactly `/skills/plan-waves/SKILL.md` removed from the end -- do NOT keep `skills/plan-waves/` in the result) with the detected values (the same schema ail-build-waves uses). The template ships a placeholder `plugin_version`; when writing the config, set `plugin_version` to the current plugin version, not the placeholder. The point: when you write acceptance criteria in step 4, the test and check commands must match THIS project (whatever language and toolchain it uses), not a hardcoded assumption.

Also read `plan.html_preview` from the config (under the `plan:` key, default `false` if absent). Store it as `html_preview_enabled` for use in step 8a.

### 2. Check for approved architecture

Before grounding in the codebase, check whether an approved architecture exists for this slug.

- If a slug is already known (passed in from `ail-architect` or a prior session), look for `.ai-lore/plans/<slug>/architecture/overview.md`.
- If no slug is known yet, skip this check and derive the slug in step 8 as normal.

If `overview.md` exists and its frontmatter has `status: approved`:
- Read `overview.md`. Parse the `## Files` section (bullet list of `- [<filename>](<filename>) -- <description>` entries) to discover which other architecture files exist.
- Read each listed file.
- If the `## Decisions` section of `overview.md` links decision files (entries of the form `- [<adr-id>](../decisions/<adr-id>.md) -- <choice>`), read those files too; they carry the rationale behind the design and any recall trail.
- Note the owned paths in the `## Components` section (each bullet names the repo paths its component owns); use them in step 5 to seed each task's `touches`.
- Note the `## Risks and open questions` section; anything still listed there is unresolved by design and should be surfaced as a decomposition question in step 4, not silently planned over.
- Set `architecture_loaded: true`. In step 3, skip all design-level questions (component structure, data model, API shape, technology choices) -- these are settled. Focus brainstorming entirely on decomposition: wave boundaries, task sizing, parallelism, and dependency ordering.

If `overview.md` does not exist or `status` is not `approved`, set `architecture_loaded: false` and proceed as normal.

### 3. Ground the plan in the codebase

Before proposing anything, understand the blast radius. Run these in parallel:

- If a project knowledge graph exists (e.g. `.understand-anything/knowledge-graph.json`), consult it to find which architectural layers and files the work touches and what the blast radius is. The project CLAUDE.md may point to one.
- Dispatch an `Explore` agent (read-only) to find the files involved, comparable existing patterns to mirror, integration points, and feasibility concerns.
- If `.ai-lore-docs/state.yaml` exists, read `.ai-lore-docs/overview.md` for the system architecture and then read any module docs under `.ai-lore-docs/modules/` whose directory names overlap with the planned work. Use the overview to understand system layers and coupling; use module docs to seed accurate `touches` lists, spot dependency edges that should dictate wave ordering, and surface patterns the plan must respect. If `.ai-lore-docs/` does not exist, skip this.
- If `brainstorm_dir` was passed (from `ail-brainstorm` handoff), read these files from it: `overview.md`, `personas.md`, `flows.md`, `edge-cases.md`, `constraints.md`, `open-questions.md`. Use them as the primary source of goal, personas, flows, constraints, and open questions. Skip asking questions in step 4 that the brainstorm has already answered; focus on decomposition decisions instead.

Read the project CLAUDE.md for conventions, invariants, and any FIXED contract surfaces the plan must respect.

### 4. Brainstorm and ask questions (required)

Frame the problem, then surface every decision that branches the plan.

If `architecture_loaded` is true: skip all design-level questions (component structure, data model, API shape, technology choices -- these are settled in the architecture files). Focus entirely on decomposition decisions: wave boundaries, task sizing, parallelism, dependency ordering, and whether any tasks require worktree isolation.

If `architecture_loaded` is false: surface all decisions as normal -- scope boundaries, sequencing, what is in vs out, risky assumptions, where the work could be cut into independent pieces.

For every question where one option is stronger, **state your recommendation first and say why it wins over the alternatives** (use the "(Recommended)" label and lead with the rationale). Use `AskUserQuestion` for crisp either/or decisions; use prose for open exploration. Loop until the shape is agreed. If a decision is genuinely the user's to make and you cannot infer it, ask; if there is an obvious default, recommend it and move on.

### 5. Decompose into atomic tasks

Break the agreed scope into the smallest tasks that are each:

- **Atomic**: one sub-agent can complete it end to end in one sitting.
- **Self-contained**: its task file gives a fresh agent everything it needs, with no memory of this conversation.
- **Verifiable**: it has AC that can be checked objectively (a test that passes, a symbol that exists, an observable behavior). Avoid AC like "works well"; prefer a concrete command built from the project's `test_command` (config), e.g. "`<test_command> <file>` passes".

For each task, record the exact set of files it will create or edit as `touches`, and any `depends_on` (task ids from earlier waves).

**Writing style:** Context and AC are dense, not discursive. Use bullet points, not prose paragraphs. State facts; omit "this task will..." framing. The context section should read like an experienced colleague's sticky note, not a requirements doc.

For tasks that create or modify a visible UI surface: include a wireframe in the task's `## Wireframe` section. If a brainstorm was passed (`brainstorm_dir`), copy or reference the relevant wireframe from `.ai-lore/brainstorm/<slug>/flows.md`. If no brainstorm exists, sketch one in ASCII art directly in the task file (same notation: `[Button]`, `[__field__]`, `[v Dropdown]`, box-drawing chars or dashes). Keep it under 20 lines; the goal is to give the worker agent spatial orientation, not a design spec. Omit the `## Wireframe` section entirely for non-UI tasks.

### 6. Pack tasks into waves (dependency + file analysis)

- A task goes in the **earliest wave** after all its `depends_on` tasks' waves.
- Within a wave, tasks **must have disjoint `touches`** so they can run in parallel without clobbering each other. If two otherwise-independent tasks share files, either push one to a later wave, or, only when overlap is genuinely unavoidable, mark the conflicting task `isolation: worktree` so ail-build-waves runs it in its own git worktree and merges after. (This is the within-plan use of worktrees; ail-build-waves separately isolates whole plans when several build at once.)
- Prefer disjoint-file waves; reach for `worktree` only when serializing would needlessly stall parallelism.
- Keep waves small enough to review at the checkpoint ail-build-waves pauses on.

### 7. Confirm the wave plan with the user

Present the waves, their tasks, the parallelism, and any worktree-isolated tasks. Show the dependency reasoning. Get explicit sign-off before writing files. Adjust on feedback.

Once sign-off is obtained, run the capture routine below for any material decisions surfaced during brainstorming or decomposition (non-default option picks, overridden recommendations, consequential decomposition calls), before writing the plan in step 8.

### Capture decisions (canonical routine)

> Keep this section in sync with the identical copy in `skills/architect/SKILL.md`. Any edit here must be mirrored there verbatim.

This routine captures material decisions as MADR nodes. It is deliberately not a Node script (it drives interactive `AskUserQuestion`) and not a sub-agent (it must drive the main conversation).

1. **Materiality filter.** Capture a choice only if all three hold: (a) real alternatives existed, (b) it constrains or rules out future work, (c) it is non-obvious enough that a future reader asks "why did we do it this way?"
   - Worked positive: "use SSE, not websockets, for notifications" (real alternative, constrains the transport, non-obvious). Captured.
   - Worked negative: "name the file `notifications.ts`" (no meaningful alternative, no lasting consequence, obvious). Not captured.
2. **Draft.** Compose a MADR (`# <title>`, `## Context`, `## Decision`, `## Consequences`) from already-articulated material (the question, the chosen option, the stated recommendation rationale), not inferred from scratch. Frontmatter keys (source only; never write `status` or `superseded_by`, those are linker-derived):
   - `id`: `adr-<topic-slug>`, where `<topic-slug>` is the `title` lowercased with each run of non-alphanumeric characters collapsed to a single hyphen, trimmed of leading and trailing hyphens, and capped short (roughly the first six words / 50 characters). This makes the filename self-describing rather than encoding the plan name. On collision (checked in the guard below) append the smallest `-N` starting at 2 that yields an unused name.
   - `title`: short imperative title.
   - `date`: `YYYY-MM-DD`.
   - `stage`: `architect` or `plan-waves` (whichever skill is running this routine).
   - `affects_paths`: repo-relative paths this decision governs (architect: from the components the decision concerns; plan-waves: from the relevant tasks' `touches`).
   - `supersedes`: list of prior decision ids this one replaces; empty by default, populated only on a recall-surfaced reversal.
   Write every list-valued key (`affects_paths`, `supersedes`) in flow style on one line (`[a, b, c]`, or `[]` when empty), never block style (a bare `key:` followed by indented `- item` lines). `build-links.js` and `--recall` read frontmatter as a constrained YAML subset, and flow-style is the canonical form module and concept docs already use.
3. **Filename-uniqueness guard.** Before writing any file, derive `adr-<topic-slug>` from the title and ensure `<id>.md` is unused across both (a) the plan's own `.ai-lore/plans/<slug>/decisions/` directory and (b) committed `.ai-lore-docs/decisions/` (a read). On collision, append the smallest `-N` (starting at 2) that makes it unused, and use that as the final `id` and filename. Decision filenames are thus globally unique without embedding the plan slug.
4. **Recall.** Before locking a choice similar to a prior one, call `node <plugin_root>/scripts/build-links.js --recall .ai-lore-docs <path> [<path> ...]` (`<plugin_root>` is this SKILL.md file's absolute path with the trailing `/skills/<this skill's directory>/SKILL.md` removed; paths passed as argv, never interpolated into a shell string; pass query paths repo-relative, since the linker resolves them against the docs tree) and surface any candidates: "`<id>` chose X because Y; reuse or change?" On a reversal, record the prior id in the new decision's `supersedes` and append one line to `.ai-lore/plans/<slug>/decisions/.recall.log` (JSONL: `{"ts","inputs","candidates","shown"}`).
5. **Confirm, edit, or skip** per decision; default on no response is skip (never committed without explicit confirmation). On `edit`, validate the edited content (three MADR headings present, frontmatter parseable) before writing.
6. **Write** one file per confirmed decision to `.ai-lore/plans/<slug>/decisions/<adr-id>.md`.

This routine writes only source keys and the MADR body; `build-links.js` owns the managed keys (`superseded_by`, `status`).

### 8. Write the plan

Create `.ai-lore/plans/<slug>/` (if it exists with content, ask: append, replace, or abort; never silently overwrite). Write `plan.md` from `templates/plan.md` and one `tasks/<id>-<topic>.md` per task from `templates/task.md`. Set every status to `pending`. Cross-link: plan.md's index links each task file; each task lists its `touches` and `depends_on`.

### 8a. Generate HTML preview (if enabled)

If `html_preview_enabled` is true:

1. Check that Node.js is available: run `node --version`. If it fails, print a warning -- "plan.html_preview is enabled but Node.js is not available; skipping HTML preview" -- and skip the rest of this step.
2. Derive `plugin_root` from this file's absolute path by removing the trailing `/skills/plan-waves/SKILL.md` (do NOT keep `skills/plan-waves/` in the result).
3. Run: `node <plugin_root>/scripts/render-plan.js .ai-lore/plans/<slug>/`
4. If the script exits with a non-zero code, report the error output but do not abort; the plan files are already written.
5. If it succeeds, report the HTML output path (the script prints it on stdout).
6. Print this warning to the user:

   > **Read-only preview:** `.ai-lore/plans/<slug>/plan.html` is auto-generated from the plan source files. Do not edit it directly -- any edits will be silently overwritten the next time the plan is updated. To make changes, edit `plan.md` and the task files under `.ai-lore/plans/<slug>/tasks/`.

### 9. Hand off

Report the plan path, the wave/task counts, and which tasks (if any) are worktree-isolated. Suggest running `ail-build-waves` (and note it reads best from an Opus session). If an HTML preview was generated, include the preview path in the report.

## Principles

- **Always brainstorm; never plan from the prompt alone.** Questions first, plan second.
- **Recommend with reasons.** When you ask and one option wins, say which and why.
- **Atomic and parallel.** Each task is one agent's job; same-wave tasks never share files (unless worktree-isolated).
- **AC must be objectively checkable.** If you cannot state how it would be verified, it is not an acceptance criterion yet.
- **Codebase-agnostic.** Verification commands come from `.ai-lore/config.yaml` (or detection), never a hardcoded toolchain.
- **Status lives in frontmatter, prose lives in the body.** So ail-build-waves can update state without garbling content.
