---
name: spec
description: Capture a feature in user language before discussing tables, endpoints, or framework details.
disable-model-invocation: true
---

# Spec

Capture a feature in user language before discussing tables, endpoints, or framework details.

Typical outcomes:

- a single-feature planning note
- user-facing requirements
- user-observable outcomes
- clearly marked unanswered questions

This is a working artifact, not permanent repo documentation. Once the feature is implemented and verified, the completed spec can be removed unless the team explicitly wants to keep it.

## Inputs

- current project priorities
- `CLAUDE.md`
- any nearby product or design notes
- user persona or role (inferred from context; only prompted if none is discernible)

## Workflow

1. Pick one feature or slice of work.
2. Gather what is already known.
3. Identify the user role from context; prompt once only if no actor is discernible.
4. Write the behavior from the user's point of view, opening with a user story: *As a [role], I want [capability], so that [outcome].*
5. Push on ambiguity with concrete follow-up questions.
6. Mark unresolved parts plainly instead of inventing certainty.
7. Translate the result into user-observable outcomes.

## Guardrails

- Stay out of implementation detail.
- Keep the scope narrow.
- Prefer clarity over placeholder fluff.

## Claude behavior

1. Restate the feature in plain language.
2. Ask for any missing user-facing detail.
3. Draft a concise but specific functional spec, opening with a user story (*As a [role], I want [capability], so that [outcome].*). Infer the role from context; ask only if it cannot be determined.
4. Mark unresolved questions explicitly.
5. Save the result into a local planning note.
6. After saving, check whether `tech.md` or `tasks.md` already exist in the same execution folder. If either exists, append a **Related** section to spec.md with links to the existing sibling artefacts.

## Next steps

Once the spec is saved to disk, continue with the `tech` skill to turn the feature behavior into an engineering approach.

## Related section format

The **Related** section belongs at the bottom of the artefact, above any trailing notes. Use this shape:

```markdown
## Related

- [Spec](./spec.md)
- [Tech](./tech.md)
- [Tasks](./tasks.md)
```

Only include links that exist. When updating a sibling artefact, append the section if absent or insert the missing link into an existing section — do not duplicate entries.

## Where to save the result

Create a dedicated execution folder for this spec, then write the spec into a repo-owned markdown file so it can be reviewed and committed.

1. Choose the spec slug:
   - **If the request references a tracked work item** (Jira/Linear/GitHub issue, etc.), prefer the issue key as the slug, e.g. `JT-222` or `PROJ-1043`. Match keys like `ABC-123` from the argument, a pasted URL, or a branch name. Preserve the key's original case.
   - **Otherwise**, pick a short, path-safe description slug (lowercase, hyphenated), e.g. `oauth-login` or `csv-import`.
   - When both are present, prefer the issue key only `JT-222`.
2. Create: `docs/execution/<spec-slug>/`
3. Write the spec to:
   - `docs/execution/<spec-slug>/spec.md`

If the spec is purely a temporary working artifact, it can be deleted after `verify`—but default to committing it while work is in flight.

## Local additions

- Generic extensions are located at `.claude/skill-overrides/_shared.md`. 
- Skill specific extensions are located at `.claude/skill-overrides/implement.md`. These have priority when competing with more generic instructions.

