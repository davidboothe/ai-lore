---
name: statusline-metrics
description: Install or remove the statusline-metrics status line for Claude Code. Use when the user wants to enable the status line (context-window bar, spend, git branch/repo, model, cache-read, lines, duration) or cleanly uninstall it. Triggers include "set up the status line", "show context/cost/branch at the bottom", "remove/disable the status line".
---

# statusline-metrics

Wire the `statusline-metrics` status line into the user's Claude Code `settings.json`, or remove
it. Both actions are done by a **deterministic, non-interactive** installer,
`scripts/setup.js`, so the result is byte-identical on every machine -- there are no styles,
segments, or layout choices to make. Your job here is just to run that script; do **not**
hand-edit `settings.json` or ask the user to pick a look.

## Step 0 -- resolve paths and check Node

- This file lives at `<plugin_root>/skills/statusline-metrics/SKILL.md`. Strip the trailing
  `/skills/statusline-metrics/SKILL.md` to get `<plugin_root>`; the installer is
  `<plugin_root>/scripts/setup.js`. Use the **absolute** path when invoking it.
- Confirm Node is available: `node --version`. If it is missing, tell the user the status line
  needs Node.js and stop. (Node is the only requirement; `git` is optional -- it just adds the
  repo/branch segment.)

## Step 1 -- pick the action

Read the user's argument:
- `setup` / `enable` / `install` (or no argument on a fresh machine) -> **Install**.
- `disable` / `uninstall` / `remove` / `off` -> **Uninstall**.

With no argument, run `Install` (it is idempotent -- re-running just refreshes the entry).

## Install

Run the installer. Default scope is the user's settings (`~/.claude/settings.json`, applies to
every project); pass `--scope=project` **only** if the user explicitly asks for this repo only.

```
node "<plugin_root>/scripts/setup.js"
# or, this-project-only:
node "<plugin_root>/scripts/setup.js" --scope=project
```

The script writes only the `statusLine` key (all other settings preserved), points it at the
version-independent renderer path so ordinary `/plugin update`s keep working, and backs up any
status line the user already had. Relay its output. It renders on the next status-line update (a
fresh prompt shows it immediately).

## Uninstall

```
node "<plugin_root>/scripts/setup.js" --uninstall
# match the scope it was installed at, if project:
node "<plugin_root>/scripts/setup.js" --uninstall --scope=project
```

It removes the entry **only if it is ours** (it never clobbers a status line the user wrote
themselves) and restores any status line it replaced at install time. Relay its output.

## Notes

- The look is fixed and defined by `scripts/statusline.js` (the cross-platform renderer;
  `scripts/statusline-command.sh` is its bash design reference). To change the look, edit those
  scripts -- not `settings.json`.
- Set `NO_COLOR=1` in the environment to disable ANSI colors.
- The renderer is fail-safe: bad input or a missing field drops that segment rather than breaking
  the CLI, so a partially-populated payload is never fatal.
