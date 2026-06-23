# ai-lore

A Claude Code plugin for planning, building, and shipping work as **parallel waves of atomic tasks**. Three skills that hand off to each other:

| Skill | What it does |
| --- | --- |
| **plan-waves** | Brainstorms a goal into dependency-ordered *waves* of atomic tasks (tasks in a wave run in parallel because they touch disjoint files), then writes a plan folder under `.ai-lore/plans/<slug>/`. |
| **build-waves** | Executes a plan: runs each wave as a parallel fan-out of sub-agents (one per task) via the Workflow tool, gates every task on its acceptance criteria plus the project's checks, records progress in frontmatter so runs are resumable, and checkpoints with you between waves. |
| **cleanup** | Closes out a finished build: opens a pull request (Azure DevOps, GitHub, or a manual fallback) or merges the branch locally and tears down the worktree. |

The plugin is **codebase-agnostic**. It keys off a small `.ai-lore/config.yaml` (`gate`, `test_command`, `package_manager`, `worker`), and auto-detects sensible defaults for Node, Python, Rust, Go, Ruby, Java/Kotlin, and .NET projects when that file is missing.

## Install

Claude Code installs plugins from a **marketplace**. This repository is itself a marketplace (it ships a `.claude-plugin/marketplace.json`), so you add the repo as a marketplace once and then install the plugin from it.

### Option A: install from GitHub (recommended)

Run these two commands inside any Claude Code session:

```
/plugin marketplace add https://github.com/davidboothe/ai-lore.git
/plugin install ai-lore@ai-lore
```

- The first command registers this repo as a marketplace named `ai-lore`.
- The second installs the plugin. The syntax is `<plugin-name>@<marketplace-name>`, and here both are `ai-lore`.

> Use the full HTTPS URL as shown. The `owner/repo` shorthand (`davidboothe/ai-lore`) expands to an SSH clone URL and will fail with "Permission denied (publickey)" unless you have GitHub SSH keys configured, even for this public repo. Replace the URL with your own if you forked or renamed it.

Restart Claude Code (or start a new session) so the skills load.

### Option B: install from a local clone (for development)

If you have the repo checked out locally and want to iterate on it:

```
git clone https://github.com/dboothe/ai-lore.git
```

Then point the marketplace at the local path:

```
/plugin marketplace add /absolute/path/to/ai-lore
/plugin install ai-lore@ai-lore
```

Changes you make to the local files take effect after you reload Claude Code.

### Option C: install for a whole team via settings

To make every clone of a project pick up the plugin automatically, add it to the project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "ai-lore": {
      "source": {
        "source": "github",
        "repo": "dboothe/ai-lore"
      }
    }
  },
  "enabledPlugins": ["ai-lore@ai-lore"]
}
```

Anyone who trusts the project's settings gets the plugin without running any commands.

### Verify the install

```
/plugin
```

This opens the plugin manager; `ai-lore` should appear as installed and enabled. You can also confirm the skills are available, they show up as `/plan-waves`, `/build-waves`, and `/cleanup`.

### Update or remove

```
/plugin marketplace update ai-lore     # pull the latest from GitHub
/plugin uninstall ai-lore@ai-lore       # remove the plugin
```

## Use

```
/plan-waves the unified editor      # decompose and plan
/build-waves                        # build the plan, wave by wave
/cleanup                            # open a PR or merge and tear down
```

- `plan-waves` always brainstorms and asks questions before writing a plan.
- `build-waves` must run from the **main session** (only the main session can call the Workflow tool) and reads best from an Opus session.
- `cleanup` confirms before anything outward-facing or destructive (pushing, opening a PR, merging, deleting a branch).

You can also describe what you want in plain language ("let's plan the export pipeline", "build that plan", "open a PR for it") and Claude will route to the matching skill.

## How state is stored

Everything lives under `.ai-lore/` in the target repo and is **gitignored** (per-clone execution state):

```
.ai-lore/
├── config.yaml                 # project gate / test / worker settings
├── runs.yaml                   # registry of plan builds (the only cross-plan shared file)
├── ado.yaml                    # Azure DevOps PR settings (only if you use ADO)
└── plans/
    └── <YYYY-MM-DD-topic>/
        ├── plan.md             # manifest: status frontmatter + waves index
        └── tasks/
            └── <wave>-<n>-<topic>.md
```

Status lives in YAML frontmatter (written only by the orchestrator), so runs are resumable and concurrent plans stay isolated, one git worktree per plan.

## Configuration

`plan-waves`/`build-waves` write `.ai-lore/config.yaml` on first use, auto-detecting from your repo. Edit it to match your project's real commands, for any language:

```yaml
package_manager: pnpm          # hint only; auto-detected when omitted
gate:                          # commands that verify a wave before its tasks are marked complete
  - pnpm check
  - pnpm typecheck
test_command: pnpm test        # how test-based acceptance criteria are run
worker:
  model: sonnet                # per-task build sub-agent
  effort: high
worktrees:
  default: true                # build each plan in its own worktree by default (isolated, stable base); set false to opt out
  dir: ../<repo>-wt            # where per-plan worktrees go
```

By default `build-waves` runs each plan in its own git worktree cut from a clean committed base, so in-progress uncommitted work in your main checkout never leaks into a build. Ask it to build in the main checkout, or set `worktrees.default: false`, to opt out.

Examples for other ecosystems:

| Ecosystem | `gate` | `test_command` |
| --- | --- | --- |
| Python | `ruff check .`, `mypy .` | `pytest` |
| Rust | `cargo clippy --all-targets`, `cargo build` | `cargo test` |
| Go | `go vet ./...`, `go build ./...` | `go test ./...` |

## Requirements

- Claude Code with plugin support.
- `build-waves` uses the Workflow tool and is best run from an Opus session.
- `cleanup`'s PR path uses the `gh` CLI for GitHub, the connected `azure-devops` MCP server for Azure DevOps, or a manual fallback for other hosts.

## License

MIT. See [LICENSE](LICENSE).
