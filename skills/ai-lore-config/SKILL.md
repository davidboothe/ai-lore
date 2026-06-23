---
name: ai-lore-config
description: Validate and patch .ai-lore/config.yaml in the current project. Checks that all required fields are present, compares the config's plugin_version against the current plugin version (0.2.0), and applies semver migrations (auto-patches new optional keys for minor/patch bumps; prompts before breaking changes). Creates the config from the template with auto-detected toolchain values if it is missing. Safe to run standalone or as a pre-flight step before any other ai-lore skill. e.g. "check my ai-lore config", "/ai-lore-config".
---

# ai-lore-config

Validate and (if needed) patch `.ai-lore/config.yaml` for the current project. This skill is the canonical place to create or migrate a config; every other ai-lore skill may delegate here rather than duplicating detection logic.

**Current plugin version: 0.2.0**

---

## Config schema (v0.2.0)

All fields and their types:

| Field | Type | Required | Default | Since |
|---|---|---|---|---|
| `plugin_version` | string | yes (after 0.2.0) | (set by this skill) | 0.2.0 |
| `package_manager` | string | no | auto-detected | 0.1.0 |
| `gate` | list of strings | yes | auto-detected | 0.1.0 |
| `test_command` | string | yes | auto-detected | 0.1.0 |
| `worker.model` | string | no | `sonnet` | 0.1.0 |
| `worker.effort` | string | no | `high` | 0.1.0 |
| `worktrees.default` | boolean | no | `true` | 0.1.0 |
| `worktrees.dir` | string | no | `../<repo>-wt` | 0.1.0 |

---

## Workflow

### 1. Locate the config

Look for `.ai-lore/config.yaml` relative to the project root (the directory containing `.git`). If the file does not exist, go to **Step 4** (create from template).

### 2. Read and parse the config

Read `.ai-lore/config.yaml`. Parse the YAML. If the file is unparseable, report the error and stop; do not overwrite a corrupted file silently.

### 3. Determine migration status

Compare the `plugin_version` value in the config (call it `config_version`) against the current plugin version `0.2.0`.

**If `plugin_version` is absent** (v0.1 config -- this field did not exist before 0.2.0):
- This is a non-breaking migration. Auto-patch: add `plugin_version: 0.2.0` at the top of the file (after any leading comment block). No other fields changed in 0.2.0. Report what was added.

**If `config_version == plugin_version`** (up to date):
- Validate all required fields are present and non-null (see schema). Report any missing required fields and offer to add sensible defaults. Otherwise report "config OK at 0.2.0" and stop.

**If `config_version` is a lower minor or patch than `0.2.0`** (e.g. `0.1.x`):
- Apply the migration table below, adding any new optional fields with their defaults. Report each change made. Do NOT remove or rename existing keys.

**If `config_version` is a higher version than `0.2.0`**:
- The config was written by a newer plugin. Report this and warn the user they may be running an older plugin against a newer config. Do not modify the config.

**If `config_version` has a different major version** (e.g. config says `1.x` but plugin is `0.x`, or vice versa):
- This is a potentially breaking migration. Do NOT auto-patch. Show the user what changed and ask for explicit confirmation before modifying anything.

#### Migration table (cumulative, apply in order)

| From version | To version | Change |
|---|---|---|
| (absent / 0.1.x) | 0.2.0 | Add `plugin_version: 0.2.0` |

### 4. Create from template (config is missing)

If `.ai-lore/config.yaml` does not exist:

1. **Detect the toolchain** from the project root manifest and lock files:
   - **Node / JS / TS**: `package.json` present; manager from lockfile (`pnpm-lock.yaml` -> pnpm, `package-lock.json` -> npm, `yarn.lock` -> yarn, `bun.lockb` -> bun); read the `scripts` block for real check/lint/typecheck/test commands.
   - **Python**: `pyproject.toml` (manager: `uv.lock` -> uv, `poetry.lock` -> poetry, else pip/hatch) or `requirements.txt`; gate `ruff check .` plus `mypy .`; test `pytest`.
   - **Rust**: `Cargo.toml` -> cargo; gate `cargo clippy --all-targets` plus `cargo build`; test `cargo test`.
   - **Go**: `go.mod` -> go; gate `go vet ./...` plus `go build ./...`; test `go test ./...`.
   - **Ruby**: `Gemfile` -> bundler. **Java / Kotlin**: `pom.xml` -> maven, `build.gradle` -> gradle. **.NET**: `*.sln` / `*.csproj` -> dotnet.
   - Also honor a `Makefile`, `justfile`, or `Taskfile.yml` with obvious `lint` / `test` / `check` targets, preferring those.
   - If polyglot or ambiguous: ask the user.

2. Show the user the detected values (package_manager, gate commands, test_command) and confirm before writing.

3. Create `.ai-lore/` if it does not exist. Write `config.yaml` from `templates/config.yaml` with the detected values filled in and `plugin_version: 0.2.0` set. Report the created file path.

### 5. Report

End with a one-line status: `config OK at 0.2.0`, `config migrated 0.1.x -> 0.2.0 (added: plugin_version)`, or `config created at 0.2.0`. If any required fields are still missing after migration/creation (e.g. the user declined to fill in gate commands), list them explicitly so the user knows what to fix before running ai-lore-build-waves.

---

## Principles

- **Never silently overwrite.** Always report what changed and why.
- **Auto-patch only non-breaking changes** (new optional keys). Prompt for anything that renames, removes, or reinterprets an existing key.
- **Never add secrets.** Auth and tokens belong to MCP servers, not this config.
- **Codebase-agnostic.** All inferred commands come from project manifest files; never hardcode a toolchain.
- **No em dashes** in any file written by this skill (commas, semicolons, parentheses, periods instead).
