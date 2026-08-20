---
name: kyos-setup
description: Scaffold and interactively configure kyos's skill-overrides mechanism — where spec/tech/tasks/implement/verify save artifacts, cleanup preferences, and per-skill tweaks.
disable-model-invocation: true
---

# Kyos Setup

Kyos skills read two kinds of override file so you can customize their behavior without editing
the skills themselves: `.claude/skill-overrides/_shared.md` (preferences several skills share)
and `.claude/skill-overrides/<name>.md` (one skill only, wins on conflict). Both live outside any
skill's own directory, so they survive `kyos-cli --update` and `npx skills update` alike.

## What this does

1. **Migrate pre-existing customizations from the old command-based layout, if any are found.**
   Before kyos had skills or `.claude/skill-overrides/`, every one of today's eight command-based
   skills (`spec`/`tech`/`tasks`/`implement`/`verify`/`prevalidate`/`architecture`/`hire` — every
   catalog skill except `critic` and `silent-execution`, which were already skills) lived at
   `.claude/commands/<name>.md` as a full, repo-owned file, and a repo owner customized it by
   hand-editing that file directly — commonly its `## Where to save the result` section for the
   five that produce execution artifacts, but potentially any section for any of the eight.
   Retiring commands in favor of skills left those files behind as orphaned, unmanaged stubs
   (kyos never auto-deletes a repo-owned file).
   - Check whether any `.claude/commands/<name>.md` exists for any of the eight names.
   - For each one found, compare its content against the stock wording for that command (`##
     Where to save the result` for the five that have it, but check the whole file for any of the
     eight) — a repo that never customized the file will match the original almost verbatim.
   - If a real customization is found, tell the user what it looks like (e.g. "your old
     `tech.md` command saved output to `plans/<slug>/tech.md` instead of the default
     `docs/execution/<slug>/tech.md`") and ask whether to carry it forward as an override.
   - On confirmation, write it into the appropriate new file: a convention shared across more
     than one of the eight goes into `_shared.md`; anything specific to one skill goes into that
     skill's own `.claude/skill-overrides/<name>.md`. Follow the same "never overwrite without
     confirming" guardrail as step 4 below.
   - Once all found customizations are handled (migrated or explicitly declined), tell the user
     the old `.claude/commands/<name>.md` files are now superseded and safe to delete, and ask
     before deleting them — don't delete unilaterally.
   - If no `.claude/commands/` files exist, skip this step silently and continue.
2. Ensure `.claude/skill-overrides/README.md` and `_shared.md` exist (create from the standard
   template if missing; leave alone if already present).
3. Ask the user, one question at a time, in plain conversation:
   - Where should `spec`/`tech`/`tasks`/`implement`/`verify` save execution artifacts?
     (default: `docs/execution/<slug>/`) — skip if step 1 already established this via migration.
   - Delete a completed execution folder after `verify` passes, or keep it as a durable record?
   - Any convention for the `<slug>` itself (e.g. always prefer a tracked issue key)?
   - Any other skill-specific tweak, for any of the ten, worth recording now? (open-ended, ask
     once, accept "no")
4. Write the shared answers into `_shared.md`. Write any skill-specific answer into that skill's
   own `.claude/skill-overrides/<name>.md`, creating it only if there's real content to put there.
5. Report what was written and where, and remind the user these files are plain markdown they can
   hand-edit any time without re-running this skill.

## Guardrails

- Never overwrite an existing override file's content without confirming — append or ask first.
- Don't pre-create empty per-skill files "just in case."
- Do not assume `.kyos/`, `kyos.json`, or any kyos-cli command exists — this skill works the same
  whether it arrived via kyos's own bootstrap or a bare `npx skills add` install.

## Local additions

Add repo-specific setup questions here.
