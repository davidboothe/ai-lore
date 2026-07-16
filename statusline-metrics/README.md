# statusline-metrics

A Claude Code plugin that puts live session metrics at the bottom of the CLI:

```
[████████░░] 82% · 164k/200k   ⎇ main*   $0.42   Opus · my-repo · +156/-23
```

- **Context bar** — how much of the context window is in use (parsed from the session
  transcript; understands both 200k and 1M-context models).
- **Git branch** — current branch, with a `*` when the tree is dirty.
- **Spend** — session cost in USD.
- **Model · dir · lines** — model name, working directory, and lines added/removed.

It ships a single zero-dependency Node script (`scripts/statusline.js`) that reads
Claude Code's status line JSON on stdin and prints one line. It is **fail-safe**: a
missing field drops that segment, and any error prints a minimal fallback rather than
breaking your CLI.

## Requirements

- Node.js (any recent version) on your `PATH`.

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

The `/statusline-metrics` skill asks for scope (your user settings, the default, vs the
current project) and a visual style, then writes the `statusLine` entry into the chosen
`settings.json`. It backs up any status line you already had.

## Customize

```
/statusline-metrics customize
```

Change the style (`emoji`, `ascii`, `powerline`) or which segments show and in what
order.

## Uninstall / disable

```
/statusline-metrics disable
```

This removes the `statusLine` entry **only if it is ours** (it never clobbers a custom
status line you wrote yourself) and restores any status line it replaced at install time.

## Updating

Plugins install to a path keyed by the marketplace name, not the version, so
`/plugin update` pulls the new renderer into the same location on disk. The `statusLine`
entry in your `settings.json` keeps pointing at that path and runs the updated code on
the next render — **no action needed** for an ordinary update.

Re-run `/statusline-metrics setup` only if:

- the bar goes blank after you removed and re-added the marketplace (the install path
  moved), or
- a release adds a new style/segment you want — existing settings are sticky, so run
  `/statusline-metrics customize` to opt in.

## Manual setup (without the skill)

Add this to `~/.claude/settings.json` (user-wide) or `<project>/.claude/settings.json`,
using the absolute path to this plugin:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/statusline-metrics/scripts/statusline.js\" --style=emoji",
    "padding": 0
  }
}
```

Flags:

- `--style=emoji|ascii|powerline` — visual style (default `emoji`).
- `--segments=context,branch,cost,meta` — which segments to show, in order.

To remove it manually, delete the `statusLine` block.

## Styles

| Style | Notes |
|---|---|
| `emoji` | Emoji + Unicode block bar. Renders in most modern terminals. Default. |
| `ascii` | `[####....]`, `br:main`, no special glyphs. Safe in any terminal/font. |
| `powerline` | Nerd-Font segment glyphs. Requires a Nerd Font installed. |

Set `NO_COLOR=1` in your environment to disable ANSI colors.

## How the context bar is computed

The status line payload does not carry a token count directly, so the script reads the
session transcript (`transcript_path` in the payload), takes the last assistant message's
`usage`, and sums `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
to approximate the tokens currently in context. The window is 200k, or 1M when the model
id indicates a 1M-context model (or the payload's `exceeds_200k_tokens` is set).
