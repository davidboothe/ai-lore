---
name: ail-architect
description: Design the technical architecture for a goal before breaking it into atomic tasks. Grounds the HOW before plan-waves handles the breakdown. Accepts an optional goal argument; reads brainstorm output if present. Interviews the user at the material design forks first, generates a design doc from the resolved forks under .ai-lore/plans/<slug>/architecture/, runs an 8-agent parallel critique (3 adversarial modes + 5 reviewer perspectives), then requires user approval before promoting decisions to MADR files. plan-waves detects the approved architecture and shifts its questions from design to decomposition. Invoke between brainstorm and plan-waves for non-trivial features. e.g. "/ail-architect", "/ail-architect a new payments integration".
---

# ail-architect

> **Recommended model:** Opus. Architecture decisions are the most expensive to reverse; the decomposition quality here directly determines how well plan-waves can pack atomic tasks.

Design the technical architecture for a goal. Surfaces the material design forks as a short interview, generates a design doc from the resolved forks (goals, decisions, components, data model, API contracts, rollout), runs an adversarial critique team, and promotes the surviving decisions to MADR files on approval.

The document is the residue of decisions actually made with the user, never a post-hoc rationalization. Alternatives appear in the doc because they were genuinely on the table in step 4, not because a section heading demanded them.

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
- Derive a kebab-case topic from the goal (3-5 words, no stop words). This is the candidate topic; do not prepend a date yet.
- Before minting a new dated slug, scan `.ai-lore/plans/*/architecture/overview.md` for existing drafts whose topic portion (the plan directory name with its leading `YYYY-MM-DD-` prefix stripped) matches the candidate topic. If one is found with `status: draft`, this is the same situation as the **Existing architecture check** below: offer to resume it (reusing its slug, whatever date it was created on) instead of minting a new dated slug. If the user declines, or no match is found, prepend today's date to the candidate topic as `YYYY-MM-DD` to form the slug. Example: `2026-06-24-payments-integration`.
- If `brainstorm_dir` is set and its directory name already has the `YYYY-MM-DD-<topic>` shape, reuse that slug to keep the plan folder consistent (this takes precedence over the scan above).
- Confirm the slug with the user (one line: "Slug: `<slug>` -- OK?"). Adjust if they want a different name.

**Existing architecture check:**
- If `.ai-lore/plans/<slug>/architecture/overview.md` already exists:
  - Read its `status` frontmatter field.
  - If `status: approved`: ask "Architecture for `<slug>` is already approved. Overwrite it?" If no, stop.
  - If `status: draft`: ask "A draft architecture exists for `<slug>`. Resume from the draft (skip regeneration and go straight to critique) or regenerate from scratch?"
    - If resume: skip to step 7 (run critique against the existing draft files; their `## Decisions` section carries the forks already resolved, so the interview is not repeated).
    - If regenerate: continue from step 3.

---

## 3. Ground in context

Run the following in parallel before asking anything:

**Codebase exploration:**
Dispatch an `Explore` agent (read-only, medium breadth) with a prompt like: "Find existing architectural patterns in this codebase relevant to: `<goal>`. Look for: naming conventions, API shape (REST/RPC/envelope format), data model conventions (ORM, raw SQL, schema files), auth approach, error handling patterns, test structure. Return a concise summary of what you found -- patterns to follow and things to avoid."

**Brainstorm context (if `brainstorm_dir` is set):**
Read these files from `brainstorm_dir` if they exist: `brief.md` (the one-page synthesis; read it first), `overview.md`, `flows.md`, `edge-cases.md`, `constraints.md`, `open-questions.md`. These give you the WHAT context; you will now design the HOW. Treat any feasibility flags or deferred blocking questions surfaced in `brief.md` as design questions this architecture must answer. Hold the brainstorm's commitments (surfaces, flows, edge cases, constraints, confirmed assumptions) as a checklist, not just inspiration: step 8 checks the finished design against them (the fidelity check).

**Prior decisions:**
Note whether `.ai-lore-docs/decisions/` exists and is non-empty. If it does, step 4 runs recall queries against it before presenting forks, so prior decisions are on the table when the user chooses.

Synthesize everything into a `context` block you will use in steps 4 and 5.

---

## 4. Surface the fork points (interview)

The draft is generated *from* resolved decisions, not alongside them. Before writing anything, identify the material forks and put them to the user.

1. **Identify candidate forks.** From the goal and the `context` block, list the choices that will shape this design. Apply the materiality filter from the capture routine in step 10: a candidate is a fork only if (a) real alternatives exist, (b) the choice constrains or rules out future work, and (c) it is non-obvious enough that a future reader would ask "why did we do it this way?" Typical fork territory: transport or protocol, storage and schema shape, sync vs async, extend an existing component vs add a new one, build vs adopt a dependency, migration strategy.

2. **Cap at 2-4 forks.** Present only the most consequential. Everything below the bar is a default you choose yourself; those defaults remain visible in the draft (components, contracts) and the user can challenge them at the approval checkpoint. If nothing clears the bar (a genuinely small design), say so in one line and continue to step 5; the Decisions section then records "No material forks" per its template rule.

3. **Recall before asking.** If `.ai-lore-docs/decisions/` has entries (step 3), run the recall command (step 10, routine item 4) with the repo-relative paths the goal is likely to touch, and fold any hits into the relevant fork's option descriptions ("`<id>` chose X because Y"), so the user decides with the prior decision visible. A fork resolved against a recalled decision is a reversal; note it now so step 10 records `supersedes`.

4. **Ask.** Use `AskUserQuestion`, at most 2 forks per call. For each fork: put your recommended option first with "(Recommended)", lead the descriptions with the tradeoff rationale, and make every listed option a genuinely live one (never a strawman). If the user answers off-menu via "Other", capture their stated reasoning verbatim.

5. **Record each resolved fork** as a `### D<n>: <short imperative title>` subsection for the draft's `## Decisions` section: context, options (including the rejected ones), choice, rationale -- in the words used when the fork was resolved, not reconstructed later.

The forks resolved here are the raw material step 10 promotes to MADR files. Nothing downstream re-derives them.

---

## 5. Generate the draft design doc

Using the goal, the `context` block, and the resolved forks from step 4, generate the architecture files.

### Writing rules (apply to every file)

- **One home per fact.** Each entity, contract, rule, or rationale is explained in exactly one file; other files point to it in one line. Restating is the main source of bloat; do not do it.
- **Delta rule.** If `brainstorm_dir` is set, the Goals and non-goals and Key constraints sections carry only the *technical* additions of this design and point to the brainstorm files for product scope and user-facing rules. Without a brainstorm, write them fresh.
- **No marketing prose.** State the approach once, plainly.
- **Diagrams are conditional, not mandatory.** The runtime view exists only when the core flow clears its threshold (stated in the template comment); size caps are hard rules. Below threshold, a numbered list reads faster.
- **Soft budgets.** Each template states its budget in its HTML comments. Exceed a budget only when the content genuinely requires it, never with filler.

### Decide which files are needed

Always generate `overview.md`. Additionally:
- `data-model.md`: generate if the feature involves entities, schema, relationships, or persistent state.
- `api.md`: generate if the feature exposes or consumes interfaces, endpoints, events, or contracts.
- `rollout.md`: generate if the design touches existing data, existing contracts, or live behavior (migration, backwards compatibility, rollback).

If a file is not needed, do not generate it and do not list it in the `## Files` section of `overview.md`.

### Generate content for each file

Each file follows its skeleton in `templates/` (this skill's directory): `templates/overview.md`, `templates/data-model.md`, `templates/api.md`, `templates/rollout.md`. The templates carry the section order, the conditional rules, and the per-section budgets as HTML comments. Replace every `{{placeholder}}` with real content and drop every HTML comment; neither may appear in a written file.

Notes beyond what the templates carry:

- **`overview.md`** -- the `## Decisions` section is the D-subsections recorded in step 4, verbatim. The `## Components` bullets name the repo paths each component owns; plan-waves seeds task `touches` from them and step 10 derives `affects_paths` from them. The `## Files` section is the machine-parseable index: only list files that will be written, each line in the exact format `- [<filename>](<filename>) -- <description>`. No other formatting.
- **`data-model.md`** and **`api.md`** -- reference each other's content by name, never by restating it.
- **`rollout.md`** -- if generated, `data-model.md`'s Schema Notes point here for migration steps rather than carrying them.

---

## 6. Write draft files to disk

Create `.ai-lore/plans/<slug>/architecture/` if it does not exist.

Write every generated file. Do not show the full content inline to the user -- just confirm: "Draft architecture written to `.ai-lore/plans/<slug>/architecture/` (<N> files). Running critique..."

---

## 7. Run architecture critique (Workflow)

Call `Workflow` with the inline script below. Pass the `script` parameter exactly as written -- do not modify it. **Pass `args` as an actual JSON object, not a JSON-encoded string.**

```js
export const meta = {
  name: 'architect-critique',
  description: 'Fan out architect-adversary and architect-reviewer agents in parallel across all critique modes and reviewer perspectives',
  phases: [{ title: 'Architecture Critique' }],
}

const ADVERSARY_SCHEMA = {
  type: 'object',
  required: ['mode', 'findings', 'summary'],
  properties: {
    mode: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['files_involved', 'severity', 'description', 'implication', 'suggestion'],
        properties: {
          files_involved: { type: 'array', items: { type: 'string' } },
          severity:       { enum: ['blocking', 'advisory'] },
          description:    { type: 'string' },
          implication:    { type: 'string' },
          suggestion:     { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const PANEL_SCHEMA = {
  type: 'object',
  required: ['perspective', 'findings', 'open_questions', 'suggested_additions', 'summary'],
  properties: {
    perspective: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'severity', 'type', 'description', 'suggestion'],
        properties: {
          file:        { type: 'string' },
          severity:    { enum: ['blocking', 'advisory'] },
          type:        { type: 'string' },
          description: { type: 'string' },
          suggestion:  { type: 'string' },
        },
      },
    },
    open_questions:      { type: 'array', items: { type: 'string' } },
    suggested_additions: { type: 'array', items: { type: 'string' } },
    summary:             { type: 'string' },
  },
}

function _args(a) {
  // Workflow may deliver args as an object or as a (possibly double-encoded) JSON string.
  for (let i = 0; i < 2 && typeof a === 'string' && a.length; i++) {
    try { a = JSON.parse(a) } catch { break }
  }
  return (a && typeof a === 'object' && !Array.isArray(a)) ? a : {}
}
const { architecture_dir, project_root } = _args(args)
log(`architecture_dir: ${architecture_dir ?? '(undefined)'}, project_root: ${project_root ?? '(undefined)'}`)
if (!architecture_dir) {
  log(`FATAL: architect-critique received no architecture_dir; typeof args=${typeof args}`)
  throw new Error(`architect-critique: expected architecture_dir in args, got none (typeof args=${typeof args})`)
}
if (!project_root) {
  log(`FATAL: architect-critique received no project_root; typeof args=${typeof args}`)
  throw new Error(`architect-critique: expected project_root in args, got none (typeof args=${typeof args})`)
}

const MODES = [
  { id: 'coherence',       label: 'Coherence' },
  { id: 'devils_advocate', label: "Devil's Advocate" },
  { id: 'failure_modes',   label: 'Failure Modes' },
]

const PERSPECTIVES = [
  { id: 'security',     label: 'Security' },
  { id: 'simplicity',   label: 'Simplicity' },
  { id: 'consistency',  label: 'Consistency' },
  { id: 'testability',  label: 'Testability' },
  { id: 'operability',  label: 'Operability' },
]

const results = (await parallel([
  ...MODES.map(m => () =>
    agent(
      `Adversarially critique the architecture using mode: ${m.id}\n\n` +
      `architecture_dir: ${architecture_dir}\n\n` +
      `Read all markdown files in the architecture directory and return structured adversarial findings only.`,
      {
        label: `adversary:${m.id}`,
        phase: 'Architecture Critique',
        agentType: 'ai-lore:architect-adversary',
        schema: ADVERSARY_SCHEMA,
      }
    )
  ),
  ...PERSPECTIVES.map(p => () =>
    agent(
      `Review the architecture from the perspective of: ${p.id}\n\n` +
      `architecture_dir: ${architecture_dir}\n` +
      `project_root: ${project_root}\n\n` +
      `Read all markdown files in the architecture directory and return structured findings from your perspective only.`,
      {
        label: `panel:${p.id}`,
        phase: 'Architecture Critique',
        agentType: 'ai-lore:architect-reviewer',
        schema: PANEL_SCHEMA,
      }
    )
  ),
])).filter(Boolean)

return {
  adversary: results.filter(r => r.mode),
  panel:     results.filter(r => r.perspective),
}
```

Call:
```
Workflow({
  script: <the js block above verbatim>,
  args: {
    architecture_dir: '<absolute path to .ai-lore/plans/<slug>/architecture/>',
    project_root: '<absolute path to the project root>'
  }
})
```

Capture the result as `critique`. It contains two arrays: `critique.adversary` (3 results, keyed by `mode`) and `critique.panel` (5 results, keyed by `perspective`).

---

## 8. Synthesize findings

Aggregate across all 8 results:

- `all_findings`: flat list of all findings, preserving their source (`mode` or `perspective`) and `severity`.
- `blocking_count`: findings where `severity == "blocking"`.
- `advisory_count`: findings where `severity == "advisory"`.
- `open_questions`: combined unique list from all panel results.

Sort `all_findings`: blocking before advisory, then by source.

### Fidelity check (only when `brainstorm_dir` is set)

The critique agents never read the brainstorm; this check is yours, run inline against the brainstorm files loaded in step 3. Walk the brainstorm's commitments against the final draft and record every miss as a `fidelity_gap`:

- Every surface and flow in `flows.md` maps to a component, a contract, or the runtime view.
- Every constraint and confirmed assumption in `constraints.md` is honored by the design or explicitly present in Non-goals or Risks and open questions.
- Every edge case in `edge-cases.md` has a home: a contract error case, a component behavior, or an explicit risk.
- Every blocking question the brainstorm routed to the architect (`brief.md`, `open-questions.md`) is answered by a decision or listed in Risks and open questions.

A gap is not automatically a defect; the user may have cut scope deliberately. But it must be visible, never silently planned over.

---

## 9. Present findings and ask for approval

Print an inline summary:

```
Architecture critique complete for <slug> (<blocking_count> blocking, <advisory_count> advisory).

Adversarial review:
  Coherence:        <N blocking, N advisory> -- <one-line summary>
  Devil's Advocate: <N blocking, N advisory> -- <one-line summary>
  Failure Modes:    <N blocking, N advisory> -- <one-line summary>

Panel review:
  Security:     <N blocking, N advisory> -- <one-line summary>
  Simplicity:   <N blocking, N advisory> -- <one-line summary>
  Consistency:  <N blocking, N advisory> -- <one-line summary>
  Testability:  <N blocking, N advisory> -- <one-line summary>
  Operability:  <N blocking, N advisory> -- <one-line summary>

<If blocking_count > 0:>
Blocking findings:
- [<source>] <file>: <description>
<...one line per blocking finding>

<If fidelity_gaps non-empty:>
Fidelity gaps (brainstorm commitments with no home in the design):
- <gap>

<If open_questions non-empty:>
Open questions:
- <question>
```

Then use `AskUserQuestion` to ask:

> "How would you like to proceed?"

Options:
- **Approve** -- accept the architecture as written and proceed to decision promotion, then plan-waves
- **Revise** -- describe changes; ail-architect will update the files and re-run the critique
- **Abandon** -- leave the draft files in place; return to the ai-lore menu

**If Approve:** continue to step 10.

**If Revise:** ask the user what to change. Apply the changes directly to the relevant architecture files, following the fold rules:
- An accepted finding is folded into the section it concerns (a mitigated risk becomes a component behavior, a contract change, or a constraint; it does not stay listed as a risk). `## Risks and open questions` holds only what remains unresolved after the revision.
- A fidelity gap the user confirms as a deliberate cut is recorded as a non-goal; one they want covered is designed in like any accepted finding.
- If a revision overturns a resolved fork, update that `D<n>` subsection's Choice and Rationale in place and note the overturned option among its Options; never append a duplicate subsection for the same fork. If the revision introduces a *new* material fork, resolve it with the user (step 4 rules) and add it as the next `D<n>`.
Then loop back to step 7 (re-run critique against the updated files). Do not regenerate files that were not touched.

**If Abandon:** report the draft location and stop. The draft files remain on disk; the user can resume by re-invoking `ail-architect` and choosing "resume from draft" in step 2.

---

## 10. Promote decisions

This runs once the revise loop has settled, so decisions drafted against a discarded option are never written.

The source material is the `## Decisions` section of `overview.md`: each `D<n>` subsection is a fork the user already resolved in step 4 (or revised in step 9). Walk the subsections through the canonical routine below. Materiality was applied when the forks were selected, but re-check it against the final design; a fork the revise loop made moot is dropped, not promoted. Derive each decision's `affects_paths` from the owned paths of the components it concerns (the `## Components` section carries them). If step 4 noted a reversal against a recalled decision, carry it into `supersedes` here.

### Capture decisions (canonical routine)

> Keep this section in sync with the identical copy in `skills/plan-waves/SKILL.md`. Any edit here must be mirrored there verbatim.

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

### Rewrite the Decisions section (after the routine)

The MADR file is now each promoted decision's one home; `overview.md` keeps only a pointer. Rewrite `## Decisions` in `overview.md` as a flat index:

- A promoted decision: `- [<adr-id>](../decisions/<adr-id>.md) -- <one-line statement of the choice>`
- A skipped or dropped fork: `- <title> -- <one-line statement of the choice> (not recorded as a decision)`

Never leave both a full `D<n>` subsection and a decision file for the same fork; that is two homes for one fact.

---

## 11. Finalize

Update the `status` field in `overview.md` frontmatter from `draft` to `approved`.

Report:

```
Architecture approved and written to .ai-lore/plans/<slug>/architecture/.

Files:
- overview.md
- <other files written>

Decisions promoted: <N> (see .ai-lore/plans/<slug>/decisions/)<; or "none">

Next: run ail-plan-waves to decompose this into atomic tasks. It will detect the approved architecture and skip design-level questions.
```

Then offer to invoke `ail-plan-waves` passing the slug.

---

## Principles

- **Forks first, draft second.** The material decisions are resolved with the user before any file is generated; the document is the residue of those decisions. Never write an alternatives-considered rationale for a choice that was not genuinely on the table.
- **One home per decision, moving once.** A decision lives as a `D<n>` subsection while the design is in motion, and as a MADR file plus an index pointer after approval. Never both at once.
- **Draft first, critique second.** Files are written to disk before critique runs. If the session dies, the draft survives.
- **Risks hold only the unresolved.** Accepted critique findings are folded into the section they concern; `## Risks and open questions` is what remains, not a graveyard of everything ever raised.
- **Overview.md is the index contract.** The `## Files` section must list exactly the files that exist -- no more, no less. plan-waves reads this to know what to load.
- **Critique is a single pass.** If the user wants another critique after revising, it re-runs from step 7. There is no implicit iteration.
- **ail-architect owns the slug when it runs first.** plan-waves reuses the same slug to fill in the rest of the plan folder.
- **Brainstorm is optional context, not a requirement.** ail-architect can start from a raw goal with no prior brainstorm; the delta rule in step 5 then simply does not apply.
- **No em dashes** in any file written by this skill (commas, semicolons, parentheses, periods instead).
- **Status frontmatter is written only by this skill.** Sub-agents return structured findings; this skill writes and updates all files.
