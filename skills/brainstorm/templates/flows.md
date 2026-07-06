# Flows: {{title}}

## Surfaces

<!-- Where the feature lives: every screen, menu, email, notification, or command where the user encounters it. Flows below reference surfaces by name. Every surface needs its empty or first-run state stated; "n/a" must be earned, not assumed. -->

| Surface | Type | Role in the feature | Empty / first-run state |
|---|---|---|---|
| {{name}} | {{screen, email, CLI, notification, ...}} | {{what the user does here}} | {{what a new or empty view shows}} |

<!-- State diagram: include a mermaid `stateDiagram-v2` only if the feature has 3 or more states. Max 12 nodes. -->

## Flow 1: {{happy path name}}

<!-- Per flow: a mermaid `sequenceDiagram` if the flow has 3 or more actor/system exchanges (max 6 participants, 10 messages; split larger flows by subflow, each with a one-line caption); otherwise a numbered step list. A flow counts as covered (completion.happy_path_covered / failure_path_covered) only with a diagram or numbered steps, not a paragraph. -->

{{diagram or numbered step list}}

{{Prose fills in only what the diagram cannot show: error messages, data formats, edge conditions. Max 10 lines per flow.}}

## Flow 2: {{failure path name}}

<!-- At least one failure path is required: what the user sees when it goes wrong and how they recover. Same diagram rules as above. -->

{{diagram or numbered step list}}

{{Prose, max 10 lines.}}
