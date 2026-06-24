---
id: {{wave-n}}              # e.g. 1-2
wave: {{wave id}}           # e.g. 1
title: {{atomic task title}}
status: pending             # pending | in_progress | blocked | complete
isolation: shared           # shared | worktree  (worktree only when files overlap another same-wave task)
touches:                    # every file this task may create or edit; same-wave tasks must not overlap unless worktree
  - {{path/to/file}}
depends_on: []              # task ids from EARLIER waves whose output this task needs
---

# {{Task title}}

## Context

{{Just enough for a fresh sub-agent to act with no other memory of the plan. What this task changes and why, the one or two files to mirror as a pattern, the relevant convention from CLAUDE.md. Link a comparable existing implementation if one exists.}}

## Todos

- [ ] {{concrete step}}
- [ ] {{concrete step}}
- [ ] {{concrete step}}

## Acceptance criteria

Objectively checkable. The worker self-reports pass/fail with evidence; the orchestrator runs the project gate before marking this task complete.

- [ ] {{e.g. the project's test_command for this file passes}}
- [ ] {{e.g. function X exported from file Y with signature Z}}
- [ ] {{behavioral assertion that proves the task is done}}

## Return contract

When finished, return ONLY: outcome (complete|blocked), AC pass/fail list, files changed, a summary under 80 words, and any blocker. No narration, no diffs.
