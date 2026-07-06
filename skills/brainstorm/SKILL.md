---
name: ail-brainstorm
description: Interview the user about a feature idea and produce a structured, diagram-rich brainstorm under .ai-lore/brainstorm/<slug>/. Splits output into focused domain files (overview, personas, flows, edge-cases, constraints, open-questions). Optionally fans out a 5-perspective expert panel and a 3-mode adversarial critique via Workflow. Generates a self-contained HTML preview (CDN mermaid + marked) after each phase. Hands off to ail-architect when the user is ready. e.g. "/ail-brainstorm", "/ail-brainstorm a notifications system", "/ail-brainstorm resume".
---

# ail-brainstorm

Turn a rough feature idea into a structured, diagram-rich brainstorm document ready to hand to ail-architect. The skill interviews the user conversationally about what users expect to see and experience -- not how it is built -- writes focused domain files, optionally runs a multi-perspective expert panel and adversarial critique, and generates an HTML preview after each phase.

---

## 0. Check for an existing brainstorm (resume detection)

Before doing anything else, check whether `.ai-lore/brainstorm/` exists in the current project.

- If the user passed `resume` or a slug as an argument: look for a matching directory under `.ai-lore/brainstorm/`. If found, read its `brainstorm.yaml` and jump to the step matching its `status`:
  - `interviewing` -- read `interview_phase` (treat as `0` if absent) and read `interview-notes.md` in the brainstorm directory for prior answers, then resume at the first incomplete phase: `0` -> step 2 (Phase 1), `1` -> step 3 (Phase 2), `2` -> step 4 (Phase 3), `3` -> all three phases are answered but files were never written; go to step 5.
  - `files-written` -- check `brainstorm.yaml` flags before deciding: if `html_generated: true`, skip to step 8 (user review pause); otherwise skip to step 6 (team review offer). Note: status stays `files-written` when the user declines team review, so `html_generated` is the only reliable signal that HTML has already been produced.
  - `team-review-done` -- skip to step 7 (generate HTML)
  - `adversarial-done` -- skip to step 11 (regenerate HTML and handoff)
  - `complete` -- report that the brainstorm is complete, offer to hand off to ail-architect or start a new one
- If the user passed a topic and a brainstorm with a slug derived from that topic already exists, confirm: "A brainstorm for `<slug>` already exists. Resume it, start fresh, or abort?"
- If the user passed no argument and brainstorms exist, list them with title and status, and ask: "Start a new brainstorm or resume an existing one?"
- If no brainstorms exist at all, proceed directly to step 1.

---

## 1. Read project context

Run these in parallel before asking the first interview question:

- Read `CLAUDE.md` (or `AGENTS.md`) at the project root for conventions, invariants, and architectural constraints.
- If `.ai-lore-docs/state.yaml` exists, read `.ai-lore-docs/overview.md` for the system architecture, then read any module docs under `.ai-lore-docs/modules/` whose names overlap with the feature topic. Use these to seed grounded questions in the interview.
- Dispatch an `Explore` agent to find files and patterns in the codebase related to the feature topic (search breadth: quick). Use the results to ask more specific questions in step 2.

Do not present these findings to the user yet -- hold them as interview context.

---

## 1.5. Get initial description

Ask the user for a free-form description before starting the structured interview. Do not use `AskUserQuestion` here -- this should feel like an open invitation, not a form field.

- If the user passed **no argument**: ask "Before we dive in: give me a brief description of what you want to build. A few sentences is plenty -- the more you share upfront, the fewer follow-up questions I'll need to ask."
- If the user passed **a topic argument** (e.g. `/ail-brainstorm a notifications system`): acknowledge it and invite expansion -- "You mentioned *[topic]* -- tell me a bit more about what you have in mind."

Capture the response as `initial_description`. Hold it as context for the Phase 1 interview.

---

## 1.6. Create the brainstorm slug and state file

Generate a slug: `YYYY-MM-DD-<topic>` where topic is 2-4 kebab-case words from the feature name. Use today's date. Create `.ai-lore/brainstorm/<slug>/`.

Write `brainstorm.yaml` from `templates/brainstorm.yaml` with `status: interviewing`, `interview_phase: 0`, and a best-effort `feature` summary drawn from `initial_description` (it can be sharpened later once the interview is complete). Creating this now, rather than waiting until step 5, means an interview interrupted partway through still has a slug, a directory, and state to resume from.

---

## 2. Interview: Core concept (Phase 1)

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

---

## 3. Interview: Mechanics (Phase 2)

Continue the conversation. Cover these questions, again at most 3 at a time:

- Walk me through the happy path step by step. What does the user do, and what does the system do at each step?
- What states can the feature be in? (e.g. loading, empty, populated, error, processing)
- What triggers transitions between states?
- What does failure look like to the user -- what should they see and be able to do?
- Are there any concurrent-access scenarios? (multiple users acting on the same data at the same time)
- What notifications or side effects does this feature trigger?

Once these are answered, append a brief note summarizing the phase 2 answers to `interview-notes.md`, and update `brainstorm.yaml`: set `interview_phase: 2`.

---

## 4. Interview: Constraints (Phase 3)

Cover these questions. Keep answers user-facing -- if the conversation drifts into implementation details, redirect: "Let's save the technical 'how' for the architecture phase. From the user's perspective, what matters here?"

- Who can use this feature, and who is excluded? (roles, account types, or access rules as the user would understand them)
- Are there any business rules that must always hold? (e.g. "a user cannot do X while Y is pending")
- Are there any non-functional expectations from the user's perspective? (e.g. must feel instant, must work on mobile, must work offline)
- Is there anything this feature must never do from the user's perspective, even if it were technically possible?
- How should the user know if something goes wrong? What recovery path should they have?

Once these are answered, append a brief note summarizing the phase 3 answers to `interview-notes.md`, and update `brainstorm.yaml`: set `interview_phase: 3`.

---

## 5. Write brainstorm files

The slug, the `.ai-lore/brainstorm/<slug>/` directory, and `brainstorm.yaml` (`status: interviewing`) were already created in step 1.6. Refresh the `feature` summary in `brainstorm.yaml` now that the full interview is complete, if it needs sharpening.

### Write the domain files

Write all six files below. For each file, **lead with a diagram where one is specified** -- write the diagram first, then the surrounding prose. Diagrams reduce walls of text; if a section has structure or relationships, the diagram carries them. Use mermaid code blocks (` ```mermaid `).

Keep each file focused and tight. Redundancy across files is waste.

#### `overview.md`

- A 2-3 sentence summary of what the feature is and why it exists.
- A `mindmap` or `flowchart LR` diagram showing the feature's main concepts and how they relate. Put this near the top.
- Sections: **What it is**, **Why it matters**, **Definition of done**, **MVP vs future** (explicit split: what ships first, what is deferred).

#### `personas.md`

- A mermaid `journey` diagram showing each persona's experience across touchpoints. Put this near the top.
- For each persona: name, role, goal, pain point this feature addresses, what they need to be able to do.
- Note any tension between personas (one persona's convenience is another's security risk, etc.).

#### `flows.md`

- For each main flow (happy path + at least one failure path): a `sequenceDiagram` showing actor, system, and any external services.
- A `stateDiagram-v2` for the feature's state machine (all states and transitions).
- Diagrams come first in each flow section; prose fills in what the diagram cannot show (error messages, data formats, edge conditions).
- Do not describe flows in prose only -- if a flow is complex enough to write about, it is complex enough to diagram.

#### `edge-cases.md`

- A `flowchart TD` decision tree covering the main error and edge-case paths. Put this near the top.
- Then a table or list covering: empty states, null/missing data, concurrent access, over-limit inputs, and graceful degradation scenarios.
- For each edge case: describe it, state the expected system behavior, and note whether the brainstorm currently accounts for it.

#### `constraints.md`

- No diagram needed; this file is a structured reference for the architect phase.
- Sections: **Access rules** (who can and cannot use the feature, as the user would understand it), **Business constraints** (rules that must always hold, things the feature must never violate), **User experience expectations** (non-functional quality expectations as the user perceives them -- speed, availability, device support), **Known risks to the user experience** (what could break the experience, stated without assuming implementation).

#### `open-questions.md`

- No diagram needed.
- A prioritized list of unresolved decisions that block planning. For each: the question, why it matters, and who needs to answer it (user, team, stakeholder, technical spike).
- Separate into: **Blocking** (must resolve before planning) and **Deferrable** (can decide during planning or build).

### Update brainstorm.yaml

Set `status: files-written`.

---

## 6. Offer team review (optional)

Ask the user:

> "The brainstorm files are written. Would you like an expert panel to review them? This runs 5 perspectives in parallel (Product Manager, UX Advocate, Architect, Security, QA) and writes their findings to `team-review.md`."

If yes, run the team review workflow (step 6a). If no, skip to step 7.

### Step 6a: Team review (Workflow)

Call `Workflow` with the inline script below. Pass the `script` parameter exactly as written -- do not modify it.

```js
export const meta = {
  name: 'brainstorm-team',
  description: 'Fan out brainstorm-panel agents, one per expert perspective, in parallel',
  phases: [{ title: 'Panel Review' }],
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
const { brainstorm_dir } = _args(args)
log(`brainstorm_dir: ${brainstorm_dir ?? '(undefined)'}`)
if (!brainstorm_dir) {
  log(`FATAL: brainstorm review received no brainstorm_dir; typeof args=${typeof args}`)
  throw new Error(`brainstorm review: expected brainstorm_dir in args, got none (typeof args=${typeof args})`)
}

const PERSPECTIVES = [
  { id: 'product_manager', label: 'Product Manager' },
  { id: 'ux_advocate',     label: 'UX / User Advocate' },
  { id: 'architect',       label: 'Architect' },
  { id: 'security',        label: 'Security' },
  { id: 'qa',              label: 'QA / Edge Cases' },
]

const results = (await parallel(PERSPECTIVES.map(p => () =>
  agent(
    `Review the brainstorm from the perspective of: ${p.id}\n\n` +
    `brainstorm_dir: ${brainstorm_dir}\n\n` +
    `Read all markdown files in the brainstorm directory and return structured findings from your perspective only.`,
    {
      label: `panel:${p.id}`,
      phase: 'Panel Review',
      agentType: 'ai-lore:brainstorm-panel',
      schema: PANEL_SCHEMA,
    }
  )
))).filter(Boolean)

return results
```

Call: `Workflow({ script: <the js block above verbatim>, args: { brainstorm_dir: '<absolute path to .ai-lore/brainstorm/<slug>>' } })`. **Pass `args` as an actual JSON object, not a JSON-encoded string.**

Capture the result array as `panel_results`. Each element is a `{ perspective, findings, open_questions, suggested_additions, summary }` object. The workflow script `.filter(Boolean)`s the results, so a panelist that errored is silently dropped from the array; before writing the report, compare `panel_results` against the full list of 5 perspectives (product_manager, ux_advocate, architect, security, qa) to see whether any are missing.

Write `team-review.md` with this format (no em dashes; use commas, semicolons, parentheses, or periods). `perspectives_reviewed` and the summary table must reflect the number of results actually returned, never a hardcoded 5:

```markdown
---
slug: <slug>
perspectives_reviewed: <count of results actually present in panel_results>
blocking_total: <count>
advisory_total: <count>
---

# Team Review: <title>

## Summary by Perspective

| Perspective       | Blocking | Advisory | Summary                         |
|-------------------|----------|----------|---------------------------------|
<one row per perspective present in panel_results; do not pad with rows for perspectives that did not return>

## Missing Perspectives

<if all 5 perspectives returned, write "(none)"; otherwise list each missing perspective by name, e.g. "Security did not return a result.">

## Findings

<for each perspective present in panel_results, sorted blocking-first within each>
### <Perspective Name>

<for each finding:>
**[<severity>] `<file>`** -- <type>
<description>
Suggestion: <suggestion>

<end for each finding>
<if no findings: "(none)">

## Open Questions Raised

<combined deduplicated list of open_questions from all perspectives present>

## Suggested Additions

<combined deduplicated list of suggested_additions from all perspectives present>
```

If fewer than 5 results returned, also say so explicitly in the session summary (step 8), naming the missing perspective(s). Never silently report on fewer perspectives without calling out the gap.

Update `brainstorm.yaml`: set `status: team-review-done`.

---

## 7. Generate HTML

**Prerequisite:** This step requires Node.js. Before running the script, check that `node` is available by running `node --version`. If the command fails (not found or exits non-zero), report: "HTML preview requires Node.js. Skipping render -- the brainstorm files are complete and can be opened directly." Then skip the rest of step 7 and continue to step 8 without setting `html_generated: true`.

Run the render script to produce `index.html`:

```bash
node <plugin_root>/scripts/render-brainstorm.js <absolute path to .ai-lore/brainstorm/<slug>>
```

The script prints the output path on success. If it exits non-zero, report the error and stop.

After the script succeeds, report the file path; do not attempt to show it as an inline artifact. The generated HTML loads mermaid and marked from a CDN and renders all content client-side via a script tag, and artifact contexts block requests to external hosts, so an artifact render would show empty placeholders instead of the brainstorm content.

> "HTML preview generated at `.ai-lore/brainstorm/<slug>/index.html`. Open it in a regular browser with internet access (it loads mermaid and marked from a CDN)."

Update `brainstorm.yaml`: set `html_generated: true`.

---

## 8. User review pause

Present a summary of what was generated:

```
Brainstorm complete for "<title>"
  overview.md       -- concept map and MVP split
  personas.md       -- <N> personas, journey diagram
  flows.md          -- <N> flows, state machine
  edge-cases.md     -- decision tree, <N> edge cases
  constraints.md    -- access rules, business constraints, UX expectations
  open-questions.md -- <N> blocking, <N> deferrable questions
  <team-review.md   -- <N of 5> perspectives, <N> blocking findings, note any missing perspectives>   (if run)
```

Then ask: "Review the HTML preview. Make any edits you want to the brainstorm files directly, or tell me changes to apply here. When you are ready to continue, say so and I will proceed to adversarial review (or hand off to planning if you prefer to skip it)."

Wait for the user's response. Apply any requested changes to the brainstorm files. If any files changed, regenerate the HTML (re-run the script from step 7) and report the refreshed file path for the user to reload in their browser.

---

## 9. Offer adversarial review (optional)

Ask the user:

> "Ready to continue. Would you like an adversarial review before planning? This runs 3 critique passes in parallel (Contradictions, False Assumptions, Failure Modes) and adds findings to `adversarial.md`."

If no, skip to step 12. If yes, proceed to step 10.

---

## 10. Adversarial review (Workflow)

Call `Workflow` with the inline script below. Pass the `script` parameter exactly as written -- do not modify it.

```js
export const meta = {
  name: 'brainstorm-adversary',
  description: 'Fan out brainstorm-adversary agents across three adversarial critique modes in parallel',
  phases: [{ title: 'Adversarial Review' }],
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
const { brainstorm_dir } = _args(args)
log(`brainstorm_dir: ${brainstorm_dir ?? '(undefined)'}`)
if (!brainstorm_dir) {
  log(`FATAL: brainstorm review received no brainstorm_dir; typeof args=${typeof args}`)
  throw new Error(`brainstorm review: expected brainstorm_dir in args, got none (typeof args=${typeof args})`)
}

const MODES = [
  { id: 'contradictions', label: 'Contradictions' },
  { id: 'assumptions',    label: 'False Assumptions' },
  { id: 'failure_modes',  label: 'Failure Modes' },
]

const results = (await parallel(MODES.map(m => () =>
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
))).filter(Boolean)

return results
```

Call: `Workflow({ script: <the js block above verbatim>, args: { brainstorm_dir: '<absolute path to .ai-lore/brainstorm/<slug>>' } })`. **Pass `args` as an actual JSON object, not a JSON-encoded string.**

Capture the result array as `adversary_results`. Each element is a `{ mode, findings, summary }` object. The workflow script `.filter(Boolean)`s the results, so a mode that errored is silently dropped from the array; before writing the report, compare `adversary_results` against the full list of 3 modes (contradictions, assumptions, failure_modes) to see whether any are missing.

Write `adversarial.md` with this format (no em dashes). `modes_run` and the summary table must list only the modes actually returned, never a hardcoded set of all 3:

```markdown
---
slug: <slug>
modes_run: <comma-separated list of modes actually present in adversary_results>
blocking_total: <count>
advisory_total: <count>
---

# Adversarial Review: <title>

## Summary

| Mode              | Blocking | Advisory | Summary                         |
|-------------------|----------|----------|---------------------------------|
<one row per mode present in adversary_results; do not pad with rows for modes that did not return>

## Missing Modes

<if all 3 modes returned, write "(none)"; otherwise list each missing mode by name, e.g. "Failure Modes did not return a result.">

## Findings

<for each mode present in adversary_results, blocking-first within each>
### <Mode Name>

<for each finding, blocking-first:>
**[<severity>]** Files: `<files_involved joined with ", ">`
<description>
Implication: <implication>
Suggestion: <suggestion>

<end for each finding>
<if no findings: "(none)">
```

If fewer than 3 modes returned, also say so explicitly when reporting blocking findings in step 11, naming the missing mode(s). Never silently report on fewer modes without calling out the gap.

Update `brainstorm.yaml`: set `status: adversarial-done`.

---

## 11. Regenerate HTML

Re-run the script from step 7 to include `adversarial.md` in the sidebar and content. Report the refreshed file path as in step 7; do not attempt an inline artifact preview.

Report the blocking finding count:
- If 0 blocking findings across team review and adversarial review: "No blocking findings. The brainstorm looks solid."
- If blocking findings exist: "There are <N> blocking findings. Review them in the adversarial.md section of the preview. You can address them now or carry them into planning as open questions."

If `team-review.md` or `adversarial.md` recorded any missing perspectives or modes, repeat that here too, e.g. "Note: the Security perspective and the Failure Modes critique did not return results; treat this review as partial."

---

## 12. Handoff

Update `brainstorm.yaml`: set `status: complete`. Do this first, before asking anything below; once the user accepts the handoff and `ail-architect` is invoked, control transfers away and this update would never run.

Ask the user:

> "The brainstorm is ready. Would you like to design the architecture next with ail-architect? It will use the brainstorm files as WHAT context and produce the HOW (components, data model, API contracts, key decisions) before decomposition."

If yes: invoke `ail-architect`. Pass the absolute path to the brainstorm directory (`.ai-lore/brainstorm/<slug>/`) so ail-architect step 2 can offer it as existing brainstorm context automatically.

If no: report the brainstorm directory path. Suggest running `ail-architect` later with `/ail-architect`, or skipping directly to `ail-plan-waves` if architecture design is not needed for this feature.

---

## Diagram reference by file

| File              | Diagram type(s)              | Purpose                                           |
|-------------------|------------------------------|---------------------------------------------------|
| `overview.md`     | `mindmap` or `flowchart LR`  | Feature concept map, main relationships           |
| `personas.md`     | `journey`                    | User experience across touchpoints                |
| `flows.md`        | `sequenceDiagram` per flow   | Actor/system interaction for each flow            |
|                   | `stateDiagram-v2`            | All feature states and transitions                |
| `edge-cases.md`   | `flowchart TD`               | Error path decision tree                          |
| `constraints.md`  | (none)                       | Access rules, business constraints, UX expectations |
| `open-questions.md` | (none)                     | List only                                         |
| `team-review.md`  | (none)                       | Written from structured workflow data             |
| `adversarial.md`  | (none)                       | Written from structured workflow data             |

Write diagrams first in each section. If a section has relationships or flow, it needs a diagram. Do not append diagrams as afterthoughts to prose sections.

---

## Principles

- **Interview before writing.** Never write brainstorm files straight from the prompt. Surface the decisions first.
- **Conversational, not a questionnaire.** Ask 2-3 questions at a time, build on answers, synthesize before moving on.
- **Diagrams reduce text.** Every flow and relationship that can be diagrammed should be. Lead with the diagram.
- **Domain files stay focused.** Each file has one job. Cross-file redundancy is waste.
- **Panel is additive; adversarial is destructive.** Team review adds missing angles. Adversarial critique finds what is wrong with what is already there.
- **Stay user-facing throughout.** The brainstorm captures what a user expects to see, do, and experience. Technical decisions -- what systems are involved, how data is stored, what components are needed -- belong in the architect phase. If the interview drifts into implementation, redirect: "Let's save the technical 'how' for ail-architect. What matters here from the user's perspective?"
- **HTML regenerates on every change.** Rerun the script whenever any brainstorm file changes; never let the HTML fall out of sync.
- **No em dashes** in any file written by this skill (commas, semicolons, parentheses, or periods instead).
- **ail-brainstorm is report-only after the interview.** Panel and adversarial findings surface issues but do not block handoff. The user decides what to address.
