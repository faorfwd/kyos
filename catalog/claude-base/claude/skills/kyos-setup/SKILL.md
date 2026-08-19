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

1. Ensure `.claude/skill-overrides/README.md` and `_shared.md` exist (create from the standard
   template if missing; leave alone if already present).
2. Ask the user, one question at a time, in plain conversation:
   - Where should `spec`/`tech`/`tasks`/`implement`/`verify` save execution artifacts?
     (default: `docs/execution/<slug>/`)
   - Delete a completed execution folder after `verify` passes, or keep it as a durable record?
   - Any convention for the `<slug>` itself (e.g. always prefer a tracked issue key)?
   - Any other skill-specific tweak, for any of the ten, worth recording now? (open-ended, ask
     once, accept "no")
3. Write the shared answers into `_shared.md`. Write any skill-specific answer into that skill's
   own `.claude/skill-overrides/<name>.md`, creating it only if there's real content to put there.
4. Report what was written and where, and remind the user these files are plain markdown they can
   hand-edit any time without re-running this skill.

## Guardrails

- Never overwrite an existing override file's content without confirming — append or ask first.
- Don't pre-create empty per-skill files "just in case."
- Do not assume `.kyos/`, `kyos.json`, or any kyos-cli command exists — this skill works the same
  whether it arrived via kyos's own bootstrap or a bare `npx skills add` install.

## Local additions

Add repo-specific setup questions here.
