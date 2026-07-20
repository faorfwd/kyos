# /hire

> Stock the repo with the support it is missing before the next feature run trips over the same obvious gaps.

## Trigger

Run this when the codebase has grown into a stack that the surrounding guidance has not caught up with.

You usually need it after:

- adding a new runtime, framework, or hosted service
- introducing tooling that should be reachable through MCP
- noticing that future work depends on conventions nobody has written down yet
- seeing generic agent or skill folders where the repo clearly needs sharper specialization

## End state

This command is successful when the repo gains practical support, not when it produces the longest list of additions.

Useful outcomes include:

- a newly registered MCP in `.mcp.json`
- a reusable skill or agent stub added from `catalog/registry.json`
- a repo-owned skill stub under `.claude/skills/` for repo-specific practices (commit it)
- a blunt note that says what still has no good support

## Triage order

Work in this order:

1. Read `CLAUDE.md` and `.claude/commands/project-context.md`.
2. Inspect current support surfaces: `.mcp.json`, `.claude/agents/`, `.claude/skills/`.
3. Infer the actual stack from docs and repo signals.
4. Look for the highest-value gaps, not every possible gap.
5. Pull in catalog-backed additions where the match is obvious.
6. Author the file yourself under `.claude/` where the repo needs something custom.

## Selection policy

- Choose additions that reduce friction for upcoming work.
- Skip anything that is technically relevant but not actually useful yet.
- Prefer a small honest setup over a bloated pretend-complete setup.
- If there is no good fit, say so plainly and leave a local note.

## Description policy

Every skill or agent you add must carry a description that says when Claude should reach for it in this repo. A stub is not finished until its description is real.

Since you are writing these files yourself, there is no placeholder to fall back on.

Do not ship:

- a description that only restates the name back
- vague scope — "helps with database stuff", "various backend utilities"

Do ship a description that names the trigger and the surface:

```text
description: Conventions for Redis-backed job queues — key naming, TTL defaults, and retry semantics used by workers under src/jobs/.
```

Rule of thumb: if the description would still be true after swapping the repo for a different one, it is a no-op. Rewrite it or drop the stub.

If you genuinely cannot describe the capability yet, do not create the stub — record the gap in the field report instead.

## Things this command should not do

- write application features
- register tools just because they look impressive
- hide missing support behind generic placeholders
- treat the first setup pass as final

## Example prompts

```text
/hire
/hire prepare this repo for oauth, redis, and github actions
/hire we are introducing background jobs and object storage next
```

## What Claude should return

The result should read like a field report:

- what the repo seems to be using
- what support already exists
- what was added
- what was intentionally skipped
- what still needs a human decision or custom repo knowledge

## Hand-off

Once the repo support layer is in better shape, continue with `/spec`, `/tech`, or `/implement`.
