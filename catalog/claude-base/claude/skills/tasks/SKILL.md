---
name: tasks
description: Break the current technical plan into concrete, ordered work slices that can be executed and checked without losing the bigger picture.
argument-hint: "[spec-slug or free-text description]"
disable-model-invocation: true
---

# Tasks

Break the current technical plan into concrete, ordered work slices that can be executed and
checked without losing the bigger picture. Use this after the feature has both a functional spec
and a technical approach, but before implementation starts sprawling across too many moving parts
at once.

## What this should leave behind

- a short list of execution slices in a sensible order
- clear dependencies between slices
- a concrete verification note after each slice (tests to add or update, plus any required manual checks)
- a path into implementation that does not require rethinking the whole feature every time

## Inputs

- current repo context and obvious code hotspots
- existing test setup (test runner, frameworks, and CI checks), if any
- `docs/execution/<spec-slug>/spec.md` — read automatically if it exists
- `docs/execution/<spec-slug>/tech.md` — read automatically if it exists

Derive the slug from $ARGUMENTS if provided; otherwise glob `docs/execution/*/` and use the most
recently modified folder.

$ARGUMENTS

## How to break work down

1. Start from the end-to-end feature outcome.
2. Split the work into thin slices that can be completed and checked independently.
3. Separate foundational work from user-facing work.
4. Call out blockers, sequencing constraints, and anything that can run in parallel.
5. Keep each slice small enough that progress is visible.
6. Before finalizing verification notes, quickly check whether the repo has an established test runner or testing skill/agent coverage; if not, still propose best-effort tests but note they may not meet expectations.

## What good task slicing looks like

- each task changes a coherent part of the system
- each task has a visible outcome
- each task has a natural verification point
- the ordering reduces rework and merge pain

## Before writing tasks

1. Locate the execution folder (from $ARGUMENTS or most recently modified `docs/execution/*/`).
2. Read `spec.md` if it exists — use it to anchor scope and acceptance criteria.
3. Read `tech.md` if it exists — use it to anchor sequencing, interfaces, and risks.
4. If neither exists, proceed but note the missing context.

## Cross-linking

After saving tasks.md:

1. Include a **Related** section in tasks.md with links to `spec.md` and `tech.md` (both required; note if one is missing).
2. Open `spec.md` in the same execution folder and add or update a link to `tasks.md` in its **Related** section (create the section if absent).
3. Open `tech.md` in the same execution folder and add or update a link to `tasks.md` in its **Related** section (create the section if absent).

## What Agent should return

The result should read like an execution board:

- task name
- why it exists
- what it depends on
- what "done" means
- how to verify it (including what test(s) to add/update and the command(s) to run)

If the repo does not appear to have a working test harness yet:

- mention that gently (do not block the plan)
- still include verification guidance (e.g., minimal tests or manual checks)
- warn that proposed tests/check commands may need adjustment once the test setup is clarified

## Next steps

Once the task list is saved to disk, start implementation with the `implement` skill, pointing it
at `docs/execution/<spec-slug>/tasks.md`.

## Related section format

See the `spec` skill for the canonical **Related** section shape. Follow the same format: a
`## Related` block at the bottom with markdown links to sibling artefacts that exist. When
updating a sibling, insert only the missing link — do not duplicate.

## Where to save the result

Write the execution slices into a repo-owned markdown file so it can be reviewed and committed:

- `docs/execution/<spec-slug>/tasks.md`

Use the same `<spec-slug>` chosen by the `spec` skill (the folder created under `docs/execution/`).

## Local additions

- Generic extensions are located at `.claude/skill-overrides/_shared.md`. 
- Skill specific extensions are located at `.claude/skill-overrides/implement.md`. These have priority when competing with more generic instructions.

