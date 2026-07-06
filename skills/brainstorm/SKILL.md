---
name: ail-brainstorm
description: Interview the user about a feature idea and produce a structured brainstorm under .ai-lore/brainstorm/<slug>/. Sizes the interview to the feature, writes six focused domain files plus a one-page brief.md synthesis, optionally runs a single review pass (configurable expert panel + 3-mode adversarial critique) with a findings triage step that applies accepted fixes back into the files, and tracks a completion contract in brainstorm.yaml. Generates a dashboard-style HTML preview. Hands off to ail-architect when the user is ready. e.g. "/ail-brainstorm", "/ail-brainstorm a notifications system", "/ail-brainstorm resume".
---

# ail-brainstorm

Turn a rough feature idea into a structured brainstorm ready to hand to ail-architect. The skill interviews the user conversationally about what users expect to see and experience (not how it is built), writes focused domain files, optionally runs one merged review pass (expert panel plus adversarial critique) followed by a findings triage, then writes a one-page `brief.md` that is the full picture of the brainstorm. An HTML preview with a dashboard landing is generated at the end and regenerated on every change.

The end state is defined by the **completion contract** (see section "Completion contract" below), not by which steps ran.

---

## 0. Check for an existing brainstorm (resume detection)

Before doing anything else, check whether `.ai-lore/brainstorm/` exists in the current project.

- If the user passed `resume` or a slug as an argument: look for a matching directory under `.ai-lore/brainstorm/`. If found, read its `brainstorm.yaml` and jump to the step matching its `status`:
  - `interviewing` -- read `interview_phase` (treat as `0` if absent) and `size` (treat as `standard` if absent), read `interview-notes.md` for prior answers, then resume at the first incomplete phase: `0` -> step 5 (Phase 1), `1` -> step 6 (Phase 2, or the merged small pass), `2` -> step 7 (Phase 3), `3` -> all phases answered but files never written; go to step 8.
  - `files-written` -- go to step 9 (offer review).
  - `review-done` -- go to step 10 (triage). If `review.json` is missing (should not happen), fall back to step 9.
  - `triaged` -- go to step 11 (brief). If `brief.md` already exists but `html_generated` is false, go to step 13 (HTML); if both exist, go to step 14 (user review pause).
  - `complete` -- report that the brainstorm is complete, offer to hand off to ail-architect or start a new one.
  - Legacy statuses `team-review-done` and `adversarial-done` (written by plugin versions before 0.12.0): treat as reviewed but untriaged in the old format. `review.json` will not exist, so skip triage; go to step 11 (brief) and note to the user that the old-format review reports (`team-review.md`, `adversarial.md`) were kept but cannot be triaged.
- If the user passed a topic and a brainstorm with a slug derived from that topic already exists, confirm: "A brainstorm for `<slug>` already exists. Resume it, start fresh, or abort?"
- If the user passed no argument and brainstorms exist, list them with title and status, and ask: "Start a new brainstorm or resume an existing one?"
- If no brainstorms exist at all, proceed directly to step 1.

---

## 1. Read project context

Run these in parallel before asking the first interview question:

- Read `CLAUDE.md` (or `AGENTS.md`) at the project root for conventions, invariants, and architectural constraints.
- If `.ai-lore-docs/state.yaml` exists, read `.ai-lore-docs/overview.md` for the system architecture, then read any module docs under `.ai-lore-docs/modules/` whose names overlap with the feature topic. Use these to seed grounded questions in the interview.
- Read `.ai-lore/config.yaml` if it exists and note the `brainstorm.panel` list for later (step 9). Do not run ail-config here; a missing config just means the default panel.
- Dispatch an `Explore` agent to find files and patterns in the codebase related to the feature topic (search breadth: quick). Use the results to ask more specific questions in step 5.

Do not present these findings to the user yet -- hold them as interview context.

---

## 2. Get initial description

Ask the user for a free-form description before starting the structured interview. Do not use `AskUserQuestion` here -- this should feel like an open invitation, not a form field.

- If the user passed **no argument**: ask "Before we dive in: give me a brief description of what you want to build. A few sentences is plenty -- the more you share upfront, the fewer follow-up questions I'll need to ask."
- If the user passed **a topic argument** (e.g. `/ail-brainstorm a notifications system`): acknowledge it and invite expansion -- "You mentioned *[topic]* -- tell me a bit more about what you have in mind."

Capture the response as `initial_description`. Hold it as context for the Phase 1 interview.

---

## 3. Create the brainstorm slug and state file

Generate a slug: `YYYY-MM-DD-<topic>` where topic is 2-4 kebab-case words from the feature name. Use today's date. Create `.ai-lore/brainstorm/<slug>/`.

Write `brainstorm.yaml` from `templates/brainstorm.yaml` with `status: interviewing`, `interview_phase: 0`, `size: standard` (updated in step 4), all `completion` keys `false`, and a best-effort `feature` summary drawn from `initial_description` (it can be sharpened later). Creating this now, rather than waiting until step 8, means an interview interrupted partway through still has a slug, a directory, and state to resume from.

---

## 4. Size the interview

Based on `initial_description` and the project context, form a recommendation, then ask one `AskUserQuestion`:

> "How big is this feature?"
> - **Small** -- a focused change or single capability; one main flow, few states. Short interview (one combined pass after the core questions).
> - **Standard** -- a feature with multiple flows, states, or personas. Full three-phase interview.

Put your recommended option first with "(Recommended)". Record the answer as `size` in `brainstorm.yaml`.

Sizing controls the interview only; the output files, review, triage, brief, and completion contract are the same for both sizes (small features just produce shorter files).

---

## 5. Interview: Core concept (Phase 1)

Before asking anything, review `initial_description` and note which of the five Phase 1 topics it already covers clearly. Only ask follow-up questions for topics that are absent or too vague to act on. If all five are addressed, skip straight to the synthesis step.

Ask conversationally. Use `AskUserQuestion` for crisp choices; use prose for open-ended exploration. Ask at most 3 questions at a time. Build on the user's answers before asking more -- do not dump the full list upfront.

**Questions to cover in phase 1 (only ask what is not already answered in `initial_description`):**

- What is this feature trying to do? Ask for a 1-2 sentence description.
- Who is the primary user, and are there secondary users? (If context from step 1 reveals existing user types, mention them.)
- What does the "before" state look like -- what problem or friction does this solve?
- What does success look like? How would you measure it?
- What is explicitly out of scope for the first version?

After gathering these answers, synthesize them back to the user: "So far I understand this as: [your synthesis]. Does that capture it, or is there anything to correct before we go deeper?"

Once the user confirms, append a brief note summarizing the phase 1 answers to `interview-notes.md` in the brainstorm directory (create the file if it does not yet exist), and update `brainstorm.yaml`: set `interview_phase: 1`.

**If `size: small`**, continue to the merged pass in step 6 and skip step 7.

---

## 6. Interview: Mechanics (Phase 2)

### Standard size

Continue the conversation. Cover these questions, again at most 3 at a time:

- Walk me through the happy path step by step. What does the user do, and what does the system do at each step?
- What states can the feature be in? (e.g. loading, empty, populated, error, processing)
- What triggers transitions between states?
- What does failure look like to the user -- what should they see and be able to do?
- Are there any concurrent-access scenarios? (multiple users acting on the same data at the same time)
- What notifications or side effects does this feature trigger?

Once these are answered, append a brief note summarizing the phase 2 answers to `interview-notes.md`, and update `brainstorm.yaml`: set `interview_phase: 2`.

### Small size (merged pass, replaces phases 2 and 3)

Cover only the essentials, at most 5 questions total, skipping anything `initial_description` or phase 1 already answered:

- Walk me through the happy path step by step.
- What does failure look like to the user, and how do they recover?
- Who can use this, and who is excluded?
- Is there anything this feature must never do, from the user's perspective?
- Any hard user-facing expectations? (must feel instant, must work on mobile, etc.)

Once answered, append the note to `interview-notes.md` and set `interview_phase: 3`. Go to step 8.

---

## 7. Interview: Constraints (Phase 3, standard size only)

Cover these questions. Keep answers user-facing -- if the conversation drifts into implementation details, redirect: "Let's save the technical 'how' for the architecture phase. From the user's perspective, what matters here?"

- Who can use this feature, and who is excluded? (roles, account types, or access rules as the user would understand them)
- Are there any business rules that must always hold? (e.g. "a user cannot do X while Y is pending")
- Are there any non-functional expectations from the user's perspective? (e.g. must feel instant, must work on mobile, must work offline)
- Is there anything this feature must never do from the user's perspective, even if it were technically possible?
- How should the user know if something goes wrong? What recovery path should they have?

Once these are answered, append a brief note summarizing the phase 3 answers to `interview-notes.md`, and update `brainstorm.yaml`: set `interview_phase: 3`.

---

## 8. Write domain files

Refresh the `feature` summary in `brainstorm.yaml` now that the full interview is complete, if it needs sharpening.

### Writing rules (apply to every file)

- **One home per fact.** Each concept, rule, or rationale is explained in exactly one file. Other files that need it reference it with a one-line pointer ("see constraints.md, Access rules"). Restating the same idea in overview, personas, and constraints is the main source of bloat; do not do it.
- **No marketing prose.** State what the feature does and why, once, plainly. Do not sell it.
- **Diagrams are conditional, not mandatory.** Use a diagram only when the section clears its threshold (see "Diagram rules" below). Below threshold, use a table or a numbered list; both read faster than a sparse diagram.
- **Split large diagrams.** A diagram that exceeds the size caps must be broken into smaller diagrams by subflow or subsystem, each with a one-line caption. One readable diagram per idea beats one mural.
- **Soft budgets** (exceed only when the content genuinely requires it, never with filler): `overview.md` 60 lines; `personas.md` 15 lines per persona, at most 4 personas; `flows.md` 10 lines of prose per flow beyond its diagram; `edge-cases.md` 50 lines; `constraints.md` 40 lines.

### The six files

#### `overview.md`

- A 2-3 sentence summary of what the feature is and why it exists.
- A `mindmap` or `flowchart LR` concept map only if the feature has 3 or more distinct concept branches; otherwise skip it.
- Sections: **What it is**, **Why it matters** (short; the pitch lives in brief.md later), **Definition of done**, **MVP vs future** (explicit split: a non-empty "ships first" list and a non-empty "deferred" list), **Success measure** (at least one objectively checkable signal).
- After writing, set `completion.mvp_split`, `completion.success_measure`, and `completion.out_of_scope` in `brainstorm.yaml` to reflect what the file actually contains.

#### `personas.md`

- At most 4 personas; mark at least one `(primary)`.
- A mermaid `journey` diagram only if 2 or more personas cross 3 or more touchpoints; otherwise a simple table (persona, goal, pain point) is better.
- For each persona: name, role, goal, pain point this feature addresses, what they need to be able to do. Budget: 15 lines each.
- Note any tension between personas in one short section.
- After writing, set `completion.primary_persona`.

#### `flows.md`

- For each main flow (happy path plus at least one failure path): a `sequenceDiagram` if the flow has 3 or more actor/system exchanges; otherwise a numbered step list.
- A `stateDiagram-v2` only if the feature has 3 or more states.
- Prose fills in what the diagram cannot show (error messages, data formats, edge conditions); at most 10 lines per flow.
- After writing, set `completion.happy_path_covered` and `completion.failure_path_covered` (a flow counts as covered when it has a diagram or a numbered step list, not a paragraph).

#### `edge-cases.md`

- A `flowchart TD` decision tree only if there are 4 or more branching outcomes; otherwise a table.
- Cover: empty states, null/missing data, concurrent access, over-limit inputs, and graceful degradation scenarios.
- For each edge case: describe it, state the expected system behavior, and note whether the brainstorm currently accounts for it.

#### `constraints.md`

- No diagram. Sections: **Access rules**, **Business constraints**, **User experience expectations**, **Known risks to the user experience**. All stated as the user would understand them, without assuming implementation.

#### `open-questions.md`

- No diagram. A prioritized list of unresolved decisions. For each: the question, why it matters, and who needs to answer it (user, team, stakeholder, technical spike).
- Separate into: **Blocking** (must resolve before planning) and **Deferrable** (can decide during planning or build).

### Update brainstorm.yaml

Set `status: files-written` and the completion keys noted above.

---

## 9. Offer review (optional, one pass)

### Resolve the panel roster first

1. Read `brainstorm.panel` from `.ai-lore/config.yaml`. If the key or the config is absent, use the default roster: `product_manager`, `end_user_advocate`, `support_ops`, `business_stakeholder`, `feasibility_scout`.
2. For each entry: if it is a built-in id (see "Built-in review personas" below), use the built-in spec. Otherwise look for `.ai-lore/personas/<entry>.md`; if found, use its full contents as the spec. If neither matches, warn the user ("panel entry `<entry>` has no built-in or persona file; skipping it; create one with /ail-persona") and continue with the rest. Never fail the review over one bad entry, but never run with an empty roster; if all entries failed to resolve, fall back to the default roster and say so.
3. Build a `personas` array of `{ id, label, spec }` objects, where `spec` is the full instruction text for that reviewer.

Then ask the user:

> "The brainstorm files are written. Would you like a review pass? This fans out the expert panel (<comma-separated persona labels>) plus 3 adversarial critiques (Contradictions, False Assumptions, Failure Modes) in parallel, then walks you through triaging the blocking findings."

If no, skip to step 11 (brief). If yes, run the review workflow (step 9a).

### Step 9a: Review (Workflow)

Call `Workflow` with the inline script below. Pass the `script` parameter exactly as written -- do not modify it.

```js
export const meta = {
  name: 'brainstorm-review',
  description: 'Fan out brainstorm panel personas and adversarial critique modes in one parallel review pass',
  phases: [{ title: 'Panel Review' }, { title: 'Adversarial Review' }],
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

function _args(a) {
  // Workflow may deliver args as an object or as a (possibly double-encoded) JSON string.
  for (let i = 0; i < 2 && typeof a === 'string' && a.length; i++) {
    try { a = JSON.parse(a) } catch { break }
  }
  return (a && typeof a === 'object' && !Array.isArray(a)) ? a : {}
}
const parsed = _args(args)
const brainstorm_dir = parsed.brainstorm_dir
const personas = Array.isArray(parsed.personas) ? parsed.personas : []
log(`brainstorm_dir: ${brainstorm_dir ?? '(undefined)'}; personas: ${personas.map(p => p.id).join(', ') || '(none)'}`)
if (!brainstorm_dir) {
  log(`FATAL: brainstorm review received no brainstorm_dir; typeof args=${typeof args}`)
  throw new Error(`brainstorm review: expected brainstorm_dir in args, got none (typeof args=${typeof args})`)
}
if (!personas.length) {
  log(`FATAL: brainstorm review received an empty personas array; typeof args=${typeof args}`)
  throw new Error(`brainstorm review: expected a non-empty personas array in args (typeof args=${typeof args})`)
}

const MODES = [
  { id: 'contradictions', label: 'Contradictions' },
  { id: 'assumptions',    label: 'False Assumptions' },
  { id: 'failure_modes',  label: 'Failure Modes' },
]

const panelThunks = personas.map(p => () =>
  agent(
    `Review the brainstorm from the reviewer perspective described below.\n\n` +
    `brainstorm_dir: ${brainstorm_dir}\n\n` +
    `persona_id: ${p.id}\n` +
    `persona_name: ${p.label}\n\n` +
    `Persona spec (your vantage point, what to look for, what to ignore):\n${p.spec}\n\n` +
    `Read all markdown files in the brainstorm directory and return structured findings from this perspective only. ` +
    `Set "perspective" in your result to exactly "${p.id}".`,
    {
      label: `panel:${p.id}`,
      phase: 'Panel Review',
      agentType: 'ai-lore:brainstorm-panel',
      schema: PANEL_SCHEMA,
    }
  )
)

const advThunks = MODES.map(m => () =>
  agent(
    `Adversarially review the brainstorm using mode: ${m.id}\n\n` +
    `brainstorm_dir: ${brainstorm_dir}\n\n` +
    `Read all markdown files in the brainstorm directory and return structured adversarial findings only.`,
    {
      label: `adversary:${m.id}`,
      phase: 'Adversarial Review',
      agentType: 'ai-lore:brainstorm-adversary',
      schema: ADVERSARY_SCHEMA,
    }
  )
)

const all = await parallel([...panelThunks, ...advThunks])
const panel = all.slice(0, personas.length).filter(Boolean)
const adversary = all.slice(personas.length).filter(Boolean)
log(`panel returned: ${panel.length}/${personas.length}; adversary returned: ${adversary.length}/${MODES.length}`)
return { panel, adversary }
```

Call: `Workflow({ script: <the js block above verbatim>, args: { brainstorm_dir: '<absolute path to .ai-lore/brainstorm/<slug>>', personas: <the personas array from roster resolution> } })`. **Pass `args` as an actual JSON object, not a JSON-encoded string.**

### Step 9b: Write review.json and review.md

The workflow returns `{ panel, adversary }`. Compare `panel` against the roster and `adversary` against the 3 modes; any reviewer that errored is silently absent, so record who is missing rather than pretending full coverage.

Write `review.json` in the brainstorm directory. It is the structured source of truth for triage and for the HTML renderer:

```json
{
  "slug": "<slug>",
  "personas_expected": ["<id>", "..."],
  "personas_returned": ["<id>", "..."],
  "modes_expected": ["contradictions", "assumptions", "failure_modes"],
  "modes_returned": ["..."],
  "findings": [
    {
      "id": "F1",
      "source": "panel",
      "origin": "<persona id or adversary mode>",
      "severity": "blocking",
      "files": ["overview.md"],
      "type": "<panel finding type, or empty string for adversary findings>",
      "description": "...",
      "suggestion": "...",
      "implication": "<adversary findings only; empty string otherwise>",
      "disposition": "pending",
      "note": ""
    }
  ],
  "open_questions": ["<deduplicated across panelists>"],
  "suggested_additions": ["<deduplicated across panelists>"],
  "summaries": [{ "origin": "<id>", "source": "panel", "summary": "..." }]
}
```

Number findings `F1, F2, ...` in a stable order (panel findings first, in roster order; then adversary findings, in mode order; blocking before advisory within each origin). Normalize panel `file` (a string) and adversary `files_involved` (an array) into the single `files` array. Every finding starts with `disposition: "pending"` and an empty `note`.

Also write `review.md`, a compact human-readable report (no em dashes):

```markdown
---
slug: <slug>
reviewers_returned: <N of M>
blocking_total: <count>
advisory_total: <count>
---

# Review: <title>

## Coverage

| Reviewer | Kind | Blocking | Advisory | Summary |
|---|---|---|---|---|
<one row per origin actually returned>

<if any expected persona or mode is missing, list each by name here with "did not return a result; treat this review as partial." Otherwise omit this paragraph.>

## Findings

<for each origin present, blocking-first: "**[<id>] [<severity>]** `<files>` <description> Suggestion: <suggestion>">

## Open questions raised

<deduplicated list>

## Suggested additions

<deduplicated list>
```

Update `brainstorm.yaml`: set `status: review-done`. If any expected reviewer is missing, say so now and repeat it in the step 14 summary.

---

## 10. Triage findings

The point of the review is to improve the brainstorm, not to grow the pile of reports. Walk the findings with the user and apply what they accept.

1. **Blocking findings** (disposition `pending`, severity `blocking`): present them via `AskUserQuestion`, up to 4 per call, in `id` order. For each finding show the origin, files, description, and suggestion, and offer:
   - **Accept** -- apply the suggestion to the affected domain file(s) now.
   - **Reject** -- record the user's reason (ask for one line if not given).
   - **Defer** -- add it to `open-questions.md` (blocking section if it blocks planning, deferrable otherwise) and record that.
2. **Advisory findings**: present a compact numbered list (id, origin, one-line description) and ask once: "Apply all, pick which to apply (list ids), defer all to open questions, or skip the rest?" Apply the choice in bulk.
3. Apply every accepted suggestion to the domain files immediately, respecting the writing rules from step 8 (budgets, one home per fact, conditional diagrams).
4. Update `review.json`: set each finding's `disposition` (`accepted`, `rejected`, or `deferred`) and `note`. Findings the user skipped stay `pending`.
5. Fold the review's `open_questions` into `open-questions.md` if they are not already covered.

Update `brainstorm.yaml`: set `status: triaged`.

---

## 11. Write brief.md

Written last, after triage (or straight after step 8 if the review was skipped). This is the one-page synthesis; someone who reads only this file knows what was brainstormed. Hard budget: about 40 lines of prose plus at most one diagram.

```markdown
# Brief: <title>

## Pitch
<1-2 sentences. What this is and why it matters.>

## Who it's for
<one line per persona: "**<name> (primary):** <goal in one line>">

## The core flow
<the single most important flow: one small diagram (within the size caps) or a numbered step list. Do not include more than one diagram.>

## MVP cut
**Ships first:** <comma-separated or short bullets>
**Deferred:** <same>

## Top risks
<3 to 5 bullets. Source them from accepted and deferred blocking findings and the sharpest edge cases; if no review ran, use your own judgment. Each bullet: the risk and why it matters, one line.>

## Open questions going into planning
<blocking first, one line each, from open-questions.md>
```

Then confirm the pitch with the user verbatim: "Here is the pitch as written: '<pitch>'. Is that right?" Adjust until they confirm, then set `completion.pitch_confirmed` in `brainstorm.yaml`.

---

## 12. Completion check

Evaluate the completion contract (see "Completion contract" below) against the actual files, not against which steps ran. For each unchecked box, either fix it now (with the user) or report it plainly.

`completion.blocking_questions_resolved` deserves special handling: go through the **Blocking** list in `open-questions.md` with the user. Each item must be either answered now (fold the answer into the domain files and remove it from blocking) or explicitly deferred by the user (move it to deferrable with a one-line note of who will decide and when). Never silently carry a blocking question; the user saying "defer it" is the resolution. When the blocking list is empty or every remaining item was explicitly deferred, set the key true.

If the user wants to stop with boxes unchecked, that is allowed; report exactly which boxes are unchecked so the gap is visible (the HTML dashboard shows the same checklist).

---

## 13. Generate HTML

**Prerequisite:** This step requires Node.js. Before running the script, check that `node` is available by running `node --version`. If the command fails (not found or exits non-zero), report: "HTML preview requires Node.js. Skipping render -- the brainstorm files are complete and can be opened directly." Then skip the rest of step 13 and continue to step 14 without setting `html_generated: true`.

Run the render script to produce `index.html`:

```bash
node <plugin_root>/scripts/render-brainstorm.js <absolute path to .ai-lore/brainstorm/<slug>>
```

The script prints the output path on success. If it exits non-zero, report the error and stop.

After the script succeeds, report the file path; do not attempt to show it as an inline artifact. The generated HTML loads mermaid and marked from a CDN and renders all content client-side via a script tag, and artifact contexts block requests to external hosts, so an artifact render would show empty placeholders instead of the brainstorm content.

> "HTML preview generated at `.ai-lore/brainstorm/<slug>/index.html`. Open it in a regular browser with internet access (it loads mermaid and marked from a CDN). It lands on the dashboard: pitch, completion checklist, and finding counts up top; details are collapsed below."

Update `brainstorm.yaml`: set `html_generated: true`.

---

## 14. User review pause

Present a summary of what was generated:

```
Brainstorm ready for "<title>"  (size: <small|standard>)
  brief.md          -- the one-page synthesis (read this first)
  overview.md       -- what/why, MVP split, success measure
  personas.md       -- <N> personas
  flows.md          -- <N> flows
  edge-cases.md     -- <N> edge cases
  constraints.md    -- access rules, business constraints, UX expectations
  open-questions.md -- <N> blocking, <N> deferrable
  <review.md        -- <N of M> reviewers, <N> blocking findings (<N> accepted, <N> rejected, <N> deferred)>   (if run)
Completion: <N of 8> boxes checked<; list any unchecked>
```

If any reviewer was missing from the review, repeat that here.

Then ask: "Review the HTML preview (it opens on the dashboard). Make any edits you want to the brainstorm files directly, or tell me changes to apply here. When you are ready, say so and I will hand off."

Wait for the user's response. Apply any requested changes to the brainstorm files. If domain files changed, refresh `brief.md` to match, then regenerate the HTML (re-run the script from step 13) and report the refreshed file path.

---

## 15. Handoff

Update `brainstorm.yaml`: set `status: complete`. Do this first, before asking anything below; once the user accepts the handoff and `ail-architect` is invoked, control transfers away and this update would never run. If completion boxes are unchecked, note them one final time when reporting; the user has already accepted the gaps in step 12.

Ask the user:

> "The brainstorm is ready. Would you like to design the architecture next with ail-architect? It will use the brainstorm files as WHAT context and produce the HOW (components, data model, API contracts, key decisions) before decomposition."

If yes: invoke `ail-architect`. Pass the absolute path to the brainstorm directory (`.ai-lore/brainstorm/<slug>/`) so ail-architect step 2 can offer it as existing brainstorm context automatically.

If no: report the brainstorm directory path. Suggest running `ail-architect` later with `/ail-architect`, or skipping directly to `ail-plan-waves` if architecture design is not needed for this feature.

---

## Completion contract

Tracked as the `completion` block in `brainstorm.yaml`; every key must be true before the brainstorm is genuinely done. The skill sets keys as the corresponding content lands (steps 8, 11, 12) and re-checks them all in step 12. The HTML dashboard renders this checklist.

| Key | True when |
|---|---|
| `pitch_confirmed` | brief.md has a pitch the user confirmed verbatim (step 11) |
| `primary_persona` | personas.md has 1-4 personas with at least one marked primary |
| `happy_path_covered` | flows.md covers the happy path with a diagram or numbered step list |
| `failure_path_covered` | flows.md covers at least one failure path the same way |
| `mvp_split` | overview.md has non-empty "ships first" AND non-empty "deferred" lists |
| `success_measure` | overview.md states at least one objectively checkable success signal |
| `out_of_scope` | the out-of-scope list from the interview is recorded and non-empty |
| `blocking_questions_resolved` | every blocking open question is answered or explicitly deferred by the user with a note |

---

## Built-in review personas

These are the five default panel entries. Each spec below is passed to the `ai-lore:brainstorm-panel` agent as its perspective. The panel reviews the WHAT; deep security and architecture critique belongs to ail-architect's panel, not here.

### product_manager (Product Manager)

Vantage: owns scope honesty and MVP viability. Looks for: goals that are vague or unmeasurable, scope that mixes MVP with future features without distinguishing them, missing or unfalsifiable success criteria, requirements that conflict with each other, things that should be cut from v1, blocking open questions left unresolved. Ignores: implementation choices, visual design details.

### end_user_advocate (End-User Advocate)

Vantage: the person actually using the feature. Looks for: flows that skip steps a real user would need, error states with no recovery path, missing empty and zero-data states, places where a persona's mental model differs from how the feature behaves, unclear triggers and affordances, accessibility gaps stated as user experience (can I do this with a keyboard, can I tell what went wrong). Ignores: business metrics, technical feasibility.

### support_ops (Support / Operations)

Vantage: the person who answers the tickets this feature will generate. Looks for: states a user can get stuck in with no self-service way out, error messages that will not help a confused user, behavior that will be perceived as data loss even when it is not, missing "how do I undo this" paths, anything that requires a human to explain. Test: "how would I explain this to an angry user on a bad day?" Ignores: architecture, code quality.

### business_stakeholder (Business Stakeholder)

Vantage: the person paying for this. Looks for: a value proposition that does not survive "why would anyone use this", adoption risk (who has to change their behavior for this to work), an MVP cut whose effort is out of proportion to its payoff, success measures not tied to any outcome anyone cares about, deferred items that quietly gut the value of what ships first. Ignores: implementation, UX minutiae.

### feasibility_scout (Feasibility Scout)

Vantage: an early-warning system, not a designer. Its ONLY job is to flag places where the WHAT implies a much bigger HOW than the brainstorm seems to assume: real-time collaboration, offline support, cross-user consistency, permission matrices, data migrations, third-party integrations with hard failure modes. For each flag: what in the brainstorm implies it, and one sentence on why it is bigger than it looks. It must NOT propose architectures, data models, or solutions; its findings are routed to open-questions.md for ail-architect to answer. Ignores: everything that is straightforwardly buildable.

Custom personas live at `.ai-lore/personas/<slug>.md` (create them with `/ail-persona`) and are mixed into the roster via `brainstorm.panel` in `.ai-lore/config.yaml`.

---

## Diagram rules

Diagrams exist to carry structure, not to decorate. Two rules govern every diagram in every file this skill writes:

**Thresholds.** Use a diagram only when the content clears the bar; otherwise use a table or numbered list.

| Diagram | Use only when | Typical file |
|---|---|---|
| `mindmap` / `flowchart LR` | 3+ distinct concept branches | overview.md |
| `journey` | 2+ personas across 3+ touchpoints | personas.md |
| `sequenceDiagram` | flow has 3+ actor/system exchanges | flows.md |
| `stateDiagram-v2` | 3+ states | flows.md |
| `flowchart TD` | 4+ branching outcomes | edge-cases.md |

**Size caps.** At most 12 nodes per flowchart, mindmap, or state diagram; at most 6 participants and 10 messages per sequence diagram. A diagram that would exceed a cap must be split into smaller diagrams by subflow or subsystem, each with a one-line caption saying what slice it shows. Large diagrams are hard to read; never ship a mural.

When a diagram is used, it leads its section and the prose fills in only what the diagram cannot show.

---

## Principles

- **Interview before writing.** Never write brainstorm files straight from the prompt. Surface the decisions first.
- **Conversational, not a questionnaire.** Ask 2-3 questions at a time, build on answers, synthesize before moving on. Size the interview to the feature.
- **brief.md is the roof.** One page, written last, always current with the domain files. If someone reads one file, it is this one.
- **One home per fact.** Cross-file redundancy is the enemy of "I can see the whole thing".
- **Diagrams carry structure or they do not exist.** Thresholds and size caps are hard rules, not suggestions.
- **Reviews improve the artifact.** Findings are triaged with the user and accepted fixes are applied to the domain files; reports are the record, not the destination.
- **Stay user-facing throughout.** The brainstorm captures what a user expects to see, do, and experience. Technical decisions belong in the architect phase; the feasibility scout flags them, ail-architect answers them. If the interview drifts into implementation, redirect: "Let's save the technical 'how' for ail-architect. What matters here from the user's perspective?"
- **The completion contract defines done.** Steps can be skipped; unchecked boxes cannot be hidden. Report them plainly and show them on the dashboard.
- **HTML regenerates on every change.** Rerun the script whenever any brainstorm file changes; never let the HTML fall out of sync.
- **No em dashes** in any file written by this skill (commas, semicolons, parentheses, or periods instead).
- **Findings never block handoff.** Triage is offered, dispositions are recorded, and the user decides what to act on.
