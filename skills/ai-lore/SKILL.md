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
| `plan <goal text>` | `ail-plan-waves` with `<goal text>` as the starting prompt |
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

**Find the plugin root:** This skill file is at `<plugin_root>/skills/ai-lore/SKILL.md`. Strip the trailing `/skills/ai-lore/SKILL.md` from this file's absolute path to get `<plugin_root>`.

Call `Workflow({ scriptPath: '<plugin_root>/workflows/state-check.js', args: {} })`. Capture the structured result as `state`.

---

## 3. Present the menu

Using the `state` from step 2, build a context-aware menu. Use `AskUserQuestion` so the user gets a clear single choice.

**Compose the option list dynamically:**

Always include:
- "Plan something new" -- runs `ail-plan-waves`
- "Document codebase" -- runs `ail-document` (always available regardless of plan state)

Include when `state.pending_plans` is non-empty:
- "Build a pending plan" -- list the slugs and let the user pick (show title, wave/task counts)

Include when `state.active_builds` is non-empty:
- "Resume an active build" -- show slug, branch, wave progress (e.g. "wave 2/4, 5/9 tasks done")

Include when `state.cleanup_eligible` is non-empty:
- "Review a completed build" -- show slug, branch, and whether already reviewed (check registry `review_status` field)
- "Ship a completed build (open PR or merge)" -- show slug and branch

Include when `state.blocked_builds` is non-empty (surface as a warning, not a primary option):
- "Investigate a blocked build" -- show which builds are blocked and at which wave

If ALL arrays are empty (fresh project, no plans yet): skip the menu entirely and go straight to `ail-plan-waves`, letting the user know there are no active plans.

**Multi-item sub-selection:** If the user chooses an option that maps to more than one item (e.g. two pending plans), follow up with a second `AskUserQuestion` listing the specific items. Never present a giant flat list in the first question -- two-step is cleaner.

---

## 4. Route

Based on the user's choice, invoke the appropriate skill:

- **Plan something new**: invoke `ail-plan-waves` with no pre-seeded goal (let it brainstorm fresh).
- **Build a pending plan**: invoke `ail-build-waves`, passing the selected slug.
- **Resume an active build**: invoke `ail-build-waves`, passing the selected slug (it will resume from frontmatter).
- **Review a completed build**: invoke `ail-review`, passing the selected slug.
- **Ship a completed build**: invoke `ail-cleanup`, passing the selected slug.
- **Investigate a blocked build**: invoke `ail-build-waves` with the blocked slug (it will surface the blockers and offer retry/amend/stop).
- **Document codebase**: invoke `ail-document` with no arguments (user can specify paths afterward if they want to scope).

---

## Principles

- **Config first, always.** No other work happens until the config is valid.
- **State is read deterministically.** The Workflow script returns structured data; the menu is driven by that data, not by freeform file reads in this session.
- **Argument passthrough skips the menu.** When the intent is clear from the invocation, route immediately; do not make the user navigate a menu they did not need.
- **Two-step multi-item selection.** Category choice first, then specific item -- never a flat combined list.
- **No em dashes** in anything written by this skill (commas, semicolons, parentheses, periods instead).
