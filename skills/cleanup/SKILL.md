---
name: ail-cleanup
description: Close out a finished ail-build-waves run. Targets a completed plan's branch/worktree from the registry, then either opens a pull request (if the repo has a remote) or merges the branch into the current branch and tears down the worktree. Detects the remote host (Azure DevOps via the connected MCP server, GitHub via gh, others via a manual fallback), sets up .ai-lore/ado.yaml on first ADO use, and confirms before any merge into a non-main branch. Invoke after a build to ship or land the work, e.g. "ail-cleanup the unified-editor plan", "finish up and open a PR", "/ail-cleanup".
---

# ail-cleanup

> **Recommended model:** any. This is mechanical git and PR plumbing with explicit confirmations, not heavy reasoning.

Take a finished `ail-build-waves` run to its destination: a pull request, or a local merge plus teardown. Operates on the plan's branch and worktree recorded in `.ai-lore/runs.yaml`.

## 0. Read config and the registry

- Read `.ai-lore/config.yaml` for `package_manager` and `worktrees.dir`.
- Read `.ai-lore/runs.yaml`. Each run records `slug`, `status`, `worktree`, `branch`, `base_branch`, `lock`, and (after this skill) `pr_url`.

## 1. Select the run

- **If the user named a plan**, use its registry entry.
- **Otherwise**, list runs that are `complete` (or `blocked` but the user wants to ship what landed) and still have a live `branch`/`worktree` and no `pr_url`, plus any runs that are `submitted` (a PR is already open). Show slug, branch, base branch, and progress (and `pr_url` for submitted runs). Ask which. If none qualify, say so.
- **If the run's `worktree` is `"."`** (the plan built directly in the main checkout, no dedicated branch): there is nothing to merge or tear down. Offer only the PR-of-current-branch path, or stop. Skip the worktree/branch steps below.
- **If the selected run has status `submitted` and a `pr_url`**, take the "check on a submitted PR" path instead of the normal promote/PR/merge flow: check whether the PR has merged (GitHub: `gh pr view <pr_url> --json state,mergedAt`; Azure DevOps: the `azure-devops` MCP server's PR status; anything else: ask the user directly). If merged, tear down in the same forced order as the merge path (remove the worktree with `git worktree remove <worktree>`, then delete the branch with `git branch -d <branch>`), set the run `status: merged` in `runs.yaml`, and clear its `lock`. If not merged, report the current PR status and stop; do not touch the worktree or branch.

## 2. Pre-flight: make sure the work is committed

`ail-build-waves` commits once per wave, so the branch should be clean. Verify: check the worktree for uncommitted changes (`git -C <worktree> status --porcelain`). If anything is uncommitted, show it and ask whether to commit it (one commit) or stop so the user can look. Never PR or merge a dirty tree silently.

## 3. Promote decisions

**When:** after the build's code is committed on the branch (confirmed in step 2), before push (step 5) or merge (step 6). This runs regardless of which path the user later picks, because promoted decisions are staged into the same commit as the code.

**Where:** the decision SOURCE files at `.ai-lore/plans/<slug>/decisions/` are gitignored and per-clone, so they are read from the **main checkout** (they are not present in the plan's worktree). Every WRITE in this step, the `build-links.js` invocation, and the resulting commit happen **inside the plan's worktree** (the run's `worktree` path from the registry; the project root when `worktree` is `"."`), so the promoted `.ai-lore-docs/decisions/*.md` files land on the plan branch together with the code.

Skip this step entirely if `.ai-lore/plans/<slug>/decisions/` does not exist or is empty (no decisions were captured for this plan).

1. **Secret/PII screening (per decision, fail-safe).** `ail-document`'s existing denylist (`skills/document/SKILL.md`) is a FILENAME glob list that excludes files from being read; it is not a content scanner and is not reused here. `ail-cleanup` owns its own inline content secret/PII denylist, scanned against each decision's MADR body and frontmatter:
   - Secret shapes: API keys and tokens (`api[_-]?key`, `secret`, `token` adjacent to a long alphanumeric value), AWS-style access keys (`AKIA[0-9A-Z]{16}`), private-key headers (`-----BEGIN ... PRIVATE KEY-----`), bearer tokens (`Bearer [A-Za-z0-9._-]{20,}`), and high-entropy assignments (`<name> = <long random-looking string>`).
   - Prose PII: email addresses, phone numbers, and similar personally identifying strings.
   - For each match, show the exact matched substring (not the whole file) and ask the user to acknowledge, redact, or skip. **Default on no explicit response is skip**: the flagged decision is excluded from this promotion and stays pending in `.ai-lore/plans/<slug>/decisions/` (left in place, not deleted, not committed). One flagged decision never blocks the rest of the batch, and this default is never rubber-stamped by an orchestrating agent.
   - False positives: maintain a repo-local allowlist (e.g. `.ai-lore/decisions-allowlist.txt`, one substring or pattern per line) that suppresses a specific match; check it before showing a flag.

2. **Prune/amend.** For each decision that passed screening (or was explicitly acknowledged), show its full MADR next to the current wave's `files_changed`. Ask the user to prune any decision the build did not honor or that no longer reflects the shipped design. **Default is promote-all**: nothing is pruned unless the user says so.

3. **Write.** For the pruned set, perform an atomic (temp-then-rename) deterministic full rewrite to `.ai-lore-docs/decisions/<adr-id>.md`, touching the SOURCE region only (`id`, `title`, `date`, `stage`, `affects_paths`, `supersedes`, and the MADR body). **Write every list-valued key (`affects_paths`, `supersedes`) in flow style on one line (`[a, b, c]`, or `[]` when empty); never block style (a bare `key:` followed by indented `- item` lines).** This matches the flow-style-only convention module and concept docs follow and is the canonical form `build-links.js` and `--recall` expect; a block-style list is a load-bearing edge that silently fails to link in older linker versions. If a target file already exists (a re-promotion or a superseding edit), its managed keys (`superseded_by`, `status`) and managed sections are preserved untouched by this surgical source-region write, never blindly overwritten. **Collision guard:** because decision ids are topic slugs and no longer embed the unique plan slug, before writing check whether the target already holds a *different* decision (its source region differs from what you are about to write, i.e. it is not a re-promotion of this same decision). If so, append the smallest free `-N` (starting at 2) and use that as the final id and filename, rewriting the `id` in the gitignored source file under `.ai-lore/plans/<slug>/decisions/` too so re-runs are stable; a target whose source region matches is overwritten in place as before. This runs against the base refreshed in step 4, so a topic slug already merged by another plan is detected rather than overwritten. Clamp every `affects_paths` entry shown to the user to the repo root.

4. **Refresh + link.** Before rendering, refresh the base: run `git -C <worktree> fetch`. If the target branch has advanced upstream, **merge** the updated base into the plan branch (`git -C <worktree> merge <remote>/<base_branch>`); never rebase the plan branch without explicit user confirmation, since rebasing here would rewrite the wave commits mid-cleanup. **On merge conflict**, stop and hand back to the user exactly like the step 6 merge-conflict rule (report exactly which files conflicted; do not remove the worktree or branch; leave everything so the user can resolve). Once the base is refreshed (or found already up to date), run `build-links.js` against the **worktree's** `.ai-lore-docs`, not the main checkout's:

   ```bash
   node <plugin_root>/scripts/build-links.js <worktree>/.ai-lore-docs
   ```

   (equivalently, `cd` into the worktree first and run `node <plugin_root>/scripts/build-links.js .ai-lore-docs`). This derives `superseded_by`/`status`, renders the aggregate `.ai-lore-docs/decisions.md` log, and injects `## Decisions` sections into affected module/concept docs, all inside the worktree. `build-links.js` is the gate for this step: **if it exits non-zero, ABORT** the push/merge, surface its stderr verbatim, and leave the staged source files in place for a safe re-run. Never ship code with a broken graph.

5. **Idempotency.** Store no `decisions_promoted` marker anywhere (not in `runs.yaml`, not in the plan folder). Promotion is a deterministic rewrite, so re-running it (for example, after a failed push) reproduces identical files and is always safe.

6. **Non-interactive mode.** Pass `--non-interactive` (or `non_interactive: true`) when invoking `ail-cleanup` to run promotion as promote-all with no prompts. In this mode, any secret/PII flag **fails hard**: stop promotion immediately, report the flagged decision and matched substring, and do not push or merge. This lets the promote -> link -> commit chain run as a scripted regression check without a human at the keyboard.

7. **Record for the PR body.** Collect the titles and ids of every decision actually promoted (after pruning). Pass them to `ai-lore:pr-body-writer` (used in step 5, PR path) so it can add a "Decisions recorded: <id> <title>, ..." line to the PR body; omit the line if nothing was promoted.

Commit the staged `.ai-lore-docs/decisions/` files (plus any files the linker rewrote) into the branch, alongside or immediately after the build's code commit, so decisions ship together with the code they document.

## 4. Detect the remote and choose a path

Run `git remote -v`. Then ask the user which path they want (only offer PR if a remote exists):

- **No remote**: only the **merge** path is available.
- **Remote present**: offer **PR** or **merge**. Determine the host from the remote URL:
  - `dev.azure.com` or `*.visualstudio.com` -> **Azure DevOps** (use the connected `azure-devops` MCP server).
  - `github.com` -> **GitHub** (use the `gh` CLI).
  - anything else -> **manual fallback** (push the branch, print the compare/PR URL, let the user finish).

## 5. PR path

1. Push the branch to the remote (`git -C <worktree> push -u origin <branch>`).
2. Check if `.ai-lore-docs/overview.md` exists. If it does, read it. Then invoke `ai-lore:pr-body-writer` with the plan title, goal, per-wave summaries, files changed, (if found) the overview content as `architecture_context`, and the titles/ids of any decisions promoted in step 3 (so it can add a "Decisions recorded: ..." line). Use the returned `title` and `body` for the PR.
3. Open the PR against the **target branch**: the run's `base_branch`, falling back to `main`/`master` (ADO config's `default_target_branch` overrides for ADO).

   - **Azure DevOps**: ensure `.ai-lore/ado.yaml` exists. If missing, run setup first (step 7), then create the PR with the `azure-devops` MCP (`repo_create_pull_request`) using `organization`/`project`/`repository` from `ado.yaml`. Apply `reviewers`, `draft`, and `link_work_items` if configured.
   - **GitHub**: `gh pr create --base <target> --head <branch> --title "..." --body "..."` (add `--draft` / `--reviewer` as desired).
   - **Manual fallback**: confirm the branch is pushed and print the host's compare URL for the user to open the PR by hand.
4. Record `pr_url` and set the run `status: submitted` in `runs.yaml`; clear its `lock`. The remote branch stays until the PR merges. Offer to remove the **local** worktree now (`git worktree remove <worktree>`); leave the local branch alone.

## 6. Merge path

The merge target is the branch currently checked out in the main repo.

1. If the current branch is **not** `main` or `master`, confirm explicitly before merging (merging a plan into a feature branch is a deliberate act).
2. Merge: `git merge <branch>` from the main checkout.
   - **On conflict**: run `git merge --abort`, report exactly which files conflicted, and stop. Do not remove the worktree or branch; leave everything so the user can resolve.
3. **On a clean merge**, tear down in this forced order (a branch checked out in a worktree cannot be deleted): remove the worktree (`git worktree remove <worktree>`), then delete the branch (`git branch -d <branch>`).
4. Set the run `status: merged` in `runs.yaml` and clear its `lock`. Report the merge commit and what was torn down.

## 7. ADO setup (first PR to an Azure DevOps remote)

If `.ai-lore/ado.yaml` is missing, create it from `templates/ado.yaml` before opening the PR:

- Infer `organization`/`project`/`repository` from the remote URL where possible; confirm with the user. You may use the MCP (`core_list_projects`, `repo_list_repos_by_project`) to let the user pick, and verify the chosen repo matches the git remote.
- Ask for the `default_target_branch` (default `main`) and any optional `reviewers` / `draft` / `link_work_items`.
- Write `ado.yaml`. Note: auth is the MCP server's job; never write a PAT into this file.

## Principles

- **Confirm anything outward-facing or destructive.** Pushing, opening a PR, merging into a non-default branch, removing a worktree, deleting a branch: each gets a confirmation unless the user already said to proceed.
- **Never auto-resolve a merge conflict.** Abort and hand it back.
- **Forced teardown order:** merge, then remove the worktree, then delete the branch.
- **The registry is the source of truth for what is shippable;** update `status`, `pr_url`, and `lock` as you go.
- **No PATs or secrets in `.ai-lore/`.** Auth belongs to the MCP server or `gh`.
- **The decision content denylist is owned here, not reused from `ail-document`.** `ail-document`'s denylist excludes files by name; it never scans content. Promotion's screening list is inline in this file.
- **A flagged decision defaults to skip, never to a rubber-stamp.** No response means the decision stays pending; the linker failing means the ship aborts.
