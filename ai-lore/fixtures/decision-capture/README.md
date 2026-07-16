# Decision capture golden-transcript fixtures

This directory is the acceptance floor for the capture routine (the inline
instruction block duplicated into `skills/architect/SKILL.md` and
`skills/plan-waves/SKILL.md`). The routine is LLM-driven and interactive, so
it cannot be re-run deterministically in a shell check. Instead this set
pairs recorded design conversations with the decisions a correct run of the
routine should (and should not) capture from them, plus a validator that
checks the reference material itself is well-formed and internally
consistent.

## Layout

- `transcript-1.md`, `transcript-2.md`, `transcript-3.md`: small recorded
  design conversations, each ending in a delimited manifest block:

  ```
  <!-- MANIFEST-START -->
  CAPTURED id=adr-use-sse-not-websockets choice="..."
  SKIPPED id=some-slug choice="..."
  <!-- MANIFEST-END -->
  ```

  `CAPTURED` lines declare a choice the routine's materiality filter should
  capture; `SKIPPED` lines declare a choice it should not. Each `CAPTURED`
  entry's `id` names a file under `expected/<transcript>/`.

- `expected/transcript-1/`, `expected/transcript-2/`, `expected/transcript-3/`:
  the MADR decision files a correct capture run against the matching
  transcript should produce.

Coverage:

- **Transcript 1** (must-capture): a clear material decision with a real
  alternative, a lasting constraint, and a non-obvious rationale (modeled on
  the worked positive in `architecture/api.md`, "use SSE not websockets").
  One expected decision.
- **Transcript 2** (must-skip plus must-capture): an obvious naming choice
  that must be skipped (modeled on the worked negative, "name the file
  notifications.ts"), alongside a material decision that must be captured.
  One expected decision; the obvious choice is declared `SKIPPED` in the
  manifest with no matching file.
- **Transcript 3** (supersession): a decision that reverses a prior
  recall-surfaced choice. The expected decision carries a non-empty
  `supersedes`.

## Running the gate

From the `ai-lore/` plugin directory:

```
node scripts/check-capture-fixtures.js
```

The script does two objective jobs, neither of which re-runs the LLM
routine:

1. Validates every expected decision file under `expected/` is a
   well-formed decision node: frontmatter parses and has `id`, `title`,
   `date`, `stage`, `affects_paths`; the body has the three MADR headings
   `## Context`, `## Decision`, `## Consequences`.
2. Validates every transcript's manifest is internally consistent: each
   `CAPTURED` entry has exactly one matching file under
   `expected/<transcript>/<id>.md`, and each `SKIPPED` entry has none.

It exits 0 and prints a one-line summary when everything is valid and
consistent. It exits non-zero with a specific stderr message on the first
problem found (a missing or malformed expected file, a manifest entry with
no matching file, an orphan expected file with no manifest entry, or an
unparseable manifest line).

## Manual comparison

The gate cannot verify that the capture routine itself makes the right
call, only that the reference material is trustworthy. To exercise the
routine:

1. Open one of the transcripts and, in a session running the architect or
   plan-waves skill, drive the capture routine's materiality filter and
   drafting steps against the conversation as if it had just happened.
2. Compare the resulting draft decision(s) against the matching
   `expected/<transcript>/` file(s):
   - Same choices captured, same choices skipped, matching the manifest.
   - Frontmatter `stage` and `affects_paths` are plausible for the
     conversation.
   - The MADR body's `## Context`, `## Decision`, and `## Consequences`
     reflect the conversation's already-articulated material rather than
     invented detail.
   - For transcript 3, confirm the draft's `supersedes` references the
     prior decision id named in the conversation.
3. Minor wording differences are expected (the routine drafts prose, it
   does not copy the fixture verbatim); flag a mismatch only when a choice
   is captured/skipped incorrectly, a required field is missing, or the
   MADR misrepresents what was actually decided.
