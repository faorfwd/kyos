# /kyos:tech

> Turn feature behavior into a build plan: moving parts, interfaces, data flow, failure modes, and implementation boundaries.

## Purpose

Use this after the feature intent is clear and before large code changes begin.

Typical outcomes:

- a technical plan for the target feature
- proposed interfaces, data structures, file boundaries, and operational considerations
- a note about new stack requirements that may need `/kyos:hire`

## Inputs

- `.claude/commands/project-context.md`
- the existing codebase
- `docs/execution/<spec-slug>/spec.md` — read automatically if it exists (derive the slug from the argument, or scan `docs/execution/` and use the most recently modified folder)

## Workflow

1. Identify the feature being designed.
2. Read the current architecture and inspect relevant code patterns.
3. Describe the implementation path in practical engineering terms.
4. Call out assumptions instead of hiding them.
5. Note interfaces, data flow, responsibilities, and risks.
6. Flag new technologies or domains that need extra specialist support.

## Guardrails

- This is a blueprint, not the final code.
- Stay grounded in the current repo where possible.
- Highlight risk and uncertainty early.

## Example prompts

```text
/kyos:tech
/kyos:tech use GitHub OAuth with secure session cookies and Redis session storage
/kyos:tech plan CSV import with validation pipeline, staging table, and background processing
```

## Claude behavior

When using this command, Claude should:

1. Locate the execution folder: if a slug or file path is provided as an argument, derive it from there; otherwise glob `docs/execution/*/` and pick the most recently modified folder. Then read `spec.md` from that folder if it exists — treat it as the primary feature context.
2. Draft a specific implementation approach.
3. Make assumptions visible and reviewable.
4. Point out risk, migration, or operational concerns.
5. Suggest `/kyos:hire` if the design introduces uncovered capabilities.
6. Include a **Related** section in tech.md with a link to `spec.md` (required) and to `tasks.md` if it already exists.
7. After saving tech.md, open `spec.md` in the same execution folder and add or update a link to `tech.md` in its **Related** section (create the section if absent).

## Next in flow

**Model tip:** Use `/model sonnet` for straightforward issues, `/model opus` for large or architecturally complex ones. Revert when the planning phase is done.

If the context meter is at 50% or more, run `/compact` before continuing — the plan is saved to disk so nothing is lost.

Continue with [`/kyos:tasks`](./tasks.md) to break the plan into ordered execution slices.

## Related section format

See [`/kyos:spec`](./spec.md#related-section-format) for the canonical **Related** section shape. Follow the same format: a `## Related` block at the bottom with markdown links to sibling artefacts that exist. When updating a sibling, insert only the missing link — do not duplicate.

## Where to save the result

Write the technical plan into a repo-owned markdown file so it can be reviewed and committed:

- `docs/execution/<spec-slug>/tech.md`

Use the same `<spec-slug>` chosen in `/kyos:spec` (the folder created under `docs/execution/`).
