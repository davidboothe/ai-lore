# statusline-metrics

A Claude Code plugin that puts live session metrics at the bottom of the CLI — the same
deterministic line on every machine:

```
[Opus 4.8] ai-lore (main)  [███░░░░░░░] 30% 60k/200k  cache-read ⚡ 45k  +156 -23  ⏱ 12m  $0.42
```

Segments, left to right:

- **`[model]`** — the active model's display name.
- **`repo (branch)`** — git repo name and current branch (omitted outside a git work tree).
- **Context bar** — how much of the context window is in use, as a 10-cell bar + percent +
  `used/max` tokens. Green under 60%, yellow 60–79%, red at 80%+.
- **`cache-read ⚡`** — tokens served from the prompt cache this turn.
- **`+A -R`** — lines added / removed this session.
- **`⏱`** — session duration.
- **`$`** — session cost in USD.

It ships a single **zero-dependency Node script** (`scripts/statusline.js`) that reads Claude
Code's status line JSON on stdin and prints one line. Because it is plain Node, it renders
**identically on macOS, Linux, and Windows** — no `jq`, no shell, no per-machine setup choices.
It is **fail-safe**: a missing field drops that segment, and any error prints a minimal fallback
rather than breaking your CLI.

## Requirements

- Node.js (any recent version) on your `PATH`.
- `git` is optional — it only adds the `repo (branch)` segment.

## Install

From the ai-lore marketplace:

```
/plugin marketplace add dboothe/ai-lore
/plugin install statusline-metrics@ai-lore
```

Then wire it into your status line:

```
/statusline-metrics setup
```

This runs the deterministic installer (`scripts/setup.js`), which writes the `statusLine` entry
into your `~/.claude/settings.json` — the **same entry on every machine**, no questions asked. It
backs up any status line you already had. To scope it to the current project only, ask for
`/statusline-metrics setup` "for this project" (it writes `<project>/.claude/settings.json`).

## Uninstall / disable

```
/statusline-metrics disable
```

This removes the `statusLine` entry **only if it is ours** (it never clobbers a custom status line
you wrote yourself) and restores any status line it replaced at install time.

## Updating

The installer points `settings.json` at the plugin's **version-independent** renderer path — the
marketplace checkout, which git-pulls new commits on `/plugin update` (or automatically when the
marketplace has `autoUpdate` on). So a new look or fix runs on the next render with **no action
needed**; the version-pinned cache path (which moves every release) is deliberately avoided. Re-run
`/statusline-metrics setup` only if the install path moves — i.e. you removed and re-added the
marketplace under a different name. (If setup ever had to fall back to a version-pinned path, it
prints a note telling you exactly this.)

## Manual setup (without the skill)

Run the installer directly — it self-locates the renderer and writes the canonical entry:

```
node "/absolute/path/to/statusline-metrics/scripts/setup.js"            # user settings
node "/absolute/path/to/statusline-metrics/scripts/setup.js" --scope=project
node "/absolute/path/to/statusline-metrics/scripts/setup.js" --uninstall
```

Or, if you prefer to edit `settings.json` yourself, add:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/statusline-metrics/scripts/statusline.js\"",
    "padding": 0
  }
}
```

Set `NO_COLOR=1` in your environment to disable ANSI colors.

## How it works

The status line payload carries a first-class `context_window` object, so the renderer reads
`context_window.used_percentage`, `context_window.total_input_tokens`,
`context_window.context_window_size`, and `context_window.current_usage.cache_read_input_tokens`
directly — no transcript parsing. Cost, duration, and lines come from the payload's `cost` object;
model from `model.display_name`; repo/branch from `git` against `workspace.current_dir`.

`scripts/statusline-command.sh` is the human-readable **design reference** (a bash + `jq`
implementation of the exact same look). `scripts/statusline.js` reproduces its output
byte-for-byte; a parity check keeps them in sync:

```
P='{"model":{"display_name":"Opus 4.8"},"workspace":{"current_dir":"'$PWD'"},
    "context_window":{"used_percentage":30,"total_input_tokens":60000,"context_window_size":200000,
    "current_usage":{"cache_read_input_tokens":45000}},
    "cost":{"total_cost_usd":0.42,"total_duration_ms":720000,"total_lines_added":156,"total_lines_removed":23}}'
diff <(echo "$P" | node scripts/statusline.js) <(echo "$P" | bash scripts/statusline-command.sh)
```
