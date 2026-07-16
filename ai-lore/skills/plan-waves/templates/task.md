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

<!-- Line cap: 10 lines. Bullets preferred over prose. State what changes and why, one pattern file to mirror, and the key constraint from CLAUDE.md. Nothing else. -->
{{key change, why, pattern file, constraint}}

## Wireframe (UI tasks only)

<!-- Include only when this task creates or modifies a visible UI surface.
     Paste the wireframe from the brainstorm flows.md wireframes section (note the file path),
     OR sketch one directly in ASCII using the same notation:
       [Button] | [__field__] | [v Dropdown] | (x) toggle | ☐ checkbox | box-drawing or dashes
     Max ~20 lines. Goal: spatial orientation for the worker agent, not a design spec.
     Omit this section entirely for non-UI tasks. -->

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
