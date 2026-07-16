# ai-lore

A Claude Code plugin **marketplace**. Add the marketplace once, then install whichever of the plugins below you want.

## Plugins

### ai-lore &nbsp;·&nbsp; [full docs →](ai-lore/README.md)

Plan, build, review, and ship work as **parallel waves of atomic tasks**. Ten skills driven by a single `/ai-lore` entry point: brainstorm → architect → plan → build (parallel, gated sub-agents) → review (four dimensions) → ship (PR or merge) → document (an interlinked, concept-first knowledge graph). Codebase-agnostic and config-driven; requires Node.js for its linker and HTML previews, and runs best on Opus.

**Just run `/ai-lore`** — the routing skill checks your config, reads the current state of your plans and builds, and asks what you want to do next, then hands off to the right step. You never have to remember the individual `/ail-*` skills (though you can call them directly when you want to).

```
/plugin install ai-lore@ai-lore
```

### statusline-metrics &nbsp;·&nbsp; [full docs →](statusline-metrics/README.md)

A live session status line for the Claude Code CLI: model, git repo/branch, a context-window progress bar, cache-read tokens, lines changed, session duration, and spend. One fixed, **deterministic** look rendered by a single zero-dependency Node script — identical on macOS, Linux, and Windows. Fail-safe, with a `/statusline-metrics` skill to install and cleanly uninstall it. Requires Node.js (git optional).

It renders a single line at the bottom of the CLI:

```
[Opus 4.8] ai-lore (main)  [███░░░░░░░] 30% 60k/200k  cache-read ⚡ 45k  +156 -23  ⏱ 12m  $0.42
```

After installing, run `/statusline-metrics setup` to wire it in — no styles or choices, the same entry on every machine.

```
/plugin install statusline-metrics@ai-lore
```

## Install

Claude Code installs plugins from a marketplace. Add this repository as a marketplace once, then run the per-plugin install commands above:

```
/plugin marketplace add dboothe/ai-lore
```

For local development, point the marketplace at a clone instead:

```
git clone https://github.com/dboothe/ai-lore.git
/plugin marketplace add /absolute/path/to/ai-lore
```

Changes to local files take effect after you reload Claude Code. Manage installed plugins with `/plugin`; each plugin's own README covers use, updates, removal, and requirements.

## Repository layout

```
.claude-plugin/marketplace.json   # marketplace index -> both plugins
ai-lore/                          # the ai-lore plugin (skills, agents, scripts, fixtures)
statusline-metrics/               # the statusline-metrics plugin (script + setup skill)
```

Each plugin is self-contained under its own directory with its own `.claude-plugin/plugin.json` and README.

## License

MIT. See [LICENSE](LICENSE).
