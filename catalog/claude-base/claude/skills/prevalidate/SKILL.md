---
name: prevalidate
description: Run a quick, read-only safety + security prevalidation before doing any work in a repo (especially before running installers, tests, or scripts).
disable-model-invocation: true
---

# Prevalidate

Run a quick, **read-only** safety + security prevalidation before doing any work in a repo
(especially before running installers, tests, or scripts).

Before proceeding, check for `.claude/skill-overrides/_shared.md` and
`.claude/skill-overrides/prevalidate.md` in this repo. If either exists, read it and apply it — on
conflict, the per-skill file wins.

## Goals

- Reduce the chance of running something risky by accident.
- Surface obvious security hygiene issues early (secrets, unsafe execution patterns).
- Establish the *safest* next command to run.

## What to do (default)

1. **Repo orientation**
   - Identify language/tooling (Node/Python/.NET/PowerShell/SQL/etc.) and where "entry points" live.
   - Identify where config and automation lives (`.github/workflows`, install scripts, task runners).
2. **Secrets & sensitive data scan**
   - Search for credential patterns, private keys, tokens, and `.env*` variants.
   - Confirm `.gitignore` covers local secret files and common backups.
3. **Execution boundary scan**
   - Look for "download then execute", dynamic code execution, and shell injection primitives.
   - PowerShell red flags: `Invoke-Expression`, `ExecutionPolicy Bypass`, machine-wide `Set-ExecutionPolicy`.
   - SQL red flags: `xp_cmdshell`, OLE automation, broad grants, hardcoded SQL logins/passwords.
4. **Supply-chain sanity**
   - Check whether dependencies are pinned/locked (`package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, constraints files).
   - Note any scripts that fetch remote content and execute it.
5. **Safe next step**
   - Recommend the smallest safe next action (prefer read-only commands like `git status`, `rg`, listing files, or a dry-run).

## Output format

- **Green/Yellow/Red** overall status
- **Top risks**: 3–6 bullets with file references
- **Guardrails**: what not to run or what to run with extra caution
- **Next safe command**: one command suggestion (read-only/dry-run preferred)

## Local additions

Add repo-specific prevalidation checks here.
