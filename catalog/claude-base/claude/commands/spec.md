# /kyos:spec

> Capture a feature in user language before discussing tables, endpoints, or framework details.

## Purpose

Use this command to turn an idea into a focused behavior spec with clear success conditions.

Typical outcomes:

- a single-feature planning note
- user-facing requirements
- acceptance criteria
- clearly marked unanswered questions

This is a working artifact, not permanent repo documentation. Once the feature is implemented and verified, the completed spec can be removed unless the team explicitly wants to keep it.

## Inputs

- current project priorities
- `CLAUDE.md`
- `.claude/commands/project-context.md`
- any nearby product or design notes

## Workflow

1. Pick one feature or slice of work.
2. Gather what is already known.
3. Write the behavior from the user's point of view.
4. Push on ambiguity with concrete follow-up questions.
5. Mark unresolved parts plainly instead of inventing certainty.
6. Translate the result into testable acceptance criteria.

## Guardrails

- Stay out of implementation detail.
- Keep the scope narrow.
- Prefer clarity over placeholder fluff.

## Example prompts

```text
/kyos:spec
/kyos:spec add GitHub OAuth sign-in
/kyos:spec let users upload CSV files and preview validation errors before import
```

## Claude behavior

When using this command, Claude should:

1. Restate the feature in plain language.
2. Ask for any missing user-facing detail.
3. Draft a concise but specific functional spec.
4. Mark unresolved questions explicitly.
5. Save the result into a local planning note.
6. After saving, check whether `tech.md` or `tasks.md` already exist in the same execution folder. If either exists, append a **Related** section to spec.md with links to the existing sibling artefacts.

## Next in flow

**Model tip:** Use `/model sonnet` for straightforward issues, `/model opus` for large or architecturally complex ones. Revert when the planning phase is done.

If the context meter is at 50% or more, run `/compact` before continuing — the spec is saved to disk so nothing is lost.

Continue with [`/kyos:tech`](./tech.md) to turn the feature behavior into an engineering approach.

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

1. Pick a short, path-safe spec slug (lowercase, hyphenated), e.g. `oauth-login` or `csv-import`.
2. Create: `docs/execution/<spec-slug>/`
3. Write the spec to:
   - `docs/execution/<spec-slug>/spec.md`

If the spec is purely a temporary working artifact, it can be deleted after `/kyos:verify`—but default to committing it while work is in flight.
