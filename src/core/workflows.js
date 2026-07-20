const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { getCapability, loadCatalog } = require("./catalog");
const {
  CLAUDE_MD_FILE,
  CLAUDE_ROOT,
  CATALOG_DIR,
  FRAMEWORK_VERSION,
  LEGACY_USER_CONFIG_FILE,
  LOCK_FILE,
  MANAGED_ROOT,
  MCP_CONFIG_FILE,
  STATE_ROOT,
  USER_CONFIG_FILE,
} = require("./constants");
const {
  addInstalledCapability,
  auditHookEntries,
  dedupeMarkedHookEntry,
  ensureBaseHooks,
  hookMarker,
  hookMarkerWithPackage,
  installHookWiring,
  loadMcpConfig,
  loadUserConfig,
  refreshHookWiring,
  saveMcpConfig,
  saveUserConfig,
} = require("./config");
const { readJsonIfExists, resolveRepoPath, writeRepoTextFile } = require("./fs");
const { stableStringify } = require("./json");
const { sha256 } = require("./hash");
const {
  applyManagedChanges,
  findStaleManagedFiles,
  listCatalogMarkdown,
  listCatalogSkills,
  loadLock,
  planManagedChanges,
  readVersionStamp,
  renderManagedFiles,
  writeVersionStamp,
} = require("./managed-files");

function readCatalogSource(...pathSegmentsFromClaudeBase) {
  const absolutePath = path.join(CATALOG_DIR, "claude-base", "claude", ...pathSegmentsFromClaudeBase);
  if (!fs.existsSync(absolutePath)) return null;
  return fs.readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
}

// Wrappers copy the definition's frontmatter verbatim, or carry none when the definition has
// none. `model:`/`skills:` are functional configuration — inventing them in a wrapper silently
// overrides how the agent runs, which is how every repo got a product-manager pinned to haiku.
function readFrontmatterBlock(content) {
  if (!content || !content.startsWith("---\n")) return null;
  const close = content.indexOf("\n---\n", 3);
  if (close === -1) return null;
  return content.slice(0, close + 5);
}

// Title comes from the definition's own H1 so a wrapper can never misidentify what it wraps.
function readFirstHeading(content) {
  if (!content) return null;
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function loadManagedManifest() {
  // Same catalog listing the managed layer renders from, so wrappers and definitions cannot
  // drift apart. Agents are the exception: only those in registry baseline are seeded, the
  // rest are managed-only — see assertSeededAgentsHaveDefinitions for the guard on that.
  const commands = listCatalogMarkdown("commands");
  const skills = listCatalogSkills();
  const catalog = loadCatalog();
  const agents = ((catalog.baseline || {}).agents || []).map((name) => `${name}.md`);
  assertSeededAgentsHaveDefinitions(agents);
  return { commands, agents, skills };
}

// A seeded agent gets a .claude/ wrapper whose "Full definition" link points into the managed
// layer. If the catalog has no definition for it, that link dangles in every repo that runs
// --init. Fail loudly at bootstrap rather than shipping a broken wrapper.
function assertSeededAgentsHaveDefinitions(agents) {
  const available = new Set(listCatalogMarkdown("agents"));
  const missing = agents.filter((filename) => !available.has(filename));
  if (missing.length > 0) {
    throw new Error(
      `Seeded agents have no catalog definition: ${missing.join(", ")}. ` +
      `Add them under catalog/claude-base/claude/agents/, or remove them from baseline.agents ` +
      `in catalog/registry.json.`
    );
  }
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
  const targets = [CLAUDE_ROOT, ".kyos", CLAUDE_MD_FILE, USER_CONFIG_FILE];

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
  const source = readCatalogSource("agents", filename);
  const frontmatter = readFrontmatterBlock(source);
  const title = readFirstHeading(source) || filename.replace(/\.md$/i, "");

  return `${frontmatter ? `${frontmatter}\n` : ""}# ${title}

This agent is managed by kyos-cli.

- Full definition: [${rel}](${rel})

## How to use

Read the full definition file above and follow it as the source of truth.

## Local additions

Add any repo-specific guidance here.
`;
}

function managedSkillWrapper(relativePathFromSkillsRoot) {
  const rel = `../../../.kyos/claude/skills/${relativePathFromSkillsRoot}`;
  const source = readCatalogSource("skills", ...relativePathFromSkillsRoot.split("/"));
  const frontmatter = readFrontmatterBlock(source);
  const title = readFirstHeading(source) || relativePathFromSkillsRoot.split("/")[0];

  return `${frontmatter ? `${frontmatter}\n` : ""}# ${title}

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
      errors: ["The 'kyos-cli --apply' command is temporarily disabled pending revalidation."],
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
    ensureBaseHooks(cwd);
    writeVersionStamp(cwd, repoName);
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
      "# Local Agents\n\nPut repo-specific agents here. This folder is intentionally yours; kyos will not overwrite local agents.\n",
    [`${CLAUDE_ROOT}/skills/README.md`]:
      "# Local Skills\n\nPut repo-specific skills here. These are repo-owned instructions that complement the managed base under `.kyos/claude/`.\n",
    [`${CLAUDE_ROOT}/rules/README.md`]:
      "# Local Rules\n\nPut repo-specific working rules here (coding standards, review expectations, release rules, security notes).\n",
    [`${CLAUDE_ROOT}/settings.json`]: stableStringify({
      permissions: {
        defaultMode: "ask",
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
    results.push({
      action: "create",
      path: relativePath,
      content: managedSkillWrapper(relativePathFromSkillsRoot),
    });
  }

  return { results };
}

function runUpdateKyos({ cwd }) {
  const repoName = path.basename(cwd);

  forceResetKyosOnly({ cwd });

  const config = loadUserConfig(cwd, repoName);

  // Heal a pre-1.4 layout as part of the upgrade: move the gitignored
  // .kyos/config.json to the committable repo-root kyos.json. saveUserConfig drops
  // the legacy copy. Done here so users never run an extra migration command.
  const configLines = [];
  const hasNewConfig = Boolean(readJsonIfExists(resolveRepoPath(cwd, USER_CONFIG_FILE)));
  const hasLegacyConfig = Boolean(readJsonIfExists(resolveRepoPath(cwd, LEGACY_USER_CONFIG_FILE)));
  if (!hasNewConfig && hasLegacyConfig) {
    saveUserConfig(cwd, config);
    configLines.push(`~ config migrated ${LEGACY_USER_CONFIG_FILE} -> ${USER_CONFIG_FILE}`);
  }

  const desiredFiles = renderManagedFiles({ cwd, config });
  const kyosOnlyFiles = Object.fromEntries(
    Object.entries(desiredFiles).filter(([relativePath]) => relativePath === STATE_ROOT || relativePath.startsWith(`${STATE_ROOT}/`))
  );

  const currentLock = loadLock(cwd);
  const plan = planManagedChanges({ cwd, desiredFiles: kyosOnlyFiles, currentLock });
  applyManagedChanges({ cwd, plan });
  writeVersionStamp(cwd, repoName);
  ensureGitignoreHasKyos({ cwd });

  // Update-only: refresh the versions of already-wired managed hooks (and adopt a legacy
  // unmarked base-agent), but never append a hook that isn't already in settings.json.
  const hookLines = [];
  if (ensureBaseHooks(cwd, { adoptLegacy: true, updateOnly: true })) {
    hookLines.push(`~ hook:base-agent refreshed (kyos-cli@${FRAMEWORK_VERSION})`);
  }
  hookLines.push(...refreshInstalledHooks({ cwd, config, updateOnly: true }));

  const created = plan.results.filter((item) => item.action === "create").length;
  const updated = plan.results.filter((item) => item.action === "update").length;
  const conflicts = plan.results.filter((item) => item.action === "conflict").length;
  const blocked = plan.results.filter((item) => item.action === "blocked").length;

  const lines = plan.results.map((item) => {
    if (item.reason) {
      return `${symbolForAction(item.action)} ${item.path} (${item.reason})`;
    }
    return `${symbolForAction(item.action)} ${item.path}`;
  });
  lines.push(...configLines);
  lines.push(...hookLines);

  return {
    ok: conflicts === 0 && blocked === 0,
    summary: `update complete: ${created} created, ${updated} updated, ${conflicts} conflicts, ${blocked} blocked.`,
    lines,
    warnings: [
      "Rewrote .kyos/ to the current baseline. Local changes under .kyos/ were discarded.",
      `Refreshed existing managed hook wiring in .claude/settings.json to kyos-cli@${FRAMEWORK_VERSION}; no hooks were added.`,
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

function runDoctor({ cwd, fix = false }) {
  const warnings = [];
  const errors = [];
  const hookFixLines = [];
  const repoName = path.basename(cwd);
  const config = loadUserConfig(cwd, repoName);
  const currentLock = loadLock(cwd);
  const desiredFiles = renderManagedFiles({ cwd, config });
  const stale = findStaleManagedFiles(cwd, desiredFiles, currentLock);
  const hasExistingClaudeSetup = detectExistingClaudeSetup(cwd);

  const hasNewConfig = Boolean(readJsonIfExists(resolveRepoPath(cwd, USER_CONFIG_FILE)));
  const hasLegacyConfig = Boolean(readJsonIfExists(resolveRepoPath(cwd, LEGACY_USER_CONFIG_FILE)));

  if (!hasNewConfig && !hasLegacyConfig) {
    warnings.push(`${USER_CONFIG_FILE} is missing. Run 'npx kyos-cli --init' to create it.`);
  } else if (!hasNewConfig && hasLegacyConfig) {
    // Read-only report; the migration itself happens automatically during --update.
    warnings.push(
      `${LEGACY_USER_CONFIG_FILE} is gitignored and won't travel to other machines; run --update to migrate it to ${USER_CONFIG_FILE}.`
    );
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

  // Hook wiring audit (read-only): duplicates, version drift, unmarked shadows.
  const settings = readJsonIfExists(resolveRepoPath(cwd, MCP_CONFIG_FILE)) || {};
  const managedHooks = buildManagedHooks(config);
  const { duplicates, staleVersions, unmarkedShadows } = auditHookEntries(settings, {
    managedHooks,
    runningVersion: FRAMEWORK_VERSION,
  });

  for (const { name, event, count, versions } of duplicates) {
    const rendered = versions.map((v) => v || "unversioned").join(", ");
    warnings.push(
      `hook '${name}' (${event}) has ${count} kyos-owned entries [versions: ${rendered}]; run --doctor --fix to collapse.`
    );
  }
  for (const { name, version } of staleVersions) {
    warnings.push(
      `hook '${name}' marker is kyos-cli@${version || "unversioned"}; running ${FRAMEWORK_VERSION}. Run --apply or --update to refresh.`
    );
  }
  for (const { name, event } of unmarkedShadows) {
    warnings.push(
      `hook '${name}' (${event}) has an unmarked entry alongside the managed one; review manually (kyos will not edit it).`
    );
  }

  // --fix: collapse duplicate kyos-owned entries only (never version-pulls a lone entry,
  // never touches unmarked entries). Writes settings.json once.
  if (fix && duplicates.length > 0) {
    let nextSettings = settings;
    for (const { name, event } of duplicates) {
      const result = dedupeMarkedHookEntry(nextSettings, event, { name, marker: hookMarker(name) });
      if (!result) continue;
      nextSettings = result.settings;
      hookFixLines.push(
        `~ hook:${name} collapsed ${result.count} -> 1 (kept kyos-cli@${result.version || "unversioned"})`
      );
    }
    if (hookFixLines.length > 0) {
      writeRepoTextFile(cwd, MCP_CONFIG_FILE, stableStringify(nextSettings));
    }
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
      `installed hooks: ${(config.installed.hooks || []).length}`,
      ...commandReport,
      ...hookFixLines,
    ],
    warnings,
    errors,
  };
}

function pickRuntime(runtimes) {
  for (const runtime of runtimes) {
    const [cmd, ...args] = runtime.probe;
    try {
      const result = spawnSync(cmd, args, { stdio: "ignore", timeout: 5000 });
      if (!result.error && result.status === 0) return runtime;
    } catch {
      // probe failed, try next
    }
  }
  return runtimes[runtimes.length - 1];
}

// ${CLAUDE_PROJECT_DIR} is expanded by Claude Code before the command is spawned,
// so the wired entry stays machine-independent. The trailing shell comment marks
// the entry as kyos-owned (both documented hook shells, bash and powershell,
// treat # as a comment).
function buildHookCommand(runtime, scriptRelativePath, name) {
  const portable = runtime.command.replace("{scriptPath}", `\${CLAUDE_PROJECT_DIR}/${scriptRelativePath}`);
  return `${portable} # ${hookMarkerWithPackage(name)}`;
}

function writeHookScript(cwd, name, runtime, scriptRelativePath) {
  const catalogScriptPath = path.join(CATALOG_DIR, "hooks", name, runtime.script);
  const scriptContent = fs.readFileSync(catalogScriptPath, "utf8");
  writeRepoTextFile(cwd, scriptRelativePath, scriptContent);
}

function installHook({ cwd, name, capability }) {
  const runtime = pickRuntime(capability.runtimes);
  const scriptRelativePath = `${capability.installDir}/${runtime.script}`;
  writeHookScript(cwd, name, runtime, scriptRelativePath);
  const command = buildHookCommand(runtime, scriptRelativePath, name);
  const wiring = installHookWiring(cwd, {
    event: capability.event,
    matcher: capability.matcher,
    command,
    marker: hookMarker(name),
  });
  return { runtime, command, wiring };
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

    const pluginId = capability.pluginId || name;
    const mcpConfig = loadMcpConfig(cwd);
    mcpConfig.enabledPlugins = mcpConfig.enabledPlugins || {};
    mcpConfig.enabledPlugins[pluginId] = true;
    saveMcpConfig(cwd, mcpConfig);
    addInstalledCapability(config, "mcps", name);
    saveUserConfig(cwd, config);

    return {
      ok: true,
      summary: `registered mcp '${name}' in ${MCP_CONFIG_FILE}`,
      lines: capability.notes ? capability.notes.map((line) => `- ${line}`) : [],
    };
  }

  if (normalizedType === "hook") {
    if (!capability) {
      return {
        ok: false,
        errors: [`Unknown hook '${name}'. Add it to catalog/registry.json first.`],
      };
    }

    const { runtime } = installHook({ cwd, name, capability });
    addInstalledCapability(config, "hooks", name);
    saveUserConfig(cwd, config);

    return {
      ok: true,
      summary: `installed hook '${name}' using ${runtime.name}`,
      lines: capability.notes ? capability.notes.map((line) => `- ${line}`) : [],
    };
  }

  // --add installs what the package already ships. It has no repo context, so it cannot
  // describe a capability it has never seen — inventing one is how no-op descriptions got
  // into repos. Authoring something repo-specific is /hire's job.
  if (!capability) {
    return {
      ok: false,
      errors: [
        `Unknown ${normalizedType} '${name}'. Add it to catalog/registry.json first, ` +
        `or use /hire to author a repo-specific ${normalizedType}.`,
      ],
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
  if (type === "skill" || type === "agent" || type === "mcp" || type === "hook") {
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
  // Callers resolve `capability` from the catalog before reaching here, so the description
  // is always the real one. Never invent a description for a name the package does not ship.
  const description = capability.description;

  if (type === "skill") {
    const frontmatterName = normalizeSkillFrontmatterName(name);
    const safeName = frontmatterName || "custom-skill";
    return `---\nname: ${safeName}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n\n## Purpose\n\nAdd repo-specific notes below to extend the catalog behavior.\n\n## Instructions\n\n- Keep additions repo-specific and actionable.\n`;
  }

  const title = `${type[0].toUpperCase()}${type.slice(1)} Override: ${name}`;
  return `# ${title}

${description}

## Purpose

Add repo-specific notes below to extend the catalog behavior.

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

// Re-wire the catalog hooks recorded in config. `updateOnly: false` (the --apply/replay
// path) creates the script + appends the entry when missing; `updateOnly: true` (the
// --update path) only refreshes an already-wired marked entry and never appends.
function refreshInstalledHooks({ cwd, config, updateOnly }) {
  const catalog = loadCatalog();
  const lines = [];

  for (const name of (config.installed.hooks || [])) {
    const capability = getCapability(catalog, "hook", name);
    if (!capability) continue;

    const runtime = pickRuntime(capability.runtimes);
    const scriptRelativePath = `${capability.installDir}/${runtime.script}`;
    const command = buildHookCommand(runtime, scriptRelativePath, name);

    if (updateOnly) {
      const wiring = refreshHookWiring(cwd, {
        event: capability.event,
        matcher: capability.matcher,
        command,
        marker: hookMarker(name),
      });
      if (wiring.action === "updated") {
        lines.push(`~ hook:${name} refreshed (kyos-cli@${FRAMEWORK_VERSION})`);
      }
      continue;
    }

    const scriptMissing = !fs.existsSync(resolveRepoPath(cwd, scriptRelativePath));
    if (scriptMissing) {
      writeHookScript(cwd, name, runtime, scriptRelativePath);
    }
    const wiring = installHookWiring(cwd, {
      event: capability.event,
      matcher: capability.matcher,
      command,
      marker: hookMarker(name),
    });

    if (wiring.action === "updated") {
      lines.push(`~ hook:${name} rewired (portable)`);
    } else if (scriptMissing || wiring.action === "added") {
      lines.push(`+ hook:${name}`);
    }
  }

  return lines;
}

// The set of hooks this repo manages: base-agent (always) plus each installed catalog
// hook, resolved to its event/matcher. Used by the doctor audit.
function buildManagedHooks(config) {
  const catalog = loadCatalog();
  const managedHooks = [{ name: "base-agent", event: "PostToolUse", matcher: "Agent" }];
  for (const name of (config.installed.hooks || [])) {
    const capability = getCapability(catalog, "hook", name);
    if (!capability) continue;
    managedHooks.push({ name, event: capability.event, matcher: capability.matcher });
  }
  return managedHooks;
}

function replayInstalledCapabilities({ cwd, config }) {
  const catalog = loadCatalog();
  const lines = [];

  // A recorded capability with no catalog entry is an orphan: either it predates a registry
  // change, or it was authored locally and later deleted. We cannot regenerate it faithfully,
  // so report it rather than fabricating a stub with an invented description.
  for (const [key, type, targetFor] of [
    ["skills", "skill", (name) => `${CLAUDE_ROOT}/skills/${name}/SKILL.md`],
    ["agents", "agent", (name) => `${CLAUDE_ROOT}/agents/${name}.md`],
  ]) {
    for (const name of (config.installed[key] || [])) {
      const targetPath = targetFor(name);
      if (fs.existsSync(resolveRepoPath(cwd, targetPath))) continue;

      const capability = getCapability(catalog, type, name);
      if (!capability) {
        lines.push(`! ${targetPath} is missing and '${name}' is not in the catalog — restore the file or remove it from ${USER_CONFIG_FILE}`);
        continue;
      }

      writeRepoTextFile(cwd, targetPath, createOverrideTemplate({ type, name, capability }));
      lines.push(`+ ${targetPath}`);
    }
  }

  lines.push(...refreshInstalledHooks({ cwd, config, updateOnly: false }));

  const mcpNames = config.installed.mcps || [];
  if (mcpNames.length > 0) {
    const mcpConfig = loadMcpConfig(cwd);
    let changed = false;
    for (const name of mcpNames) {
      const capability = getCapability(catalog, "mcp", name);
      const pluginId = (capability && capability.pluginId) || name;
      if (!mcpConfig.enabledPlugins[pluginId]) {
        if (capability) {
          mcpConfig.enabledPlugins[pluginId] = true;
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

  // A pre-stamp release wrote no version.json. Detect that before writeVersionStamp
  // overwrites it, so we can warn the user to audit hooks for orphaned entries that
  // older kyos versions may have left behind (we no longer migrate them in place).
  const priorStamp = readVersionStamp(cwd);
  const fromUnknownVersion = !priorStamp || !priorStamp.version;

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
  ensureBaseHooks(cwd);
  writeVersionStamp(cwd, repoName);
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

  const warnings = [];
  if (stale.length > 0) {
    warnings.push("Stale managed files were detected. Review them before removing anything.");
  }
  if (fromUnknownVersion) {
    warnings.push(
      "This installation was last written by an unknown kyos version. Review the hooks " +
      "in .claude/settings.json and remove any orphaned entries (e.g. stale or duplicate " +
      "hook commands) that older versions may have left behind."
    );
  }

  return {
    ok: true,
    summary: `apply complete: ${created} created, ${skipped} skipped.`,
    lines,
    warnings,
  };
}

module.exports = {
  addCapability,
  assertSeededAgentsHaveDefinitions,
  managedAgentWrapper,
  managedSkillWrapper,
  runApply,
  runBootstrap,
  runDoctor,
  runUpdateKyos,
};
