# kyos-cli

[![Socket Badge](https://badge.socket.dev/npm/package/kyos-cli)](https://socket.dev/npm/package/kyos-cli)
[![npm](https://img.shields.io/npm/v/kyos-cli)](https://www.npmjs.com/package/kyos-cli)
[![npm downloads](https://img.shields.io/npm/dt/kyos-cli)](https://www.npmjs.com/package/kyos-cli)
[![License](https://img.shields.io/npm/l/kyos-cli)](https://www.npmjs.com/package/kyos-cli)
[![Node version](https://img.shields.io/node/v/kyos-cli)](https://nodejs.org)

Claude Code works best with structure — without it, conversations drift, context gets lost, and results get inconsistent. `kyos-cli` installs a set of workflow commands into your project so you can move from idea to working code in a repeatable way. One command sets it up; the rest is up to you and Claude.

## Quickstart

```bash
npx kyos-cli --init
```

- Sets up a base Claude Code structure in your project — commands, workflow steps, and a config.
- Safe to run on an existing project: it shows you what it would change before doing anything.
- Run `kyos-cli --apply` to add only what's missing, or `kyos-cli --init --force` to start fresh.

## The workflow

Getting consistent results from Claude on complex tasks takes more than a single prompt — you need structure, clear steps, and a way to keep context across the session. `kyos-cli` gives you a starting point for that structure.

`kyos-cli` installs a structured workflow that breaks the process into clear steps:

| Command | What it does |
|---|---|
| `/spec` | Nail down what you're building before touching any code |
| `/tech` | Turn the idea into a concrete plan Claude can follow |
| `/tasks` | Break the plan into small, checkable steps |
| `/implement` | Execute the steps one by one, with verification at each |
| `/verify` | Confirm the result actually matches what was planned |

Run them in order for any feature or fix:

```text
/spec → /tech → /tasks → /implement → /verify
```

Each step saves its output to a file, so you can pause, resume in a new session, or hand off to someone else without losing context.

Three commands sit outside the main chain. Reach for them when the repo needs a safety check, a technical direction, or better tooling support:

| Command | What it does |
|---|---|
| `/prevalidate` | Quick safety check before making changes |
| `/architecture` | Set or revise your project's technical direction |
| `/hire` | Create skills, agents, or wire up MCPs to fill gaps in your repo's support layer |

## Tips

- **Compact after spec or tech** — if the context meter hits 50%+ after `/spec` or `/tech`, run `/compact` before continuing. Everything is saved to disk, so nothing is lost and the next command starts with a clean budget.
- **Clear before implement** — run `/clear` just before `/implement` to give the implementation run the full context window. Then reference the saved tasks file directly: `/implement @docs/execution/your-feature/tasks.md`.
- **Pick up where you left off** — if `spec.md`, `tech.md`, or `tasks.md` already exist when you open a new session, pass them in directly: `/tech @docs/execution/your-feature/spec.md`. Claude will read the file and continue from there.
- **Keep earlier files in sync** — if something changes during `/tech` or `/tasks` (scope shifts, new constraints, a better approach), reflect those changes back in the earlier files too. Keeping spec, tech, and tasks aligned means they can later be assembled into accurate feature documentation with minimal effort.
- **Pick the right model for planning** — before running `/spec`, `/tech`, or `/tasks`, set your model with `/model`: use `sonnet` for straightforward issues, `opus` for large or architecturally complex ones. Don't forget to revert when the planning phase is done.
- **Keep CLAUDE.md accurate** — revisit it as your project evolves. Stale instructions quietly degrade Claude's output; a brief review after major changes pays off more than it costs.
- **Start with agents if you have none** — if your project doesn't have any agents set up yet, run `/hire` before anything else. It's the fastest way to give Claude the right capabilities for your stack before you start building.

## CLI commands

| Command | Description |
|---|---|
| `kyos-cli --init` | Set up or inspect an existing setup (default) |
| `kyos-cli --init --force` | Reset everything to a clean baseline |
| `kyos-cli --apply` | Add only missing files, never overwrites anything |
| `kyos-cli --update` | Pull in the latest managed files without touching your customizations |
| `kyos-cli --add <type> <name>` | Add a skill, agent, or MCP from the catalog |
| `kyos-cli --doctor` | Check that everything is in order |

## Catalog

Extend your setup with optional capabilities:

```bash
kyos-cli --add skill critic          # Adds a sparring-partner skill that challenges plans before you commit to them
kyos-cli --add skill silent-execution # Cuts Claude's narration dramatically — act first, explain only when needed. Saves a significant amount of tokens on large tasks.

kyos-cli --add mcp context7          # Gives Claude up-to-date docs for libraries and frameworks you use
kyos-cli --add mcp filesystem        # Lets Claude read and write files outside the project directory
```

MCP entries are wired up automatically.

## Multi-repo rollout

The CLI runs in whatever directory you're in, so you can roll it out across projects with a simple loop:

```bash
for repo in ./repo-a ./repo-b ./repo-c; do
  (cd "$repo" && npx kyos-cli --init)
done
```

## Security

- **Zero runtime dependencies** — no third-party code runs when you install or use `kyos-cli`.
- **No install scripts** — nothing executes automatically at install time.
- **Publish provenance** — every release is cryptographically verifiable via [npm provenance attestation](https://docs.npmjs.com/generating-provenance-statements).
- **Lockfile committed** — dependency versions are pinned and regenerated on every release.
- **Path safety** — all file operations are strictly sandboxed to your project directory.

To report a vulnerability, see [SECURITY.md](./SECURITY.md).
