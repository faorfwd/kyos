# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# kyos

**kyos-cli** is a Node.js CLI tool that bootstraps and safely evolves a shared Claude Code repository structure across many repos. It separates a managed source layer (`.kyos/claude/`) from a repo-owned customization layer (`.claude/`) and uses SHA256 checksums to prevent silent overwrites of local edits.

## Commands

```bash
npm test                        # Run integration tests (test/flow.test.js)
npm start                       # Equivalent to: node ./bin/kyos.js --init
node ./bin/kyos.js --init       # Bootstrap or analyze existing setup
node ./bin/kyos.js --update     # Force-rewrite .kyos/ to current baseline
node ./bin/kyos.js --add <type> <name>  # Add capability (skill/agent/mcp/hook)
```

## Architecture

### Two-Layer Model

- `.kyos/claude/` — **Managed layer**: generated files owned by the framework. Tracked via `.kyos/lock.json` (SHA256 checksums).
- `.claude/` — **Customization layer**: thin wrapper stubs pointing to managed files, plus repo-specific content. Never overwritten without user consent.

Changes to managed files are planned (create/update/conflict/blocked) before being applied, so the framework never silently destroys local edits.

### Core Module Map (`src/core/`)

| File | Role |
|---|---|
| `cli.js` | Argument parsing; routes to `workflows.js` |
| `workflows.js` | All top-level operations: bootstrap, update, add-capability |
| `managed-files.js` | Checksum-based diff/merge: `planManagedChanges()` → `applyManagedChanges()` |
| `fs.js` | Safe filesystem I/O; validates all paths against traversal/symlink attacks |
| `config.js` | Reads/writes `.kyos/config.json` and `.mcp.json` |
| `catalog.js` | Loads `catalog/registry.json` and looks up skills/agents/MCPs |
| `hash.js` | SHA256 hashing for integrity checks |
| `constants.js` | All directory/file path constants |

### Bootstrap Flow (`workflows.js: runBootstrap`)

1. Reads `catalog/claude-base/` as the desired managed-file template.
2. Compares against `.kyos/lock.json` checksums to plan changes.
3. Writes managed files into `.kyos/claude/` and records new checksums.
4. Creates wrapper stubs in `.claude/` and seeds repo-owned templates (agents, skills, rules, commands).
5. Writes or updates `CLAUDE.md`.

### Managed Workflow Commands

Located in `catalog/claude-base/claude/commands/` (managed copies) and `.claude/commands/` (repo wrappers). Recommended delivery chain:

```
/spec → /tech → /tasks → /implement → /verify
```

Supporting commands: `/prevalidate`, `/architecture`, `/hire`.

### Catalog (`catalog/registry.json`)

Defines available capabilities that can be added with `--add`:
- **Skills**: `release-notes`, `security-audit`, `path-safety`, `mcp-hardening`, `secrets-and-supply-chain`
- **Agents**: `triage`
- **MCPs**: `context7`, `filesystem`
- **Hooks**: `repo-sandbox` — `PreToolUse` guard blocking tool calls whose paths resolve outside the repo root. Script sources live in `catalog/hooks/<name>/`. The installer copies the chosen runtime's script to `.claude/hooks/` and wires the event into `.claude/settings.json`.

## Working Rules

- Treat `.kyos/claude/` as generated output — do not hand-edit it; edit the catalog baseline instead.
- Treat `.claude/` as the repo-owner's customization layer.
- Path safety is enforced in `fs.js`: all paths must be relative, no `..` segments, no symlinks escaping the repo root. Match this pattern for any new file I/O.
- `--force` with `--init` destructively resets `.claude/`, `.kyos/`, and `CLAUDE.md`. `--update` resets `.kyos/` only.
- Capability names are validated by `validateCapabilityName()` (alphanumeric, dots, underscores, dashes — no traversal patterns).
