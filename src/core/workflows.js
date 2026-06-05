const fs = require("fs");
const path = require("path");
const { getCapability, loadCatalog } = require("./catalog");
const {
  CLAUDE_MD_FILE,
  CLAUDE_ROOT,
  CATALOG_DIR,
  LOCK_FILE,
  MANAGED_ROOT,
  MCP_CONFIG_FILE,
  STATE_ROOT,
  USER_CONFIG_FILE,
} = require("./constants");
const {
  addInstalledCapability,
  loadMcpConfig,
  loadUserConfig,
  saveMcpConfig,
  saveUserConfig,
} = require("./config");
const { readJsonIfExists, resolveRepoPath, writeRepoTextFile } = require("./fs");
const { stableStringify } = require("./json");
const { sha256 } = require("./hash");
const {
  applyManagedChanges,
  findStaleManagedFiles,
  loadLock,
  planManagedChanges,
  renderManagedFiles,
} = require("./managed-files");

function readFrontmatterField(absolutePath, field) {
  if (!fs.existsSync(absolutePath)) return null;
  const content = fs.readFileSync(absolutePath, "utf8");
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

function walkSkillFiles(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((dir) => {
      const skillFile = path.join(skillsRoot, dir.name, "SKILL.md");
      return fs.existsSync(skillFile) ? [`${dir.name}/SKILL.md`] : [];
    });
}

function loadManagedManifest() {
  const base = path.join(CATALOG_DIR, "claude-base", "claude");
  const commands = fs.readdirSync(path.join(base, "commands")).filter((f) => f.endsWith(".md"));
  const skills = walkSkillFiles(path.join(base, "skills"));
  // Only agents in registry baseline get .claude/ wrappers; other catalog agents are managed-only.
  const catalog = loadCatalog();
  const agents = ((catalog.baseline || {}).agents || []).map((name) => `${name}.md`);
  return { commands, agents, skills };
}

function isPathWithinRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === "") {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function forceResetBootstrap({ cwd }) {
  const rootReal = fs.realpathSync.native(cwd);
  const targets = [CLAUDE_ROOT, ".kyos", CLAUDE_MD_FILE];

  for (const relativePath of targets) {
    const absolutePath = resolveRepoPath(cwd, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing --force reset through symlink/junction: ${relativePath}`);
    }

    const real = fs.realpathSync.native(absolutePath);
    if (!isPathWithinRoot(rootReal, real)) {
      throw new Error(`Refusing --force reset outside repo root (path resolves outside): ${relativePath}`);
    }

    fs.rmSync(absolutePath, { recursive: true, force: true });
  }
}

function ensureLineInFile(absolutePath, line) {
  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, `${line}\n`, "utf8");
    return;
  }
  const current = fs.readFileSync(absolutePath, "utf8");
  const normalized = current.replace(/\r\n/g, "\n");
  const already = normalized.split("\n").some((l) => l.trim() === line.trim());
  if (already) return;
  const suffix = normalized.length > 0 && !normalized.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(absolutePath, `${normalized}${suffix}${line}\n`, "utf8");
}

function ensureGitignoreHasKyos({ cwd }) {
  ensureLineInFile(resolveRepoPath(cwd, ".gitignore"), ".kyos/claude/");
}

function forceResetKyosOnly({ cwd }) {
  const rootReal = fs.realpathSync.native(cwd);
  const targets = [MANAGED_ROOT];

  for (const relativePath of targets) {
    const absolutePath = resolveRepoPath(cwd, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing --update through symlink/junction: ${relativePath}`);
    }

    const real = fs.realpathSync.native(absolutePath);
    if (!isPathWithinRoot(rootReal, real)) {
      throw new Error(`Refusing --update outside repo root (path resolves outside): ${relativePath}`);
    }

    fs.rmSync(absolutePath, { recursive: true, force: true });
  }
}

function managedCommandWrapper(filename) {
  const slug = filename.replace(/\.md$/i, "");
  const isReadme = slug.toLowerCase() === "readme";
  const title = isReadme ? "Kyos Commands" : `/kyos:${slug}`;
  const rel = `../../.kyos/claude/commands/${filename}`;

  return `# ${title}

This command is managed by kyos-cli.

You can:

- Add repo-specific notes/rules below to enrich the managed version, or
- Replace this file entirely and (optionally) remove the "Full definition" link to rely only on yours.

- Full definition: [${rel}](${rel})

## Local additions

Add any repo-specific guidance here.
`;
}

function managedAgentWrapper(filename) {
  const rel = `../../.kyos/claude/agents/${filename}`;
  return `---
model: haiku
skills:
  - silent-execution
---

# Silent Executor (Managed)

This agent is managed by kyos-cli.

- Full definition: [${rel}](${rel})

## How to use

Read the full definition file above and follow it as the source of truth.

## Local additions

Add any repo-specific guidance here.
`;
}

function managedSkillWrapper(relativePathFromSkillsRoot, { name, description }) {
  const rel = `../../../.kyos/claude/skills/${relativePathFromSkillsRoot}`;
  return `---
name: ${name}
description: ${description}
---

# Silent Executor (Managed)

This skill is managed by kyos-cli.

- Full definition: [${rel}](${rel})

## How to use

Read the full definition file above and follow it as the source of truth.

## Local additions

Add any repo-specific guidance here.
`;
}

function runBootstrap({ cwd, apply, force }) {
  const repoName = path.basename(cwd);
  if (apply) {
    return {
      ok: false,
      summary: "apply disabled",
      errors: ["The '--apply' command is temporarily disabled pending revalidation."],
    };
  }
  if (force) {
    forceResetBootstrap({ cwd });
  }
  const claudeMdExistedAtStart = fs.existsSync(resolveRepoPath(cwd, CLAUDE_MD_FILE));
  const config = loadUserConfig(cwd, repoName);
  const desiredFiles = renderManagedFiles({ cwd, config });
  const currentLock = loadLock(cwd);
  const plan = planManagedChanges({ cwd, desiredFiles, currentLock });
  const hasExistingClaudeSetup = detectExistingClaudeSetup(cwd);
  const stale = findStaleManagedFiles(cwd, desiredFiles, currentLock);
  const localSeedPlan = planLocalClaudeSeed({ cwd });

  if (!readJsonIfExists(resolveRepoPath(cwd, USER_CONFIG_FILE))) {
    saveUserConfig(cwd, config);
  }

  const created =
    plan.results.filter((item) => item.action === "create").length +
    localSeedPlan.results.filter((item) => item.action === "create").length;
  const updated = plan.results.filter((item) => item.action === "update").length;
  const conflicts = plan.results.filter((item) => item.action === "conflict").length;
  const blocked = plan.results.filter((item) => item.action === "blocked").length;

  if (!hasExistingClaudeSetup) {
    applyManagedChanges({ cwd, plan });
    applyLocalClaudeSeed({ cwd, plan: localSeedPlan });
    ensureGitignoreHasKyos({ cwd });
  }

  const combined = [...plan.results, ...localSeedPlan.results];
  const lines = combined
    .filter((item) => item.action !== "ok" || hasExistingClaudeSetup)
    .map((item) => {
      if (hasExistingClaudeSetup && !apply) {
        return formatProposalLine(item);
      }

      if (item.reason) {
        return `${symbolForAction(item.action)} ${item.path} (${item.reason})`;
      }

      return `${symbolForAction(item.action)} ${item.path}`;
    });

  for (const stalePath of stale) {
    lines.push(`! ${stalePath} (managed previously but no longer part of the current base set)`);
  }

  const createdClaudeMd =
    !claudeMdExistedAtStart &&
    (!hasExistingClaudeSetup || apply) &&
    plan.results.some((item) => item.action === "create" && item.path === CLAUDE_MD_FILE);

  if (createdClaudeMd) {
    lines.push("");
    lines.push(
      "We noticed that you didn't have a CLAUDE.md file, so we created one for you. However, we recommend regenerating it using Claude in planning mode for smoother interaction. Run /init in your Claude terminal"
    );
  }

  if (hasExistingClaudeSetup && !apply) {
    const hasSafeActions = created + updated > 0;
    const hasProblems = conflicts + blocked > 0;
    const hasStale = stale.length > 0;

    const warnings = ["No files were changed (analysis mode)."];

    if (!hasSafeActions && !hasProblems && !hasStale) {
      warnings.push("No changes detected; your Claude setup already matches the current baseline.");
    } else {
      if (hasSafeActions) {
        warnings.push(
          "Proposed safe changes are listed above. Run '--apply' to write missing files, or '--init --force' to reset everything to baseline (destructive)."
        );
      } else {
        warnings.push("No safe create/update actions were proposed.");
      }

      if (hasProblems) {
        warnings.push("Some items are conflicts/blocked; kyos-cli will not overwrite locally-changed or unmanaged files.");
      }

      if (hasStale) {
        warnings.push("Stale managed files were detected. Review them before removing anything.");
      }
    }

    return {
      ok: true,
      summary: `analysis complete: ${created} proposed additions, ${updated} proposed updates, ${conflicts} managed conflicts, ${blocked} unmanaged blockers.`,
      lines,
      warnings,
    };
  }

  return {
    ok: conflicts === 0 && blocked === 0,
    summary: hasExistingClaudeSetup
      ? `apply complete: ${created} created, ${updated} updated, ${conflicts} conflicts, ${blocked} blocked.`
      : `bootstrap complete: ${created} created, ${updated} updated, ${conflicts} conflicts, ${blocked} blocked.`,
    lines,
    warnings: stale.length > 0 ? ["Stale managed files were detected. Review them before removing anything."] : [],
  };
}

function planLocalClaudeSeed({ cwd }) {
  const seedFiles = {
    [`${CLAUDE_ROOT}/commands/project-context.md`]:
      "# Project Context (Repo-Owned)\n\nCapture architecture, key commands, and testing guidance for this repository here.\n\n- What are we building?\n- What are the main components (UI/API/workers)?\n- What are the key external dependencies?\n- How do we run tests and validate changes?\n",
    [`${CLAUDE_ROOT}/agents/README.md`]:
      "# Local Agents\n\nPut repo-specific agents here. This folder is intentionally yours; kyos will not overwrite local agents.\n\n## Available agents\n\n- `security-engineer.md` — deep-dive AppSec mindset for threat modeling, code review, and actionable remediations.\n",
    [`${CLAUDE_ROOT}/agents/security-engineer.md`]:
      "# Security Engineer (Deep Dive)\n\nYou are a pragmatic security engineer. You apply modern best practices, dig deeply into code and system behavior, and communicate clearly about risk and fixes.\n\n## Prevalidation gate (before doing work in a repo)\n\nWhen asked to work in an unfamiliar repo (or before running scripts/tests/tools), **prevalidate first**:\n\n1. Identify risky operations you might be asked to run (install scripts, formatters, “download then execute”, DB migrations).\n2. Scan for obvious red flags (committed secrets, unsafe shelling out, dangerous defaults).\n3. Confirm the safest “next command” to run (smallest, read-only, or dry-run).\n4. Only proceed to implementation after reporting the prevalidation results and any required guardrails.\n\nIf available, use `/kyos:prevalidate` and summarize its output before starting changes.\n\n## How you work\n\n- Prefer evidence over guesses: cite concrete code paths, configs, and behaviors.\n- Think in trust boundaries and data flows: sources → transforms → sinks.\n- Prioritize by impact × likelihood × ease-of-exploitation.\n- Recommend the smallest safe fix first; avoid breaking changes unless required.\n- Be explicit about assumptions and unknowns; ask targeted questions when needed.\n\n## Default workflow\n\n1. Scope & assets: what’s in scope, who are the actors, what data matters.\n2. Threat model: entry points, trust boundaries, high-priv capabilities.\n3. Attack surface review: inputs, authn/authz, session/token handling, data validation.\n4. Findings: impact, exploit scenario, evidence, severity.\n5. Remediation: preferred fix + safe alternatives; note migrations/gotchas.\n6. Verification: tests and manual steps to confirm the fix.\n\n## Common high-signal checks\n\n- Authz: IDOR/BOLA, missing role checks, privilege escalation.\n- Injection: SQL/NoSQL/command/template; unsafe deserialization.\n- Web: XSS, CSRF, open redirect, CORS misconfig.\n- SSRF: URL fetchers, webhooks, “download this URL”.\n- Secrets: hardcoded creds, secrets in logs/URLs, overly broad scopes.\n- DoS: unbounded payloads, expensive regex/queries, missing timeouts/rate limits.\n- Supply chain: “download then execute”, unpinned deps, unsafe CI.\n\n## Output format (use by default)\n\n- Summary: 3–6 bullets with the most important risks and next actions.\n- Findings (repeat per finding):\n  - Title\n  - Severity (Critical/High/Medium/Low/Info)\n  - Impact\n  - Exploit scenario / Preconditions\n  - Evidence (files/functions/configs; repro steps if safe)\n  - Fix (preferred + alternatives)\n  - Verification\n\n## Safety\n\nDo not provide instructions intended to facilitate real-world wrongdoing. Use minimal, controlled PoCs and harmless payloads when demonstrating issues.\n",
    [`${CLAUDE_ROOT}/skills/README.md`]:
      "# Local Skills\n\nPut repo-specific skills here. These are repo-owned instructions that complement the managed base under `.kyos/claude/`.\n",
    [`${CLAUDE_ROOT}/rules/README.md`]:
      "# Local Rules\n\nPut repo-specific working rules here (coding standards, review expectations, release rules, security notes).\n",
    [`${CLAUDE_ROOT}/settings.json`]: stableStringify({
      permissions: {
        defaultMode: "ask",
      },
      statusLine: {
        showBranch: true,
        showDirty: true,
      },
    }),
    [`${CLAUDE_ROOT}/commands/README.md`]:
      "# Local Commands\n\nThis folder is for repo-owned workflow prompts (slash-style commands).\n\nRecommended daily flow:\n\n`/kyos:spec -> /kyos:tech -> /kyos:tasks -> /kyos:implement -> /kyos:verify`\n\nIf you’re new to the repo or about to run tooling/scripts, start with:\n\n`/kyos:prevalidate`\n",
    [`${CLAUDE_ROOT}/commands/prevalidate.md`]:
      "# /kyos:prevalidate\n\nRun a quick, **read-only** safety + security prevalidation before doing any work in a repo (especially before running installers, tests, or scripts).\n\n## Goals\n\n- Reduce the chance of running something risky by accident.\n- Surface obvious security hygiene issues early (secrets, unsafe execution patterns).\n- Establish the *safest* next command to run.\n\n## What to do (default)\n\n1. **Repo orientation**\n   - Identify language/tooling (Node/Python/.NET/PowerShell/SQL/etc.) and where “entry points” live.\n   - Identify where config and automation lives (`.github/workflows`, install scripts, task runners).\n2. **Secrets & sensitive data scan**\n   - Search for credential patterns, private keys, tokens, and `.env*` variants.\n   - Confirm `.gitignore` covers local secret files and common backups.\n3. **Execution boundary scan**\n   - Look for “download then execute”, dynamic code execution, and shell injection primitives.\n   - PowerShell red flags: `Invoke-Expression`, `ExecutionPolicy Bypass`, machine-wide `Set-ExecutionPolicy`.\n   - SQL red flags: `xp_cmdshell`, OLE automation, broad grants, hardcoded SQL logins/passwords.\n4. **Supply-chain sanity**\n   - Check whether dependencies are pinned/locked (`package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, constraints files).\n   - Note any scripts that fetch remote content and execute it.\n5. **Safe next step**\n   - Recommend the smallest safe next action (prefer read-only commands like `git status`, `rg`, listing files, or a dry-run).\n\n## Output format\n\n- **Green/Yellow/Red** overall status\n- **Top risks**: 3–6 bullets with file references\n- **Guardrails**: what not to run or what to run with extra caution\n- **Next safe command**: one command suggestion (read-only/dry-run preferred)\n",
    [`${CLAUDE_ROOT}/commands/architecture.md`]:
      "# /kyos:architecture\n\nUse when the repo needs a directional refresh: clarify the target architecture, boundaries, and the few decisions that should not be revisited every task.\n",
    [`${CLAUDE_ROOT}/commands/hire.md`]:
      "# /kyos:hire\n\nUse when the current stack needs better support: missing skills, agents, or MCPs. Prefer small, explicit additions that reduce friction for the next few tasks.\n",
    [`${CLAUDE_ROOT}/commands/spec.md`]:
      "# /kyos:spec\n\nWrite a concrete, user-facing spec: goals, non-goals, acceptance criteria, and edge cases.\n\nNext: [/kyos:tech](./tech.md)\n",
    [`${CLAUDE_ROOT}/commands/tech.md`]:
      "# /kyos:tech\n\nTurn the spec into an engineering plan: approach, data/contracts, risk list, and test strategy.\n\nNext: [/kyos:tasks](./tasks.md)\n",
    [`${CLAUDE_ROOT}/commands/tasks.md`]:
      "# /kyos:tasks\n\nBreak the plan into ordered slices that can be implemented and verified safely.\n\nNext: [/kyos:implement](./implement.md)\n",
    [`${CLAUDE_ROOT}/commands/implement.md`]:
      "# /kyos:implement\n\nImplement one slice at a time. Keep changes reviewable and run the smallest relevant verification each slice.\n\nNext: [/kyos:verify](./verify.md)\n",
    [`${CLAUDE_ROOT}/commands/verify.md`]:
      "# /kyos:verify\n\nVerify behavior against the spec and plan. If it passes, suggest deleting any completed working spec files that are no longer useful.\n\nNext cycle: [/kyos:spec](./spec.md)\n",
  };

  const manifest = loadManagedManifest();

  // Seed the managed commands as short wrappers that point to `.kyos/claude/commands/`,
  // while leaving `.claude/commands/project-context.md` as repo-owned content.
  for (const filename of manifest.commands) {
    delete seedFiles[`${CLAUDE_ROOT}/commands/${filename}`];
  }
  // security-engineer ships in .kyos/ as catalog content but is not seeded to .claude/
  // (repo teams add it themselves if they want it; it's not a wrapper pattern).
  delete seedFiles[`${CLAUDE_ROOT}/agents/security-engineer.md`];

  const results = [];
  for (const [relativePath, content] of Object.entries(seedFiles)) {
    const absolutePath = resolveRepoPath(cwd, relativePath);
    if (fs.existsSync(absolutePath)) {
      results.push({ action: "ok", path: relativePath });
      continue;
    }
    results.push({ action: "create", path: relativePath, content });
  }

  for (const filename of manifest.commands) {
    const relativePath = `${CLAUDE_ROOT}/commands/${filename}`;
    const absolutePath = resolveRepoPath(cwd, relativePath);
    if (fs.existsSync(absolutePath)) {
      results.push({ action: "ok", path: relativePath });
      continue;
    }
    results.push({ action: "create", path: relativePath, content: managedCommandWrapper(filename) });
  }

  for (const filename of manifest.agents) {
    const relativePath = `${CLAUDE_ROOT}/agents/${filename}`;
    const absolutePath = resolveRepoPath(cwd, relativePath);
    if (fs.existsSync(absolutePath)) {
      results.push({ action: "ok", path: relativePath });
      continue;
    }
    results.push({ action: "create", path: relativePath, content: managedAgentWrapper(filename) });
  }

  for (const relativePathFromSkillsRoot of manifest.skills) {
    const relativePath = `${CLAUDE_ROOT}/skills/${relativePathFromSkillsRoot}`;
    const absolutePath = resolveRepoPath(cwd, relativePath);
    if (fs.existsSync(absolutePath)) {
      results.push({ action: "ok", path: relativePath });
      continue;
    }
    const skillName = relativePathFromSkillsRoot.split("/")[0];
    const catalogSkillPath = path.join(CATALOG_DIR, "claude-base", "claude", "skills", relativePathFromSkillsRoot);
    const description = readFrontmatterField(catalogSkillPath, "description") || `Managed skill: ${skillName}.`;
    results.push({
      action: "create",
      path: relativePath,
      content: managedSkillWrapper(relativePathFromSkillsRoot, { name: skillName, description }),
    });
  }

  return { results };
}

function runUpdateKyos({ cwd }) {
  const repoName = path.basename(cwd);

  forceResetKyosOnly({ cwd });

  const config = loadUserConfig(cwd, repoName);
  const desiredFiles = renderManagedFiles({ cwd, config });
  const kyosOnlyFiles = Object.fromEntries(
    Object.entries(desiredFiles).filter(([relativePath]) => relativePath === STATE_ROOT || relativePath.startsWith(`${STATE_ROOT}/`))
  );

  const currentLock = loadLock(cwd);
  const plan = planManagedChanges({ cwd, desiredFiles: kyosOnlyFiles, currentLock });
  applyManagedChanges({ cwd, plan });
  ensureGitignoreHasKyos({ cwd });

  const created = plan.results.filter((item) => item.action === "create").length;
  const updated = plan.results.filter((item) => item.action === "update").length;
  const conflicts = plan.results.filter((item) => item.action === "conflict").length;
  const blocked = plan.results.filter((item) => item.action === "blocked").length;

  return {
    ok: conflicts === 0 && blocked === 0,
    summary: `update complete: ${created} created, ${updated} updated, ${conflicts} conflicts, ${blocked} blocked.`,
    lines: plan.results.map((item) => {
      if (item.reason) {
        return `${symbolForAction(item.action)} ${item.path} (${item.reason})`;
      }
      return `${symbolForAction(item.action)} ${item.path}`;
    }),
    warnings: [
      "Rewrote .kyos/ to the current baseline. Local changes under .kyos/ were discarded.",
      ".claude/ and CLAUDE.md were not modified.",
    ],
  };
}

function applyLocalClaudeSeed({ cwd, plan }) {
  for (const item of plan.results) {
    if (item.action !== "create") {
      continue;
    }
    writeRepoTextFile(cwd, item.path, item.content);
  }
}

function runDoctor({ cwd }) {
  const warnings = [];
  const errors = [];
  const repoName = path.basename(cwd);
  const config = loadUserConfig(cwd, repoName);
  const currentLock = loadLock(cwd);
  const desiredFiles = renderManagedFiles({ cwd, config });
  const stale = findStaleManagedFiles(cwd, desiredFiles, currentLock);
  const hasExistingClaudeSetup = detectExistingClaudeSetup(cwd);

  if (!readJsonIfExists(resolveRepoPath(cwd, USER_CONFIG_FILE))) {
    warnings.push(`${USER_CONFIG_FILE} is missing. Run 'npx kyos-cli --init' to create it.`);
  }

  if (!readJsonIfExists(resolveRepoPath(cwd, LOCK_FILE))) {
    warnings.push(`${LOCK_FILE} is missing. Safe managed updates are limited until the bootstrap is applied.`);
  }

  for (const [relativePath, lockEntry] of Object.entries(currentLock.files || {})) {
    const absolutePath = resolveRepoPath(cwd, relativePath);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`${relativePath} is tracked in the lock file but is missing from disk.`);
      continue;
    }

    const content = fs.readFileSync(absolutePath, "utf8");
    if (sha256(content) !== lockEntry.checksum) {
      warnings.push(`${relativePath} differs from its last managed checksum.`);
    }
  }

  if (stale.length > 0) {
    warnings.push(`${stale.length} stale managed files were found.`);
  }

  const { commands: managedCommands } = loadManagedManifest();
  const commandReport = [];
  for (const filename of managedCommands) {
    const catalogPath = path.join(CATALOG_DIR, "claude-base", "claude", "commands", filename);
    const catalogContent = fs.readFileSync(catalogPath, "utf8");
    const catalogBytes = Buffer.byteLength(catalogContent, "utf8");
    const catalogChecksum = sha256(catalogContent);

    const managedRelativePath = `${MANAGED_ROOT}/commands/${filename}`;
    const managedAbsolutePath = resolveRepoPath(cwd, managedRelativePath);
    let managedNote = "missing";
    if (fs.existsSync(managedAbsolutePath)) {
      const managedContent = fs.readFileSync(managedAbsolutePath, "utf8");
      const managedBytes = Buffer.byteLength(managedContent, "utf8");
      const managedChecksum = sha256(managedContent);
      managedNote =
        managedChecksum === catalogChecksum
          ? `ok (${managedBytes}B)`
          : `differs from catalog (${managedBytes}B vs ${catalogBytes}B)`;
    }

    const localRelativePath = `${CLAUDE_ROOT}/commands/${filename}`;
    const localAbsolutePath = resolveRepoPath(cwd, localRelativePath);
    const wrapperContent = managedCommandWrapper(filename);
    const wrapperBytes = Buffer.byteLength(wrapperContent, "utf8");
    const wrapperChecksum = sha256(wrapperContent);

    let localNote = "missing";
    if (fs.existsSync(localAbsolutePath)) {
      const localContent = fs.readFileSync(localAbsolutePath, "utf8");
      const localBytes = Buffer.byteLength(localContent, "utf8");
      const localChecksum = sha256(localContent);

      if (localChecksum === wrapperChecksum) {
        localNote = `wrapper ok (${localBytes}B)`;
      } else if (localChecksum === catalogChecksum) {
        localNote = `matches catalog (${localBytes}B)`;
      } else {
        localNote = `changed (${localBytes}B; catalog ${catalogBytes}B; wrapper ${wrapperBytes}B)`;
      }
    }

    commandReport.push(`command: ${filename} local ${localNote}; managed ${managedNote}`);
  }

  return {
    ok: errors.length === 0,
    summary: "doctor summary",
    lines: [
      `repo: ${repoName}`,
      `claude setup detected: ${hasExistingClaudeSetup ? "yes" : "no"}`,
      `managed files tracked: ${Object.keys(currentLock.files || {}).length}`,
      `installed skills: ${(config.installed.skills || []).length}`,
      `installed agents: ${(config.installed.agents || []).length}`,
      `installed mcps: ${(config.installed.mcps || []).length}`,
      ...commandReport,
    ],
    warnings,
    errors,
  };
}

function addCapability({ cwd, type, name }) {
  const normalizedType = normalizeCapabilityType(type);
  if (!normalizedType) {
    return {
      ok: false,
      errors: ["Capability type must be one of: skill, agent, mcp."],
    };
  }

  const nameError = validateCapabilityName(name);
  if (nameError) {
    return {
      ok: false,
      errors: [nameError],
    };
  }

  const repoName = path.basename(cwd);
  const config = loadUserConfig(cwd, repoName);
  const catalog = loadCatalog();
  const capability = getCapability(catalog, normalizedType, name);

  if (normalizedType !== "mcp") {
    const baselineKey = normalizedType === "skill" ? "skills" : "agents";
    const baselineNames = (catalog.baseline || {})[baselineKey] || [];
    if (baselineNames.includes(name)) {
      return {
        ok: true,
        summary: `'${name}' is included in the baseline — seeded automatically by --init. No --add needed.`,
      };
    }
  }

  if (normalizedType === "mcp") {
    if (!capability) {
      return {
        ok: false,
        errors: [`Unknown mcp '${name}'. Add it to catalog/registry.json first.`],
      };
    }

    const mcpConfig = loadMcpConfig(cwd);
    mcpConfig.enabledPlugins = mcpConfig.enabledPlugins || {};
    mcpConfig.enabledPlugins[name] = true;
    saveMcpConfig(cwd, mcpConfig);
    addInstalledCapability(config, "mcps", name);
    saveUserConfig(cwd, config);

    return {
      ok: true,
      summary: `registered mcp '${name}' in ${MCP_CONFIG_FILE}`,
      lines: capability.notes ? capability.notes.map((line) => `- ${line}`) : [],
    };
  }

  let targetRelativePath;
  if (normalizedType === "skill") {
    targetRelativePath = `${CLAUDE_ROOT}/skills/${name}/SKILL.md`;
  } else {
    targetRelativePath = `${CLAUDE_ROOT}/agents/${name}.md`;
  }
  writeRepoTextFile(cwd, targetRelativePath, createOverrideTemplate({ type: normalizedType, name, capability }));
  addInstalledCapability(config, normalizedType === "skill" ? "skills" : "agents", name);
  saveUserConfig(cwd, config);

  return {
    ok: true,
    summary: `created ${normalizedType} override stub '${name}'`,
    lines: capability && capability.notes ? capability.notes.map((line) => `- ${line}`) : [],
  };
}

function normalizeCapabilityType(type) {
  if (type === "skill" || type === "agent" || type === "mcp") {
    return type;
  }

  return null;
}

function validateCapabilityName(name) {
  if (typeof name !== "string" || name.length === 0) {
    return "Capability name is required.";
  }

  // Keep capability identifiers path-safe so local stub creation cannot escape
  // the intended repo-owned `.claude` directories.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return "Capability name may contain only letters, numbers, dots, underscores, and dashes.";
  }

  if (name.includes("..")) {
    return "Capability name may not contain '..'.";
  }

  return null;
}

function normalizeSkillFrontmatterName(identifier) {
  return String(identifier)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function createOverrideTemplate({ type, name, capability }) {
  const description = capability && capability.description
    ? capability.description
    : `Local ${type} customizations for ${name}.`;

  if (type === "skill") {
    const frontmatterName = normalizeSkillFrontmatterName(name);
    const safeName = frontmatterName || "custom-skill";
    return `---\nname: ${safeName}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n\n## Purpose\n\nDescribe what this skill should help Claude do in this repo.\n\n## Instructions\n\n- Add the concrete behavior, constraints, and output contract here.\n- Keep it repo-specific and actionable.\n`;
  }

  const title = `${type[0].toUpperCase()}${type.slice(1)} Override: ${name}`;
  return `# ${title}

${description}

## Purpose

Describe what this repo needs to override or extend locally.

## Contract

- Keep framework-managed assets under \`.kyos/claude/\`.
- Store repo-specific logic under \`.claude/\`.
- Document any coupling to generated commands, agents, or skills.
`;
}

function detectExistingClaudeSetup(cwd) {
  return (
    fs.existsSync(resolveRepoPath(cwd, CLAUDE_ROOT)) ||
    fs.existsSync(resolveRepoPath(cwd, path.join(MANAGED_ROOT, "commands"))) ||
    fs.existsSync(resolveRepoPath(cwd, CLAUDE_MD_FILE))
  );
}

function formatProposalLine(item) {
  if (item.action === "create") {
    return `+ would add ${item.path}`;
  }

  if (item.action === "update") {
    return `~ would update ${item.path}`;
  }

  if (item.action === "ok") {
    return `= unchanged ${item.path}`;
  }

  if (item.reason) {
    return `${symbolForAction(item.action)} ${item.path} (${item.reason})`;
  }

  return `${symbolForAction(item.action)} ${item.path}`;
}

function symbolForAction(action) {
  switch (action) {
    case "create":
      return "+";
    case "update":
      return "~";
    case "conflict":
      return "!";
    case "blocked":
      return "x";
    case "ok":
      return "=";
    default:
      return "?";
  }
}

function replayInstalledCapabilities({ cwd, config }) {
  const catalog = loadCatalog();
  const lines = [];

  for (const name of (config.installed.skills || [])) {
    const targetPath = `${CLAUDE_ROOT}/skills/${name}/SKILL.md`;
    if (!fs.existsSync(resolveRepoPath(cwd, targetPath))) {
      const capability = getCapability(catalog, "skill", name);
      writeRepoTextFile(cwd, targetPath, createOverrideTemplate({ type: "skill", name, capability }));
      lines.push(`+ ${targetPath}`);
    }
  }

  for (const name of (config.installed.agents || [])) {
    const targetPath = `${CLAUDE_ROOT}/agents/${name}.md`;
    if (!fs.existsSync(resolveRepoPath(cwd, targetPath))) {
      const capability = getCapability(catalog, "agent", name);
      writeRepoTextFile(cwd, targetPath, createOverrideTemplate({ type: "agent", name, capability }));
      lines.push(`+ ${targetPath}`);
    }
  }

  const mcpNames = config.installed.mcps || [];
  if (mcpNames.length > 0) {
    const mcpConfig = loadMcpConfig(cwd);
    let changed = false;
    for (const name of mcpNames) {
      if (!mcpConfig.enabledPlugins[name]) {
        const capability = getCapability(catalog, "mcp", name);
        if (capability) {
          mcpConfig.enabledPlugins[name] = true;
          changed = true;
          lines.push(`+ mcp:${name}`);
        }
      }
    }
    if (changed) {
      saveMcpConfig(cwd, mcpConfig);
    }
  }

  return lines;
}

function runApply({ cwd }) {
  if (!detectExistingClaudeSetup(cwd)) {
    return { ok: true, summary: "Nothing to apply. Run --init to bootstrap." };
  }

  const repoName = path.basename(cwd);
  const config = loadUserConfig(cwd, repoName);
  const desiredFiles = renderManagedFiles({ cwd, config });
  const currentLock = loadLock(cwd);
  const plan = planManagedChanges({ cwd, desiredFiles, currentLock });
  const localSeedPlan = planLocalClaudeSeed({ cwd });
  const stale = findStaleManagedFiles(cwd, desiredFiles, currentLock);

  const createOnlyResults = plan.results.filter((item) => item.action === "create");
  const createOnlyLockFiles = { ...(currentLock.files || {}) };
  for (const item of createOnlyResults) {
    createOnlyLockFiles[item.path] = { checksum: sha256(item.content), managed: true };
  }

  applyManagedChanges({ cwd, plan: { results: createOnlyResults, finalLockFiles: createOnlyLockFiles } });
  applyLocalClaudeSeed({ cwd, plan: localSeedPlan });
  const installedLines = replayInstalledCapabilities({ cwd, config });
  ensureGitignoreHasKyos({ cwd });

  const seedCreated = localSeedPlan.results.filter((item) => item.action === "create").length;
  const created = createOnlyResults.length + seedCreated + installedLines.length;
  const skipped = plan.results.filter(
    (item) => item.action === "update" || item.action === "conflict" || item.action === "blocked"
  ).length;

  const lines = plan.results
    .filter((item) => item.action !== "ok")
    .map((item) =>
      item.action === "create"
        ? `+ ${item.path}`
        : `~ ${item.path} (skipped, already exists)`
    );

  for (const item of localSeedPlan.results) {
    if (item.action === "create") {
      lines.push(`+ ${item.path}`);
    }
  }

  lines.push(...installedLines);

  for (const stalePath of stale) {
    lines.push(`! ${stalePath} (managed previously but no longer part of the current base set)`);
  }

  return {
    ok: true,
    summary: `apply complete: ${created} created, ${skipped} skipped.`,
    lines,
    warnings: stale.length > 0 ? ["Stale managed files were detected. Review them before removing anything."] : [],
  };
}

module.exports = {
  addCapability,
  runApply,
  runBootstrap,
  runDoctor,
  runUpdateKyos,
};
