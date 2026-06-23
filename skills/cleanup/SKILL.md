---
name: cleanup
description: Close out a finished build-waves run. Targets a completed plan's branch/worktree from the registry, then either opens a pull request (if the repo has a remote) or merges the branch into the current branch and tears down the worktree. Detects the remote host (Azure DevOps via the connected MCP server, GitHub via gh, others via a manual fallback), sets up .ai-lore/ado.yaml on first ADO use, and confirms before any merge into a non-main branch. Invoke after a build to ship or land the work, e.g. "cleanup the unified-editor plan", "finish up and open a PR", "/cleanup".
---

# Cleanup

> **Recommended model:** any. This is mechanical git and PR plumbing with explicit confirmations, not heavy reasoning.

Take a finished `build-waves` run to its destination: a pull request, or a local merge plus teardown. Operates on the plan's branch and worktree recorded in `.ai-lore/runs.yaml`.

## 0. Read config and the registry

- Read `.ai-lore/config.yaml` for `package_manager` and `worktrees.dir`.
- Read `.ai-lore/runs.yaml`. Each run records `slug`, `status`, `worktree`, `branch`, `base_branch`, `lock`, and (after this skill) `pr_url`.

## 1. Select the run

- **If the user named a plan**, use its registry entry.
- **Otherwise**, list runs that are `complete` (or `blocked` but the user wants to ship what landed) and still have a live `branch`/`worktree` and no `pr_url`. Show slug, branch, base branch, and progress. Ask which. If none qualify, say so.
- **If the run's `worktree` is `"."`** (the plan built directly in the main checkout, no dedicated branch): there is nothing to merge or tear down. Offer only the PR-of-current-branch path, or stop. Skip the worktree/branch steps below.

## 2. Pre-flight: make sure the work is committed

`build-waves` commits once per wave, so the branch should be clean. Verify: check the worktree for uncommitted changes (`git -C <worktree> status --porcelain`). If anything is uncommitted, show it and ask whether to commit it (one commit) or stop so the user can look. Never PR or merge a dirty tree silently.

## 3. Detect the remote and choose a path

Run `git remote -v`. Then ask the user which path they want (only offer PR if a remote exists):

- **No remote**: only the **merge** path is available.
- **Remote present**: offer **PR** or **merge**. Determine the host from the remote URL:
  - `dev.azure.com` or `*.visualstudio.com` -> **Azure DevOps** (use the connected `azure-devops` MCP server).
  - `github.com` -> **GitHub** (use the `gh` CLI).
  - anything else -> **manual fallback** (push the branch, print the compare/PR URL, let the user finish).

## 4. PR path

1. Push the branch to the remote (`git -C <worktree> push -u origin <branch>`).
2. Build the PR title and body from the plan: title from `plan.md`'s title, body from its goal plus a short per-wave summary of what landed.
3. Open the PR against the **target branch**: the run's `base_branch`, falling back to `main`/`master` (ADO config's `default_target_branch` overrides for ADO).

   - **Azure DevOps**: ensure `.ai-lore/ado.yaml` exists. If missing, run setup first (step 6), then create the PR with the `azure-devops` MCP (`repo_create_pull_request`) using `organization`/`project`/`repository` from `ado.yaml`. Apply `reviewers`, `draft`, and `link_work_items` if configured.
   - **GitHub**: `gh pr create --base <target> --head <branch> --title "..." --body "..."` (add `--draft` / `--reviewer` as desired).
   - **Manual fallback**: confirm the branch is pushed and print the host's compare URL for the user to open the PR by hand.
4. Record `pr_url` and set the run `status: submitted` in `runs.yaml`; clear its `lock`. The remote branch stays until the PR merges. Offer to remove the **local** worktree now (`git worktree remove <worktree>`); leave the local branch alone.

## 5. Merge path

The merge target is the branch currently checked out in the main repo.

1. If the current branch is **not** `main` or `master`, confirm explicitly before merging (merging a plan into a feature branch is a deliberate act).
2. Merge: `git merge <branch>` from the main checkout.
   - **On conflict**: run `git merge --abort`, report exactly which files conflicted, and stop. Do not remove the worktree or branch; leave everything so the user can resolve.
3. **On a clean merge**, tear down in this forced order (a branch checked out in a worktree cannot be deleted): remove the worktree (`git worktree remove <worktree>`), then delete the branch (`git branch -d <branch>`).
4. Set the run `status: merged` in `runs.yaml` and clear its `lock`. Report the merge commit and what was torn down.

## 6. ADO setup (first PR to an Azure DevOps remote)

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
- **No em dashes** in PR titles/bodies or config written here (commas, periods, parentheses, semicolons).
