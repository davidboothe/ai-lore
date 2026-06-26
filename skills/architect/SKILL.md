---
name: ail-architect
description: Design the technical architecture for a goal before breaking it into atomic tasks. Grounds the HOW before plan-waves handles the breakdown. Accepts an optional goal argument; reads brainstorm output if present. Writes architecture files to .ai-lore/plans/<slug>/architecture/, runs an 8-agent parallel critique (3 adversarial modes + 5 reviewer perspectives), then requires user approval before finalizing. plan-waves detects the approved architecture and shifts its questions from design to decomposition. Invoke between brainstorm and plan-waves for non-trivial features. e.g. "/ail-architect", "/ail-architect a new payments integration".
---

# ail-architect

> **Recommended model:** Opus. Architecture decisions are the most expensive to reverse; the decomposition quality here directly determines how well plan-waves can pack atomic tasks.

Design the technical architecture for a goal. Establishes component boundaries, data models, API contracts, and key decisions before plan-waves decomposes the work into atomic tasks. Runs an adversarial critique team before writing any final files.

---

## 0. Argument check

If the user invoked `ail-architect` with a goal argument (e.g. `/ail-architect a payments integration`), capture it as `goal_arg` and skip the goal-prompt in step 2. Otherwise, `goal_arg` is empty.

---

## 1. Config check

Run `ail-config` first. If it reports missing required fields, stop and report them. Do not proceed until config is valid.

---

## 2. Determine the goal and slug

**Goal:**
- If `goal_arg` is set, use it as the goal.
- Otherwise, ask the user to describe what they want to build (one sentence is enough; you will ground it further in step 3).

**Brainstorm context:**
- Check whether `.ai-lore/brainstorm/` contains any directories. If one or more exist, list them and ask: "Do you want to use an existing brainstorm as context, or start from the goal description alone?" If the user picks a brainstorm, set `brainstorm_dir` to its absolute path. Otherwise, `brainstorm_dir` is unset.

**Slug:**
- Derive a kebab-case topic from the goal (3-5 words, no stop words). Prepend today's date as `YYYY-MM-DD`. Example: `2026-06-24-payments-integration`.
- If `brainstorm_dir` is set and its directory name already has the `YYYY-MM-DD-<topic>` shape, reuse that slug to keep the plan folder consistent.
- Confirm the slug with the user (one line: "Slug: `<slug>` -- OK?"). Adjust if they want a different name.

**Existing architecture check:**
- If `.ai-lore/plans/<slug>/architecture/overview.md` already exists:
  - Read its `status` frontmatter field.
  - If `status: approved`: ask "Architecture for `<slug>` is already approved. Overwrite it?" If no, stop.
  - If `status: draft`: ask "A draft architecture exists for `<slug>`. Resume from the draft (skip regeneration and go straight to critique) or regenerate from scratch?"
    - If resume: skip to step 5 (run critique against existing draft files).
    - If regenerate: continue from step 3.

---

## 3. Ground in context

Run the following in parallel before generating anything:

**Codebase exploration:**
Dispatch an `Explore` agent (read-only, medium breadth) with a prompt like: "Find existing architectural patterns in this codebase relevant to: `<goal>`. Look for: naming conventions, API shape (REST/RPC/envelope format), data model conventions (ORM, raw SQL, schema files), auth approach, error handling patterns, test structure. Return a concise summary of what you found -- patterns to follow and things to avoid."

**Brainstorm context (if `brainstorm_dir` is set):**
Read these files from `brainstorm_dir` if they exist: `overview.md`, `constraints.md`, `open-questions.md`. These give you the WHAT context; you will now design the HOW.

Synthesize both into a `context` block you will use in step 4.

---

## 4. Generate draft architecture

Using the goal and `context` from step 3, generate the architecture. Work through each section in order:

### Decide which files are needed

Always generate `overview.md`. Additionally:
- `data-model.md`: generate if the feature involves entities, schema, relationships, or persistent state.
- `api.md`: generate if the feature exposes or consumes interfaces, endpoints, events, or contracts.
- `decisions.md`: generate if there are non-obvious technology or design choices where alternatives exist and the choice has consequences.

If a file is not needed, do not generate it and do not list it in the `## Files` section of `overview.md`.

### Generate content for each file

**overview.md** -- always generated:

```markdown
---
status: draft
slug: <slug>
goal: <goal>
---

# Architecture: <short title>

## Summary
<2-3 sentences describing the approach at a high level>

## Components
<bulleted list of main components with one-line descriptions>

## Key Constraints
<non-negotiables: performance targets, regulatory requirements, integration contracts, things that cannot change>

## Files
- [overview.md](overview.md) -- this file; high-level summary and architecture index
- [data-model.md](data-model.md) -- <one-line description of what is in this file>
- [api.md](api.md) -- <one-line description>
- [decisions.md](decisions.md) -- <one-line description>
```

The `## Files` section is the machine-parseable index. Only list files that will be written. Each line must follow the exact format: `- [<filename>](<filename>) -- <description>`. No other formatting.

**data-model.md** (if needed):

```markdown
# Data Model

## Entities
<one subsection per entity: fields, types, constraints, indexes>

## Relationships
<how entities relate to each other>

## Schema Notes
<migration concerns, archival strategy, naming conventions, soft-delete approach if used>
```

**api.md** (if needed):

```markdown
# API Contracts

## Endpoints
<one subsection per endpoint or event: method, path/topic, auth requirement, request shape, response shape, error cases>

## Auth and Permissions
<who can call what; scope or role requirements>

## Error Format
<standard error envelope shape for this feature>
```

**decisions.md** (if needed) -- use MADR format, one record per non-obvious decision:

```markdown
# Architecture Decisions

## ADR-001: <short imperative title, e.g. "Use PostgreSQL for session storage">

**Status:** accepted
**Date:** <YYYY-MM-DD>

### Context
<Why this decision was needed. What forces were at play.>

### Decision
<What was decided, stated plainly.>

### Consequences
<What becomes easier. What becomes harder. What this rules out.>

---

## ADR-002: ...
```

---

## 5. Write draft files to disk

Create `.ai-lore/plans/<slug>/architecture/` if it does not exist.

Write every generated file. Do not show the full content inline to the user -- just confirm: "Draft architecture written to `.ai-lore/plans/<slug>/architecture/` (<N> files). Running critique..."

---

## 6. Run architecture critique (Workflow)

**Find the plugin root:** You know the absolute path to this SKILL.md file (e.g. `/home/user/.claude/plugins/cache/ai-lore/ai-lore/0.7.3/skills/architect/SKILL.md`). Remove exactly the suffix `/skills/architect/SKILL.md` from that path to get `<plugin_root>`. The result is the directory that directly contains the `workflows/` folder -- do NOT keep `skills/architect/` as part of the path.

**Important:** Pass `args` as an actual JSON object in the Workflow tool call, not a JSON-encoded string. Serialized args arrive as `undefined` in the script, causing agents to explore the repo at random.

Call:
```
Workflow({
  scriptPath: '<plugin_root>/workflows/architect-critique.js',
  args: {
    architecture_dir: '<absolute path to .ai-lore/plans/<slug>/architecture/>',
    project_root: '<absolute path to the project root>'
  }
})
```

Capture the result as `critique`. It contains two arrays: `critique.adversary` (3 results, keyed by `mode`) and `critique.panel` (5 results, keyed by `perspective`).

---

## 7. Synthesize findings

Aggregate across all 8 results:

- `all_findings`: flat list of all findings, preserving their source (`mode` or `perspective`) and `severity`.
- `blocking_count`: findings where `severity == "blocking"`.
- `advisory_count`: findings where `severity == "advisory"`.
- `open_questions`: combined unique list from all panel results.

Sort `all_findings`: blocking before advisory, then by source.

---

## 8. Present findings and ask for approval

Print an inline summary:

```
Architecture critique complete for <slug> (<blocking_count> blocking, <advisory_count> advisory).

Adversarial review:
  Contradictions:    <N blocking, N advisory> -- <one-line summary>
  False Assumptions: <N blocking, N advisory> -- <one-line summary>
  Failure Modes:     <N blocking, N advisory> -- <one-line summary>

Panel review:
  Scalability:  <N blocking, N advisory> -- <one-line summary>
  Security:     <N blocking, N advisory> -- <one-line summary>
  Simplicity:   <N blocking, N advisory> -- <one-line summary>
  Consistency:  <N blocking, N advisory> -- <one-line summary>
  Testability:  <N blocking, N advisory> -- <one-line summary>

<If blocking_count > 0:>
Blocking findings:
- [<source>] <file>: <description>
<...one line per blocking finding>

<If open_questions non-empty:>
Open questions:
- <question>
```

Then use `AskUserQuestion` to ask:

> "How would you like to proceed?"

Options:
- **Approve** -- accept the architecture as written and proceed to plan-waves
- **Revise** -- describe changes; ail-architect will update the files and re-run the critique
- **Abandon** -- leave the draft files in place; return to the ai-lore menu

**If Approve:** continue to step 9.

**If Revise:** ask the user what to change. Apply the changes directly to the relevant architecture files. Then loop back to step 6 (re-run critique against the updated files). Do not regenerate files that were not touched.

**If Abandon:** report the draft location and stop. The draft files remain on disk; the user can resume by re-invoking `ail-architect` and choosing "resume from draft" in step 2.

---

## 9. Finalize

Update the `status` field in `overview.md` frontmatter from `draft` to `approved`.

Report:

```
Architecture approved and written to .ai-lore/plans/<slug>/architecture/.

Files:
- overview.md
- <other files written>

Next: run ail-plan-waves to decompose this into atomic tasks. It will detect the approved architecture and skip design-level questions.
```

Then offer to invoke `ail-plan-waves` passing the slug.

---

## Principles

- **Draft first, critique second.** Files are written to disk before critique runs. If the session dies, the draft survives.
- **Overview.md is the index contract.** The `## Files` section must list exactly the files that exist -- no more, no less. plan-waves reads this to know what to load.
- **Critique is a single pass.** If the user wants another critique after revising, it re-runs from step 6. There is no implicit iteration.
- **ail-architect owns the slug when it runs first.** plan-waves reuses the same slug to fill in the rest of the plan folder.
- **Brainstorm is optional context, not a requirement.** ail-architect can start from a raw goal with no prior brainstorm.
- **No em dashes** in any file written by this skill (commas, semicolons, parentheses, periods instead).
- **Status frontmatter is written only by this skill.** Sub-agents return structured findings; this skill writes and updates all files.
