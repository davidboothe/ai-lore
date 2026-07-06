---
name: ail-persona
description: Create, edit, and manage project-specific review personas for the ail-brainstorm expert panel. Interviews the user about who the reviewer is and what they would catch that the built-in panel misses, writes the persona to .ai-lore/personas/<slug>.md, and offers to add it to the brainstorm.panel list in .ai-lore/config.yaml. e.g. "/ail-persona", "/ail-persona create a compliance officer", "/ail-persona list".
---

# ail-persona

Manage the project's custom review personas. ail-brainstorm's expert panel is a mix of built-in perspectives (defined in the ail-brainstorm skill) and project-specific personas defined here. A good custom persona encodes a vantage point this project actually needs (a compliance officer for a payments product, a clinician for a health app, a district admin for an edtech tool) that no generic panel can supply.

Personas review the **WHAT** of a brainstorm (what users see, do, and experience), not the HOW. A persona that critiques architecture belongs in ail-architect's panel, not here.

---

## 1. Argument handling

- `list` (or no argument with existing personas): show every persona under `.ai-lore/personas/` (name, vantage, whether it is in `brainstorm.panel`) plus the five built-ins for reference, then offer: create a new one, edit one, remove one, or done.
- `create <description>` or a free-form description: go to step 2 with the description as seed context.
- `edit <slug>`: read the file, show it, and interview only for what the user wants changed; then rewrite it (step 4).
- `remove <slug>`: confirm, delete the file, and offer to remove the entry from `brainstorm.panel` in `.ai-lore/config.yaml`.
- No argument, no existing personas: briefly explain what a custom persona is, then go to step 2.

The built-in ids (`product_manager`, `end_user_advocate`, `support_ops`, `business_stakeholder`, `feasibility_scout`) are reserved; never create a custom persona with one of those slugs.

---

## 2. Ground and propose

Before interviewing, read what is available in parallel:

- `CLAUDE.md` (or `AGENTS.md`) at the project root.
- `.ai-lore-docs/overview.md` if it exists.

From this context, form a view of the product domain. If the user gave no seed description, propose 2-3 candidate personas grounded in the domain ("this looks like a payments product; a Compliance Officer or a Merchant persona would catch things the default panel will not") and let the user pick or describe their own.

---

## 3. Interview

Ask conversationally, at most 3 questions at a time, skipping anything the seed description already answers:

- **Who are they?** Role and one-sentence vantage point. What do they represent that the built-in panel (product, end user, support, business, feasibility) does not already cover? If the answer overlaps heavily with a built-in, say so and ask what is genuinely different; a duplicate persona just doubles the noise.
- **What do they look for?** 3-6 concrete things this reviewer would flag in a feature brainstorm. Push past adjectives to checkable concerns ("data retention promises the product cannot keep", not "compliance issues").
- **What do they ignore?** What is explicitly not their job, so they do not wander into other reviewers' lanes.
- **What makes a finding blocking for them?** One line describing their severity bar.

Synthesize back: "Here is the persona as I understand it: [synthesis]. Anything to correct?"

---

## 4. Write the persona file

Create `.ai-lore/personas/` if it does not exist. Write `.ai-lore/personas/<slug>.md` where `<slug>` is 2-4 kebab-case words from the persona name:

```markdown
---
name: {{Human-readable persona name}}
vantage: {{one sentence: who this reviewer is and what they represent}}
looks_for:
  - {{concrete concern 1}}
  - {{concrete concern 2}}
ignores:
  - {{explicitly out of lane 1}}
blocking_when: {{one line: what makes a finding blocking for this reviewer}}
---

{{Optional free-form guidance: domain context, the mental test this reviewer applies,
examples of things they would and would not flag. Keep it under 20 lines.}}
```

The entire file is passed verbatim to the `ai-lore:brainstorm-panel` agent as its perspective spec, so write it as instructions to a reviewer, not as documentation about one. No em dashes anywhere in the file.

---

## 5. Wire it into the panel

Ask: "Add `<slug>` to the brainstorm panel in `.ai-lore/config.yaml` so it runs on every review?"

If yes:
- If the config exists: add `<slug>` to the `brainstorm.panel` list. If the `brainstorm:` block or `panel:` key is missing, create it seeded with the five built-in ids plus the new slug, so adding a custom persona never silently drops the defaults.
- If the config does not exist: note that `.ai-lore/config.yaml` has not been created yet and suggest running `/ail-config`; the persona file itself is already in place and can be added to the panel afterward.

If no: report the file path and note it can be added to `brainstorm.panel` later, or passed for a single run by telling ail-brainstorm to include it.

---

## 6. Report

End with a one-line status per action taken, e.g. `persona created: .ai-lore/personas/compliance-officer.md (added to brainstorm.panel)`.

---

## Principles

- **One vantage per persona.** A persona that watches everything catches nothing; force the "ignores" list to be real.
- **WHAT, not HOW.** Personas review user-facing substance. Redirect architecture concerns to ail-architect's panel.
- **No duplicates of built-ins.** If it is not meaningfully different from the five defaults, do not create it.
- **Concrete over adjectival.** "Looks for X" entries must be checkable concerns, not virtues.
- **Never edit built-ins here.** Built-in personas live in the ail-brainstorm skill; this skill only manages `.ai-lore/personas/`.
- **No em dashes** in any file written by this skill (commas, semicolons, parentheses, or periods instead).
