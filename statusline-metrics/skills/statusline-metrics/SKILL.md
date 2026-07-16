---
name: statusline-metrics
description: Install, customize, or remove the statusline-metrics status line for Claude Code. Use when the user wants to enable a status line showing context-window usage, session spend, git branch, and model/dir/lines; change its style or segments; or cleanly uninstall it. Triggers include "set up the status line", "show context/cost/branch at the bottom", "change status line style", "remove/disable the status line".
---

# statusline-metrics

Wire the `statusline-metrics` renderer into the user's Claude Code `settings.json`, or
remove it. The renderer is `scripts/statusline.js` in this plugin; it reads Claude
Code's status line JSON on stdin and prints one line (context-window bar, spend, git
branch, model / dir / lines). This skill is the only thing that edits `settings.json` --
so install and uninstall are both explicit and reversible.

## Step 0 -- resolve paths

- **Script path**: this file lives at `<plugin_root>/skills/statusline-metrics/SKILL.md`.
  Strip the trailing `/skills/statusline-metrics/SKILL.md` to get `<plugin_root>`, then
  the renderer is `<plugin_root>/scripts/statusline.js`. Use the **absolute** path.
  (An absolute path is used rather than `${CLAUDE_PLUGIN_ROOT}` because a user-level
  status line command does not reliably have that env var set. Plugins install to a
  version-independent path keyed by marketplace name, so ordinary `/plugin update`s pull
  new code into the *same* location -- the status line picks it up with no action needed.
  Only if the install location actually moves -- the marketplace is removed and re-added
  under a different name, or the plugin's `source` path is renamed -- does the bar go
  blank; the fix is to re-run setup, which re-resolves and rewrites the path.)
- Confirm Node is available: `node --version`. If it is missing, tell the user the
  status line needs Node.js and stop.

## Step 1 -- pick the action

Read the user's argument:
- `setup` / `enable` / `install` (or no argument on a fresh machine) -> **Install**.
- `customize` / `status` / `change` -> **Customize**.
- `disable` / `uninstall` / `remove` / `off` -> **Uninstall**.

With no argument, first read both candidate settings files (below) to detect whether our
status line is already installed, then offer the matching action.

## Step 2 -- choose scope

Ask (default **user**):
- **user** -> `~/.claude/settings.json` (applies to every project). Recommended.
- **project** -> `<cwd>/.claude/settings.json` (this repo only; committed if the repo
  tracks it).

Everything below operates on the chosen `<settings>` file. If it does not exist, treat
its content as `{}` and create it on write. Settings files are strict JSON (no comments);
parse, mutate the `statusLine` key only, and write back with 2-space indentation,
preserving all other keys.

## Install

1. Ask for **style** (default `emoji`):
   - `emoji` -- `[████████░░] 82% · 164k/200k   ⎇ main*   $0.42   Opus · repo · +156/-23`
   - `ascii` -- plain terminals / no special glyphs: `[########..] ... | br:main* | $0.42`
   - `powerline` -- Nerd-Font segment glyphs (needs a Nerd Font installed).
   Optionally ask which **segments** to show / in what order (default
   `context,branch,cost,meta`); pass as `--segments=...` only if the user customizes it.
2. Read `<settings>`. If a `statusLine` key already exists **and its `command` does not
   reference `statusline.js`**, it is the user's own status line: save its current value
   verbatim to `<settings-dir>/.statusline-metrics.backup.json` and warn that you are
   replacing it (uninstall will restore it).
3. Set:
   ```json
   "statusLine": {
     "type": "command",
     "command": "node \"<abs>/scripts/statusline.js\" --style=<style>",
     "padding": 0
   }
   ```
   (append ` --segments=<list>` inside the command string only if customized). Quote the
   script path so spaces in it are safe.
4. Write `<settings>`. Tell the user it is active (a new render happens within ~1s; a
   fresh prompt shows it immediately) and how to change or remove it.

## Customize

Read `<settings>`, show the current `statusLine.command` (style + segments parsed from
its flags). Let the user change style, segment set/order, or scope, then re-run the
Install write with the new flags. Moving scope means removing the key from the old
`<settings>` and writing it to the new one.

## Uninstall

1. Read `<settings>`. If there is no `statusLine` key, report nothing to remove.
2. If `statusLine.command` **does not** reference `statusline.js`, it is not ours -- do
   **not** touch it; tell the user their custom status line was left untouched.
3. If it is ours: if `<settings-dir>/.statusline-metrics.backup.json` exists, restore
   that saved value into `statusLine` and delete the backup file; otherwise delete the
   `statusLine` key entirely.
4. Write `<settings>`. Confirm the bar is gone (and any prior status line restored).

## Notes

- Never write anything except the `statusLine` key (and the sidecar backup file). Leave
  all other settings byte-for-byte.
- The renderer is fail-safe: bad input or a missing field prints a minimal line rather
  than breaking the CLI, so a partially-populated payload is never fatal.
