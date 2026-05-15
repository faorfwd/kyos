# /kyos:tasks

> Break the current technical plan into concrete, ordered work slices that can be executed and checked without losing the bigger picture.

## When to use it

Use this after the feature has both a functional spec and a technical approach, but before implementation starts sprawling across too many moving parts at once.

## What this should leave behind

- a short list of execution slices in a sensible order
- clear dependencies between slices
- a concrete verification note after each slice (tests to add or update, plus any required manual checks)
- a path into implementation that does not require rethinking the whole feature every time

## Inputs to read

- current repo context and obvious code hotspots
- existing test setup (test runner, frameworks, and CI checks), if any
- `docs/execution/<spec-slug>/spec.md` — read automatically if it exists
- `docs/execution/<spec-slug>/tech.md` — read automatically if it exists

Derive the slug from the argument if provided; otherwise glob `docs/execution/*/` and use the most recently modified folder.

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

## Example prompts

```text
/kyos:tasks
/kyos:tasks split the OAuth feature into execution slices
/kyos:tasks turn the CSV import tech plan into ordered implementation work
```

## Before writing tasks

Before breaking work down, Claude should:

1. Locate the execution folder (from argument or most recently modified `docs/execution/*/`).
2. Read `spec.md` if it exists — use it to anchor scope and acceptance criteria.
3. Read `tech.md` if it exists — use it to anchor sequencing, interfaces, and risks.
4. If neither exists, proceed but note the missing context.

## Cross-linking

After saving tasks.md, Claude should:

1. Include a **Related** section in tasks.md with links to `spec.md` and `tech.md` (both required; note if one is missing).
2. Open `spec.md` in the same execution folder and add or update a link to `tasks.md` in its **Related** section (create the section if absent).
3. Open `tech.md` in the same execution folder and add or update a link to `tasks.md` in its **Related** section (create the section if absent).

## What Claude should return

The result should read like an execution board:

- task name
- why it exists
- what it depends on
- what "done" means
- how to verify it (including what test(s) to add/update and the command(s) to run)

If the repo does not appear to have a working test harness yet, Claude should:

- mention that gently (do not block the plan)
- still include verification guidance (e.g., minimal tests or manual checks)
- warn that proposed tests/check commands may need adjustment once the test setup is clarified

## Next in flow

Run `/clear` to drop accumulated context, then kick off implementation with the saved tasks file:

```text
/kyos:implement @docs/execution/<spec-slug>/tasks.md
```

This gives the implementation run the full context window and a direct reference to the task list.

## Related section format

See [`/kyos:spec`](./spec.md#related-section-format) for the canonical **Related** section shape. Follow the same format: a `## Related` block at the bottom with markdown links to sibling artefacts that exist. When updating a sibling, insert only the missing link — do not duplicate.

## Where to save the result

Write the execution slices into a repo-owned markdown file so it can be reviewed and committed:

- `docs/execution/<spec-slug>/tasks.md`

Use the same `<spec-slug>` chosen in `/kyos:spec` (the folder created under `docs/execution/`).
