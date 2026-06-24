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
| `plan <goal text>` | `ai-lore-plan-waves` with `<goal text>` as the starting prompt |
| `build` or `build <slug>` | `ai-lore-build-waves`, passing the slug if given |
| `review` or `review <slug>` | `ai-lore-review`, passing the slug if given |
| `cleanup` or `cleanup <slug>` | `ai-lore-cleanup`, passing the slug if given |
| `config` | `ai-lore-config` only (skip state check and menu) |
| `document` or `document <paths>` | `ai-lore-document`, passing any paths and flags (e.g. `--include-tests`) |
| (no argument) | Run full flow below |

---

## 1. Config check (blocking)

Run `ai-lore-config` before anything else. This validates `.ai-lore/config.yaml`, applies any version migrations, and (if the config is missing) walks through creating one.

If `ai-lore-config` reports that required fields are still missing after its run (e.g. the user declined to fill in gate commands), do not proceed to the menu. Report the missing fields and stop here so the user can fix them. A broken config means builds will fail, so there is no point routing to build-waves.

If the config check passes (or the config was just created and all required fields are present), continue to step 2.

---

## 2. Read project state (Workflow)

Author and execute the following Workflow script to read the current state of plans and builds. This produces structured data with no ambiguity -- the menu in step 3 is driven entirely by what it returns.

```js
export const meta = {
  name: 'ai-lore-state-check',
  description: 'Read .ai-lore state: pending plans, active builds, cleanup-eligible and blocked runs',
  phases: [{ title: 'Read state' }],
}

const STATE_SCHEMA = {
  type: 'object',
  required: ['pending_plans', 'active_builds', 'cleanup_eligible', 'blocked_builds'],
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
          slug:        { type: 'string' },
          branch:      { type: 'string' },
          base_branch: { type: 'string' },
          pr_url:      { type: 'string' },
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
  },
}

const state = await agent(
  'Read the .ai-lore directory in the current project and classify its state.\n\n' +
  '1. Read .ai-lore/runs.yaml if it exists. Parse its "runs" list.\n' +
  '2. Scan .ai-lore/plans/*/plan.md. For each, read the YAML frontmatter (title, status, wave count, task count).\n' +
  '3. Classify:\n' +
  '   - pending_plans: plan.md files whose frontmatter status is "pending" AND either have no entry in runs.yaml or their runs.yaml entry has status "pending". These have been planned but never built.\n' +
  '   - active_builds: runs.yaml entries with status "in_progress".\n' +
  '   - cleanup_eligible: runs.yaml entries with status "complete" and no pr_url (or pr_url is null/empty).\n' +
  '   - blocked_builds: runs.yaml entries with status "blocked".\n' +
  '4. If .ai-lore/plans/ does not exist or is empty, return empty arrays for all fields.\n' +
  'Return only the structured result.',
  { label: 'read-state', phase: 'Read state', schema: STATE_SCHEMA }
)
return state
```

Pass `args` as `{}`. Capture the structured result as `state`.

---

## 3. Present the menu

Using the `state` from step 2, build a context-aware menu. Use `AskUserQuestion` so the user gets a clear single choice.

**Compose the option list dynamically:**

Always include:
- "Plan something new" -- runs `ai-lore-plan-waves`
- "Document codebase" -- runs `ai-lore-document` (always available regardless of plan state)

Include when `state.pending_plans` is non-empty:
- "Build a pending plan" -- list the slugs and let the user pick (show title, wave/task counts)

Include when `state.active_builds` is non-empty:
- "Resume an active build" -- show slug, branch, wave progress (e.g. "wave 2/4, 5/9 tasks done")

Include when `state.cleanup_eligible` is non-empty:
- "Review a completed build" -- show slug, branch, and whether already reviewed (check registry `review_status` field)
- "Ship a completed build (open PR or merge)" -- show slug and branch

Include when `state.blocked_builds` is non-empty (surface as a warning, not a primary option):
- "Investigate a blocked build" -- show which builds are blocked and at which wave

If ALL arrays are empty (fresh project, no plans yet): skip the menu entirely and go straight to `ai-lore-plan-waves`, letting the user know there are no active plans.

**Multi-item sub-selection:** If the user chooses an option that maps to more than one item (e.g. two pending plans), follow up with a second `AskUserQuestion` listing the specific items. Never present a giant flat list in the first question -- two-step is cleaner.

---

## 4. Route

Based on the user's choice, invoke the appropriate skill:

- **Plan something new**: invoke `ai-lore-plan-waves` with no pre-seeded goal (let it brainstorm fresh).
- **Build a pending plan**: invoke `ai-lore-build-waves`, passing the selected slug.
- **Resume an active build**: invoke `ai-lore-build-waves`, passing the selected slug (it will resume from frontmatter).
- **Review a completed build**: invoke `ai-lore-review`, passing the selected slug.
- **Ship a completed build**: invoke `ai-lore-cleanup`, passing the selected slug.
- **Investigate a blocked build**: invoke `ai-lore-build-waves` with the blocked slug (it will surface the blockers and offer retry/amend/stop).
- **Document codebase**: invoke `ai-lore-document` with no arguments (user can specify paths afterward if they want to scope).

---

## Principles

- **Config first, always.** No other work happens until the config is valid.
- **State is read deterministically.** The Workflow script returns structured data; the menu is driven by that data, not by freeform file reads in this session.
- **Argument passthrough skips the menu.** When the intent is clear from the invocation, route immediately; do not make the user navigate a menu they did not need.
- **Two-step multi-item selection.** Category choice first, then specific item -- never a flat combined list.
- **No em dashes** in anything written by this skill (commas, semicolons, parentheses, periods instead).
