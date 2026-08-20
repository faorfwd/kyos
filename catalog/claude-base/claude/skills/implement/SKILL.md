---
name: implement
description: Move the feature forward in small verified slices, using the available specialists and repo context without losing the plan.
argument-hint: "[spec-slug or free-text description]"
disable-model-invocation: true
---

# Implement

Move the feature forward in small verified slices, using the available specialists and repo
context without losing the plan. Use this to carry a feature from technical plan into real code
changes while keeping progress visible.

Typical outcomes:

- one or more completed implementation slices
- updated progress notes
- a short status report with done, next, and blocked items

## Inputs

- current repo state
- available specialists/agents, skills, and MCPs
- `docs/execution/<spec-slug>/spec.md` — read automatically if it exists
- `docs/execution/<spec-slug>/tech.md` — read automatically if it exists
- `docs/execution/<spec-slug>/tasks.md` — read automatically if it exists (treated as the execution task file)

Derive the slug from $ARGUMENTS if provided; otherwise glob `docs/execution/*/` and use the most
recently modified folder.

$ARGUMENTS

## Workflow

1. Locate and read the execution task file (if provided).
2. Identify the next meaningful slice of work (or small set of independent slices).
3. Load the feature and technical context before touching code.
4. Search for the best available specialist/agent coverage for the slice(s).
5. If multiple slices can run in parallel without stepping on the same files or decisions, spawn multiple agents and assign each a clear ownership boundary.
6. Execute the slice(s) and verify locally when possible.
7. Record progress in the task file and move to the next slice if appropriate.
8. Stop clearly when blocked instead of hiding uncertainty.

## Guardrails

- Prefer vertical slices over giant code dumps.
- Keep implementation tied to the agreed feature and plan.
- Report progress explicitly (and persist it in the task file when one is available).
- Verify whenever the repo allows it.
- Only parallelize work when ownership is disjoint and coordination overhead stays low.

## Task completion tracking

If the user provides a task file (typically the output of the `tasks` skill, e.g.
`docs/execution/<spec-slug>/tasks.md`), treat it as the source of truth for progress.

1. Read the task file first and choose the next not-yet-done slice from it.
2. After completing a slice, update the same task file to reflect completion:
   - mark the slice as done (or update its status)
   - add a brief completion note (what changed)
   - add the verification note (what checks/tests ran and the result, or what could not be run)
3. If a slice is partially done or blocked, update the task file to say exactly what remains and what is blocking it.

## Parallel agent execution

If the task file exposes multiple ready slices that can be done independently, prefer parallel execution:

- Spawn one agent per slice (or per bounded sub-slice) and give each agent explicit ownership (files/areas/responsibilities).
- Keep one "orchestrator" thread responsible for integration, conflict resolution, and updating the task file.
- Avoid parallelizing work that shares the same files, schema, or core design decisions (do those sequentially).

## Claude behavior

1. Locate the execution folder (from $ARGUMENTS or most recently modified `docs/execution/*/`). Read `spec.md`, `tech.md`, and `tasks.md` from that folder — all that exist. Treat `tasks.md` as the source of truth for progress and remaining work.
2. Select the next concrete slice (or small set of independent slices).
3. Search for relevant specialists/agents and spawn multiple in parallel when the slices are independent.
4. Implement and validate the slice(s).
5. Update the progress state (in the provided task file when available).
6. Report what changed, what remains, and what is blocked.

## Next steps

Once the implementation slice is ready to be checked, continue with the `verify` skill.

## Local additions

## Local additions

- Generic extensions are located at `.claude/skill-overrides/_shared.md`. 
- Skill specific extensions are located at `.claude/skill-overrides/implement.md`. These have priority when competing with more generic instructions.
