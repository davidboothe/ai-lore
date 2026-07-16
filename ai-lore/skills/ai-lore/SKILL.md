---
name: ai-lore
description: Master entry point for the ai-lore plugin. Validates config, reads the current state of plans and builds via a deterministic Workflow script, and routes to the right skill based on what is waiting. Accepts an optional argument to skip the menu and go straight to planning (e.g. "/ai-lore plan a login page"), building ("build"), or cleanup ("cleanup"). Always the right first command when starting a new session in a project that uses ai-lore. e.g. "/ai-lore", "/ai-lore plan a new feature", "/ai-lore build", "/ai-lore cleanup".
---

# ai-lore

The master entry point for the ai-lore plugin. It validates the project config, reads current state deterministically, and routes you to the right skill -- all in one invocation.

---

## 0. Argument passthrough (check first, before anything else)

If the user invoked `/ai-lore` with a clear directional argument, resolve the intent and skip the menu entirely (still run config check first):

| Pattern | Route to |
|---|---|
| `architect` or `architect <goal>` | `ail-architect` with `<goal>` as the starting goal (or no-arg for the goal prompt) |
| `plan <goal text>` | `ail-plan-waves` with `<goal text>` as the starting prompt |
| `brainstorm` or `brainstorm <topic>` | `ail-brainstorm` with `<topic>` as the starting topic (or no-arg for resume/new menu) |
| `persona` or `persona <args>` | `ail-persona`, passing any arguments (e.g. `create a compliance officer`, `list`) |
| `build` or `build <slug>` | `ail-build-waves`, passing the slug if given |
| `review` or `review <slug>` | `ail-review`, passing the slug if given |
| `cleanup` or `cleanup <slug>` | `ail-cleanup`, passing the slug if given |
| `config` | `ail-config` only (skip state check and menu) |
| `document` or `document <paths>` | `ail-document`, passing any paths and flags (e.g. `--include-tests`) |
| (no argument) | Run full flow below |

---

## 1. Config check (blocking)

Run `ail-config` before anything else. This validates `.ai-lore/config.yaml`, applies any version migrations, and (if the config is missing) walks through creating one.

If `ail-config` reports that required fields are still missing after its run (e.g. the user declined to fill in gate commands), do not proceed to the menu. Report the missing fields and stop here so the user can fix them. A broken config means builds will fail, so there is no point routing to build-waves.

If the config check passes (or the config was just created and all required fields are present), continue to step 2.

---

## 2. Read project state (Workflow)

Execute the bundled workflow script to read the current state of plans and builds. This produces structured data with no ambiguity -- the menu in step 3 is driven entirely by what it returns.

Call `Workflow` with the inline script below and an empty args object. Pass the `script` parameter exactly as written -- do not modify it.

```js
export const meta = {
  name: 'ai-lore-state-check',
  description: 'Read .ai-lore state: pending plans, active builds, cleanup-eligible and blocked runs',
  phases: [{ title: 'Read state' }],
}

const STATE_SCHEMA = {
  type: 'object',
  required: ['pending_plans', 'active_builds', 'cleanup_eligible', 'submitted_builds', 'blocked_builds', 'in_progress_brainstorms', 'ready_brainstorms', 'draft_architects', 'approved_architects'],
  properties: {
    pending_plans: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'title', 'wave_count', 'task_count'],
        properties: {
          slug:       { type: 'string' },
          title:      { type: 'string' },
          wave_count: { type: 'number' },
          task_count: { type: 'number' },
        },
      },
    },
    active_builds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'branch', 'wave', 'of', 'tasks_done', 'tasks_total'],
        properties: {
          slug:        { type: 'string' },
          branch:      { type: 'string' },
          wave:        { type: 'number' },
          of:          { type: 'number' },
          tasks_done:  { type: 'number' },
          tasks_total: { type: 'number' },
        },
      },
    },
    cleanup_eligible: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'branch', 'base_branch'],
        properties: {
          slug:          { type: 'string' },
          branch:        { type: 'string' },
          base_branch:   { type: 'string' },
          pr_url:        { type: 'string' },
          review_status: { type: 'string' },
        },
      },
    },
    submitted_builds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'branch', 'pr_url'],
        properties: {
          slug:    { type: 'string' },
          branch:  { type: 'string' },
          pr_url:  { type: 'string' },
        },
      },
    },
    blocked_builds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'wave', 'of'],
        properties: {
          slug: { type: 'string' },
          wave: { type: 'number' },
          of:   { type: 'number' },
        },
      },
    },
    in_progress_brainstorms: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'title', 'status'],
        properties: {
          slug:   { type: 'string' },
          title:  { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
    ready_brainstorms: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'title'],
        properties: {
          slug:  { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
    draft_architects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'title'],
        properties: {
          slug:  { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
    approved_architects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'title'],
        properties: {
          slug:  { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
  },
}

const state = await agent(
  'Read the .ai-lore directory in the current project and classify its state.\n\n' +
  '1. Read .ai-lore/runs.yaml if it exists. Parse its "runs" list.\n' +
  '2. Scan .ai-lore/plans/*/plan.md (skip any path whose components include "complete"). For each, read the YAML frontmatter (title, status, wave count, task count).\n' +
  '3. Classify build state:\n' +
  '   - pending_plans: plan.md files whose frontmatter status is "pending" AND either have no entry in runs.yaml or their runs.yaml entry has status "pending". These have been planned but never built.\n' +
  '   - active_builds: runs.yaml entries with status "in_progress".\n' +
  '   - cleanup_eligible: runs.yaml entries with status "complete" and no pr_url (or pr_url is null/empty). For each, also include the review_status field from the runs.yaml entry if present (it may be "complete" or absent).\n' +
  '   - submitted_builds: runs.yaml entries with status "submitted" (a PR has been opened and is awaiting merge). For each, include slug, branch, and pr_url.\n' +
  '   - blocked_builds: runs.yaml entries with status "blocked".\n' +
  '4. If .ai-lore/plans/ does not exist or is empty, use empty arrays for the build-state fields above.\n' +
  '5. Scan .ai-lore/brainstorm/*/brainstorm.yaml (skip any path whose components include "complete"). For each, read slug, title, and status from the YAML:\n' +
  '   - If status is one of (interviewing, files-written, review-done, triaged): add to in_progress_brainstorms.\n' +
  '   - If status is "complete" AND .ai-lore/plans/<slug>/plan.md does NOT exist: add to ready_brainstorms.\n' +
  '   - If status is "complete" AND a matching plan already exists: skip (already handed off).\n' +
  '   If .ai-lore/brainstorm/ does not exist, return empty arrays for in_progress_brainstorms and ready_brainstorms.\n' +
  '6. Scan .ai-lore/plans/*/architecture/overview.md (skip paths containing "complete"). For each, read the YAML frontmatter (status, title). Derive slug from the parent directory name:\n' +
  '   - If status is "draft": add to draft_architects.\n' +
  '   - If status is "approved" AND .ai-lore/plans/<slug>/plan.md does NOT exist: add to approved_architects.\n' +
  '   - If status is "approved" AND a plan.md exists for the same slug: skip (already handed off to plan-waves).\n' +
  'Return only the structured result.',
  { label: 'read-state', phase: 'Read state', schema: STATE_SCHEMA }
)
return state
```

Call: `Workflow({ script: <the js block above verbatim>, args: {} })`. Capture the structured result as `state`.

---

## 3. Present the menu

Using the `state` from step 2, build a context-aware menu. Use `AskUserQuestion` so the user gets a clear single choice.

**Compose the option list dynamically:**

Always include:
- "Brainstorm a feature" -- runs `ail-brainstorm` (always available; will offer resume if existing brainstorms exist)
- "Design architecture" -- runs `ail-architect` (always available; optional step between brainstorm and plan-waves)
- "Plan something new" -- runs `ail-plan-waves`
- "Document codebase" -- runs `ail-document` (always available regardless of plan state)

Include when `state.in_progress_brainstorms` is non-empty:
- "Resume an in-progress brainstorm" -- show slug, title, and current status for each (e.g. "interviewing", "triaged")

Include when `state.ready_brainstorms` is non-empty:
- "Hand off a completed brainstorm" -- show slug and title; after the user selects one, ask whether to proceed to architect (design first) or directly to plan-waves

Include when `state.draft_architects` is non-empty:
- "Resume an architect design draft" -- show slug and title for each

Include when `state.approved_architects` is non-empty:
- "Continue an approved design to planning" -- show slug and title for each

Include when `state.pending_plans` is non-empty:
- "Build a pending plan" -- list the slugs and let the user pick (show title, wave/task counts)

Include when `state.active_builds` is non-empty:
- "Resume an active build" -- show slug, branch, wave progress (e.g. "wave 2/4, 5/9 tasks done")

Include when `state.cleanup_eligible` is non-empty:
- "Review a completed build" -- show slug, branch, and whether already reviewed (check registry `review_status` field)
- "Ship a completed build (open PR or merge)" -- show slug and branch

Include when `state.submitted_builds` is non-empty:
- "Check on a submitted PR / tear down after merge" -- show slug, branch, and `pr_url`; let the user pick which submitted build to check

Include when `state.blocked_builds` is non-empty (surface as a warning, not a primary option):
- "Investigate a blocked build" -- show which builds are blocked and at which wave

Include when any archivable items exist (items in `in_progress_brainstorms`, `ready_brainstorms`, `draft_architects`, `approved_architects`, or `pending_plans` that are not in `active_builds` or `submitted_builds`):
- "Archive an abandoned item" -- allows moving items that will never proceed to the `.ai-lore/complete/` folder

If ALL arrays are empty (fresh project, no plans yet): still present the menu with the four always-available options (brainstorm, design architecture, plan something new, document codebase), noting there are no existing plans or builds yet. Do not auto-route; let the user choose.

**Multi-item sub-selection:** If the user chooses an option that maps to more than one item (e.g. two pending plans), follow up with a second `AskUserQuestion` listing the specific items. Never present a giant flat list in the first question -- two-step is cleaner.

---

## 4. Route

Based on the user's choice, invoke the appropriate skill:

- **Brainstorm a feature**: invoke `ail-brainstorm` with no argument (it handles resume/new selection internally).
- **Design architecture**: invoke `ail-architect` with no argument (it prompts for goal and handles brainstorm context selection internally).
- **Plan something new**: invoke `ail-plan-waves` with no pre-seeded goal (let it brainstorm fresh).
- **Resume an in-progress brainstorm**: invoke `ail-brainstorm`, passing the selected slug (it detects in-progress state via `interview_phase` and resumes from where it left off).
- **Hand off a completed brainstorm to architect**: invoke `ail-architect`, passing the slug so it can load the brainstorm context automatically.
- **Hand off a completed brainstorm directly to plan-waves**: invoke `ail-plan-waves`, passing the slug so it can load the brainstorm context automatically.
- **Resume an architect design draft**: invoke `ail-architect`, passing the selected slug.
- **Continue an approved design to planning**: invoke `ail-plan-waves`, passing the selected slug so it detects the existing approved architecture.
- **Build a pending plan**: invoke `ail-build-waves`, passing the selected slug.
- **Resume an active build**: invoke `ail-build-waves`, passing the selected slug (it will resume from frontmatter).
- **Review a completed build**: invoke `ail-review`, passing the selected slug.
- **Ship a completed build**: invoke `ail-cleanup`, passing the selected slug.
- **Check on a submitted PR / tear down after merge**: invoke `ail-cleanup`, passing the selected slug (it checks whether the PR merged and, if so, tears down the local worktree and branch).
- **Investigate a blocked build**: invoke `ail-build-waves` with the blocked slug (it will surface the blockers and offer retry/amend/stop).
- **Document codebase**: invoke `ail-document` with no arguments (user can specify paths afterward if they want to scope).
- **Archive an abandoned item**: proceed to step 5.

---

## 5. Archive abandoned items

When the user chooses "Archive an abandoned item":

1. Build the archivable list from items that are NOT currently in `active_builds` or `submitted_builds`:
   - From `in_progress_brainstorms` and `ready_brainstorms` (brainstorms that never became a plan)
   - From `draft_architects` and `approved_architects` (architect sessions that never became a plan)
   - From `pending_plans` (plans that were never built)

2. Use `AskUserQuestion` to let the user pick one or more items to archive.

3. Confirm: "Move these items to `.ai-lore/complete/`? This does not delete anything — it just moves files out of the active workspace." Wait for explicit confirmation before proceeding.

4. For each selected item, run the following (replacing `<slug>` with the actual slug):
   - If `.ai-lore/plans/<slug>/` exists:
     ```
     mkdir -p .ai-lore/complete/plans
     mv .ai-lore/plans/<slug>/ .ai-lore/complete/plans/<slug>/
     ```
   - If `.ai-lore/brainstorm/<slug>/` exists:
     ```
     mkdir -p .ai-lore/complete/brainstorm
     mv .ai-lore/brainstorm/<slug>/ .ai-lore/complete/brainstorm/<slug>/
     ```

5. Report which items were moved. If a folder was already absent (already archived by a prior run), log a note but do not fail.

---

## Principles

- **Config first, always.** No other work happens until the config is valid.
- **State is read deterministically.** The Workflow script returns structured data; the menu is driven by that data, not by freeform file reads in this session.
- **Argument passthrough skips the menu.** When the intent is clear from the invocation, route immediately; do not make the user navigate a menu they did not need.
- **Two-step multi-item selection.** Category choice first, then specific item -- never a flat combined list.
- **Complete folder is never scanned.** Items under `.ai-lore/complete/` are archived and invisible to the state check. Archival is irreversible from the menu but safe — files are moved, not deleted.
