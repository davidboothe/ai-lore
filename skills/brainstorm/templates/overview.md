# Overview: {{title}}

<!-- Line cap: 45 lines. Exceed only with genuine content, not filler or prose summaries of bullets. -->
<!-- One home per fact: this file owns the what/why, the vocabulary, the MVP split, out of scope, and the success measure. Other files point here; do not restate. -->

{{2-3 sentence summary of what the feature is and why it exists. No marketing prose.}}

<!-- Concept map: include a mermaid `mindmap` or `flowchart LR` only if the feature has 3 or more distinct concept branches; otherwise skip it entirely. Max 12 nodes; split larger diagrams by subsystem, each with a one-line caption. -->

## What it is

{{Plain statement of what the feature does, once. User-facing terms only.}}

## Why it matters

{{Short: the problem or friction this removes, the before state. The pitch lives in brief.md; do not duplicate it here.}}

## Vocabulary

<!-- The user-facing nouns and their lifecycles, in the user's own language. Cap: about 8 terms. If an entity's lifecycle is drawn as a state diagram in flows.md, point there instead of restating it. -->

| Term | Meaning | Lifecycle |
|---|---|---|
| {{term}} | {{what it is, one line}} | {{states in one line, or "see flows.md"}} |

## Definition of done

{{Bullets: objectively checkable statements of what exists when this feature is complete.}}

## MVP vs future

**Ships first**
- {{non-empty list of what the first version includes}}

**Deferred**
- {{non-empty list of what is planned but comes later}}

## Out of scope

<!-- Distinct from Deferred: deferred means later, out of scope means not this feature at all. Must be non-empty (completion.out_of_scope). -->

- {{things this feature will never do, as the user stated them}}

## Success measure

{{At least one objectively checkable signal that the feature is succeeding. Avoid "users are happy"; prefer countable or observable statements.}}
