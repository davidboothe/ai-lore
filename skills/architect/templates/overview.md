---
status: draft
slug: {{slug}}
goal: {{goal}}
---

# Architecture: {{short title}}

<!-- Soft budget: 100 lines. Exceed only when the content genuinely requires it, never with filler. -->
<!-- One home per fact: this file owns the goals, decisions, components, runtime view, constraints, and risks. Entities live in data-model.md; contracts live in api.md; migration lives in rollout.md. Point, do not restate. -->

## Summary

{{2-3 sentences describing the approach at a high level. No marketing prose.}}

## Goals and non-goals

<!-- Delta rule: if a brainstorm exists, this section holds only the technical goals and non-goals of THIS design; product scope lives in the brainstorm's overview.md (point to it in one line). Without a brainstorm, write both fresh. Non-goals are things this design deliberately does not attempt (e.g. "not multi-tenant-safe yet"); they are distinct from product out-of-scope. -->

**Goals**

- {{technical outcome this design must deliver}}

**Non-goals**

- {{thing this design deliberately does not attempt; keep non-empty}}

## Decisions

<!-- One subsection per fork resolved during the step 4 interview. This section is the decision's only home while the design is in motion. After approval, step 10 promotes confirmed decisions to MADR files under ../decisions/ and rewrites this section into a link index; never hand-write that index, and never restate a promoted decision's body here. If no fork cleared the materiality bar, write a single line: "No material forks; defaults are visible in Components and the contract files." -->

### D1: {{short imperative title}}

- **Context:** {{one or two lines: what forced the choice}}
- **Options:** {{the live options, one line each, including the rejected ones}}
- **Choice:** {{what was chosen}}
- **Rationale:** {{why, in the words used when the fork was resolved}}

## Components

<!-- One bullet per component. Name the repo paths each component owns ("new: <path>" for paths that do not exist yet). plan-waves seeds task `touches` from these paths, and decision promotion derives affects_paths from them. -->

- **{{component}}** -- {{one-line responsibility}}. Paths: {{repo-relative paths, or "new: <path>"}}

## Runtime view

<!-- Conditional: include only when the core flow has 3+ actor/system exchanges; below that, use a numbered list or omit the section entirely. mermaid sequenceDiagram, max 6 participants and 10 messages; split by subflow with a one-line caption per diagram if larger. Cover the happy path; add the worst failure path only when its shape differs materially from the happy path. -->

## Key constraints

<!-- Delta rule: with a brainstorm, list only the technical constraints this design adds; the brainstorm's constraints.md owns user-facing rules (point to it). Non-negotiables only: performance targets, regulatory requirements, integration contracts, things that cannot change. -->

- {{constraint}}

## Risks and open questions

<!-- Holds only what is UNRESOLVED at the time of writing. Accepted critique findings are folded into the section they concern, never parked here. Each entry: one line plus the consequence if it lands badly. -->

- {{risk or open question, with its consequence}}

## Files

<!-- The machine-parseable index. List exactly the files that exist, no more, no less. Each line must follow the exact format below; plan-waves parses this section. -->

- [overview.md](overview.md) -- this file; design summary, decisions, components, and architecture index
- [data-model.md](data-model.md) -- {{one-line description; include this line only if the file is generated}}
- [api.md](api.md) -- {{one-line description; include this line only if the file is generated}}
- [rollout.md](rollout.md) -- {{one-line description; include this line only if the file is generated}}
