---
name: ail-review
description: Review the code changes produced by a completed ail-build-waves run. Fans out parallel agents across four dimensions (correctness, security, code quality, test coverage), writes a findings report to the plan directory, and prints an inline summary. Invoke after a build and before cleanup, or independently on any completed plan. e.g. "ail-review", "ail-review the unified-editor plan", "/ail-review".
---

# ail-review

> **Recommended model:** any. The orchestration is mechanical; the analysis runs in sonnet sub-agents.

Review the code changes from an `ail-build-waves` run. Fans out four parallel dimension agents (correctness, security, quality, test coverage) via the Workflow tool, synthesizes findings, and writes a consolidated report.

Invoking this skill is the explicit opt-in to use the **Workflow tool** for orchestration.

---

## 0. Read config and registry

- Read `.ai-lore/config.yaml` for `test_command`.
- Read `.ai-lore/runs.yaml` if present. Each run records `slug`, `status`, `worktree`, `branch`, `base_branch`, and optionally `review_status` and `review_file`.

---

## 1. Select the plan

- **If the user named a plan** (slug or path), use it. Skip the rest of this step.
- **Otherwise**, scan `runs.yaml` for entries with `status: complete` (runs that have finished building). List them with slug, branch, and whether they have already been reviewed (`review_status: complete`). Ask which to review.
  - If a plan was already reviewed, note "(already reviewed)" and confirm re-review before proceeding.
- If no complete runs exist, report this and suggest `ail-build-waves` to finish a build first.

---

## 2. Establish the diff scope

Determine the worktree path and branch from the registry entry:

- `worktree_path`: the run's `worktree` field (use the project root if the value is `"."`).
- `base_branch`: the run's `base_branch`.
- `branch`: the run's `branch` (if worktree is `"."`, use the current branch or the branch recorded in the registry).

Get the list of changed files:

```bash
git -C <worktree_path> diff --name-only <base_branch>..<branch>
```

If `worktree_path` is `"."`, use `git diff --name-only <base_branch>..<branch>` from the project root.

If no files are returned, report "No files changed between `<base_branch>` and `<branch>` -- nothing to review." and stop.

Locate the project root (`git rev-parse --show-toplevel` from the worktree) and the plan directory (`.ai-lore/plans/<slug>/`).

---

## 3. Fan out dimension agents (Workflow)

Execute the bundled workflow script. Pass `args` as the context object described below.

**Find the plugin root:** This skill file is at `<plugin_root>/skills/review/SKILL.md`. Strip the trailing `/skills/review/SKILL.md` from this file's absolute path to get `<plugin_root>`.

Call `Workflow({ scriptPath: '<plugin_root>/workflows/review-dimensions.js', args: { ... } })` with:

```json
{
  "worktree_path": "<absolute path>",
  "base_branch": "<base_branch>",
  "branch": "<plan branch>",
  "files_changed": ["<relative/path/a.ts>", "..."],
  "test_command": "<from config, or empty string>",
  "project_root": "<absolute path to repo root>",
  "plan_dir": "<absolute path to .ai-lore/plans/<slug>>/"
}
```

Capture the result array as `dimension_results`. Each element is a `{ dimension, findings, summary }` object.

---

## 4. Synthesize findings

From `dimension_results`, aggregate:

- `all_findings`: flat list of all findings across dimensions, preserving their `dimension` field.
- `blocking_count`: total findings where `severity == "blocking"`.
- `advisory_count`: total findings where `severity == "advisory"`.
- `by_dimension`: map from dimension id to its findings and summary.

Sort `all_findings`: blocking before advisory, then alphabetically by file.

---

## 5. Write review.md

Write `.ai-lore/plans/<slug>/review.md` with this format (no em dashes; use commas, semicolons, parentheses, or periods):

```markdown
---
plan: <slug>
branch: <branch>
base_branch: <base_branch>
files_reviewed: <count>
findings_blocking: <blocking_count>
findings_advisory: <advisory_count>
---

# Code Review: <plan title>

Branch `<branch>` vs `<base_branch>` -- <files_reviewed> files reviewed.

## Summary

| Dimension         | Blocking | Advisory |
|-------------------|----------|----------|
| Correctness       | N        | N        |
| Security          | N        | N        |
| Code Quality      | N        | N        |
| Test Coverage     | N        | N        |
| **Total**         | **N**    | **N**    |

## Findings

<for each dimension in order: correctness, security, quality, test_coverage>
### <Dimension Name>

<dimension summary line>

<for each finding in this dimension, sorted blocking-first>
**[<severity>] `<file>`<if line: :<line>>** -- <type>
<description>
Fix: <suggestion>

<end for each finding>
<if no findings: "(none)">

<end for each dimension>
```

---

## 6. Print inline summary

Print a compact summary to the session:

```
Code review complete for <slug> (<files_reviewed> files, <blocking_count> blocking, <advisory_count> advisory findings).

| Dimension         | Blocking | Advisory |
|-------------------|----------|----------|
| Correctness       | N        | N        |
| Security          | N        | N        |
| Code Quality      | N        | N        |
| Test Coverage     | N        | N        |

<If blocking_count > 0:>
Blocking findings:
- [<dimension>] <file><:line>: <description>
<...one line per blocking finding>

Full report written to .ai-lore/plans/<slug>/review.md
```

Advisory findings are written to the report but not echoed individually to the session (they are lower priority and the report is the reference).

---

## 7. Update runs.yaml

Write back to `.ai-lore/runs.yaml`: for this run's entry, set:

```yaml
review_status: complete
review_file: .ai-lore/plans/<slug>/review.md
```

---

## 8. Offer to proceed to cleanup

Ask the user whether to proceed to cleanup (open a PR or merge the branch):

- If `blocking_count == 0`: "No blocking findings. Proceed to cleanup (open PR or merge)?"
- If `blocking_count > 0`: "There are <N> blocking findings (all advisory to review -- this skill reports only, it does not block shipping). Proceed to cleanup anyway?"

If the user agrees, invoke `ail-cleanup` for this plan. If not, leave the branch/worktree in place; the registry entry is what `ail-cleanup` will pick up later.

---

## Principles

- **Report only; never block.** All findings are informational. The skill surfaces issues but does not gate cleanup. The user decides whether to act on findings before shipping.
- **Workers return data; this skill writes files.** Dimension agents return structured results only. All file writes happen here.
- **Four dimensions always run in parallel.** The Workflow fan-out maximizes speed; each dimension is independent.
- **test_coverage skips gracefully.** If `test_command` is absent or empty, the coverage agent returns no findings and notes why.
- **review.md lives in .ai-lore/plans/<slug>/**, which is gitignored. It is per-clone review state, not committed.
- **No em dashes** in any file written by this skill (commas, semicolons, parentheses, periods instead).
