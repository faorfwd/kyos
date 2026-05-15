# /kyos:verify

> Check that implemented work matches the spec, still fits the plan, and leaves the repo in a trustworthy state.

## When to use it

Use this after one or more implementation slices have landed and you want a deliberate pass over correctness, behavior, and risk.

## What this should cover

- feature behavior versus the original spec
- implementation alignment with the technical plan
- tests, checks, and obvious regressions
- incomplete edges, hidden assumptions, and operational risk

## Sources to compare

- the changed code
- local test or check results, when available
- `docs/execution/<spec-slug>/spec.md` — read automatically if it exists
- `docs/execution/<spec-slug>/tech.md` — read automatically if it exists
- `docs/execution/<spec-slug>/tasks.md` — read automatically if it exists

Derive the slug from the argument if provided; otherwise glob `docs/execution/*/` and use the most recently modified folder.

## Verification pass

1. Locate the execution folder (from argument or most recently modified `docs/execution/*/`). Read `spec.md`, `tech.md`, and `tasks.md` from that folder — all that exist. Use them as the baseline to compare against the implementation.
2. Check whether the delivered behavior matches the promised behavior.
3. Check whether the implementation drifted from the technical approach in a meaningful way.
4. Run or inspect tests and validation steps where possible.
5. Call out missing cases, regressions, or unclear behavior directly.
6. End with a clear verdict: verified, partially verified, or needs rework.

## Things to avoid

- treating "it compiles" as verification
- ignoring behavior drift just because the code looks reasonable
- hiding gaps behind polite language

## Example prompts

```text
/kyos:verify
/kyos:verify check the OAuth implementation against the spec and tech plan
/kyos:verify review the completed CSV import slices for regressions and missing tests
```

## What Claude should return

The result should make it easy to decide what happens next:

- what is solid
- what is uncertain
- what needs to be fixed
- whether the feature is ready to move forward

## Next in flow

If verification fails, go back to [`/kyos:implement`](./implement.md).

If verification passes:

- tell the user the feature spec is now completed
- suggest deleting the finished spec note if it was only a temporary working artifact
- keep it only if the team wants a durable product or decision record
- then start the next feature cycle at [`/kyos:spec`](./spec.md)

