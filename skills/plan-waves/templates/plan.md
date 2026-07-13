---
slug: {{YYYY-MM-DD-topic}}
title: {{Human readable plan title}}
status: pending            # pending | in_progress | blocked | complete
created: {{YYYY-MM-DD}}
goal: {{one sentence: what "done" means for the whole plan}}
waves:
  - id: 1
    name: {{wave name}}
    status: pending         # pending | in_progress | blocked | complete
    tasks: [1-1, 1-2]       # task ids in this wave (must have disjoint `touches` unless isolation: worktree)
  - id: 2
    name: {{wave name}}
    status: pending
    depends_on: [1]         # waves that must be complete before this one can start
    tasks: [2-1]
---

# {{Plan title}}

## Goal

{{What this plan delivers and why. The definition of done for the plan as a whole.}}

## Context

<!-- Line cap: 8 lines. Pointers only: key files, the architecture layer touched, relevant constraints from CLAUDE.md. No prose rationale; that lives in the goal. -->
{{file paths, architecture layer, key constraints}}

## Global acceptance criteria

Checked once at the end, after all waves complete.

- [ ] {{e.g. the project gate passes (the commands in .ai-lore/config.yaml)}}
- [ ] {{e.g. no new files import the forbidden module under src/core/}}
- [ ] {{plan-level behavioral AC}}

## Waves

### Wave 1: {{name}}

Runs in parallel. Each task below touches a disjoint set of files.

- **1-1** {{title}}: {{one-liner}} -> [tasks/1-1-...md](tasks/1-1-...md)
- **1-2** {{title}}: {{one-liner}} -> [tasks/1-2-...md](tasks/1-2-...md)

### Wave 2: {{name}}

Depends on wave 1.

- **2-1** {{title}}: {{one-liner}} -> [tasks/2-1-...md](tasks/2-1-...md)
