---
name: tech
description: Turn feature behavior into a build plan: moving parts, interfaces, data flow, failure modes, and implementation boundaries.
argument-hint: "[spec-slug or free-text description]"
disable-model-invocation: true
---

# Tech

Turn feature behavior into a build plan: moving parts, interfaces, data flow, failure modes,
and implementation boundaries. Use this after the feature intent is clear and before large
code changes begin.

Typical outcomes:

- a technical plan for the target feature
- proposed interfaces, data structures, file boundaries, and operational considerations
- a note about new stack requirements that may need the `hire` skill

## Inputs

- the existing codebase
- `docs/execution/<spec-slug>/spec.md` — read automatically if it exists (derive the slug from
  $ARGUMENTS, or scan `docs/execution/` and use the most recently modified folder)

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

$ARGUMENTS

## Agen behavior

1. Locate the execution folder: derive the slug from $ARGUMENTS if given, otherwise glob
   `docs/execution/*/` and pick the most recently modified folder. Read `spec.md` from that
   folder if it exists — treat it as the primary feature context.
2. Draft a specific implementation approach.
3. Make assumptions visible and reviewable.
4. Point out risk, migration, or operational concerns.
5. Suggest the `hire` skill if the design introduces uncovered capabilities.
6. Include a **Related** section in tech.md linking `spec.md` (required) and `tasks.md` if present.
7. After saving tech.md, open spec.md in the same folder and add/update a link to tech.md.

## Next steps

Once the plan is saved to disk, continue with the `tasks` skill to break it into ordered execution slices.

## Related section format

See the `spec` skill for the canonical **Related** section shape. Follow the same format: a
`## Related` block at the bottom with markdown links to sibling artefacts that exist. When
updating a sibling, insert only the missing link — do not duplicate.

## Where to save the result

Write into `docs/execution/<spec-slug>/tech.md`, using the same slug chosen by the `spec` skill.

## Local additions

- Generic extensions are located at `.claude/skill-overrides/_shared.md`. 
- Skill specific extensions are located at `.claude/skill-overrides/implement.md`. These have priority when competing with more generic instructions.

