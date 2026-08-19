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
  listCatalogSkillSupportingFiles,
  loadLock,
  planManagedChanges,
  readCatalogText,
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
  const skills = listCatalogSkills();
  const catalog = loadCatalog();
  const agents = ((catalog.baseline || {}).agents || []).map((name) => `${name}.md`);
  assertSeededAgentsHaveDefinitions(agents);
  return { agents, skills };
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
    [`${CLAUDE_ROOT}/agents/README.md`]:
      "# Local Agents\n\nPut repo-specific agents here. This folder is intentionally yours; kyos will not overwrite local agents.\n",
    [`${CLAUDE_ROOT}/skills/README.md`]:
      "# Local Skills\n\nPut repo-specific skills here. These are repo-owned instructions that complement the managed base under `.kyos/claude/`.\n",
    [`${CLAUDE_ROOT}/rules/README.md`]:
      "# Local Rules\n\nPut repo-specific working rules here (coding standards, review expectations, release rules, security notes).\n",
    [`${CLAUDE_ROOT}/settings.json`]: stableStringify({
      permissions: {
        defaultMode: "default",
      },
    }),
    [`${CLAUDE_ROOT}/commands/README.md`]:
      "# Local Commands\n\nThis folder is for repo-owned workflow prompts (slash-style commands). The built-in " +
      "`spec -> tech -> tasks -> implement -> verify` flow ships as skills instead (see `.claude/skills/`), " +
      "invoked by their bare name (e.g. `/spec`).\n\nIf you’re new to the repo or about to run tooling/scripts, start with the `prevalidate` skill.\n\n" +
      "To install a third-party skill via `npx skills add`, pass `--copy` so the install lands as a real file " +
      "kyos-cli won't collide with, rather than a symlink.\n",
    [`${CLAUDE_ROOT}/skill-overrides/README.md`]:
      "# Skill overrides\n\nFiles in this folder customize kyos skills without editing the skills themselves, so your\n" +
      "changes survive both `kyos-cli --update` and `npx skills update`.\n\n" +
      "- `_shared.md` — preferences and project context several skills read (repo architecture, where\n" +
      "  spec/tech/tasks/implement/verify save their artifacts, etc). Also the one file guaranteed to\n" +
      "  exist regardless of whether this repo was set up via kyos-cli or a bare `npx skills add`\n" +
      "  install, so it's the right place for anything every skill should be able to read.\n" +
      "- `<skill-name>.md` — tweaks for one skill only. Wins over `_shared.md` on conflict.\n\n" +
      "Run the `kyos-setup` skill to be walked through the common ones, or hand-edit these files directly.\n",
    [`${CLAUDE_ROOT}/skill-overrides/_shared.md`]:
      "# Shared skill preferences\n\n" +
      "Preferences and project context several kyos skills read. Fill in what applies; leave the rest.\n\n" +
      "## Project context\n\n" +
      "Capture architecture, key components, and testing guidance for this repository here.\n\n" +
      "- What are we building?\n" +
      "- What are the main components (UI/API/workers)?\n" +
      "- What are the key external dependencies?\n" +
      "- How do we run tests and validate changes?\n\n" +
      "<!--\n" +
      "## Execution artifact location\n\nDefault: `docs/execution/<slug>/`\n\n" +
      "## Cleanup after verify\n\nDelete the completed execution folder after `verify` passes, or keep it as a durable record?\n\n" +
      "## Slug convention\n\ne.g. always prefer a tracked issue key.\n" +
      "-->\n",
  };

  const manifest = loadManagedManifest();

  const results = [];
  for (const [relativePath, content] of Object.entries(seedFiles)) {
    const absolutePath = resolveRepoPath(cwd, relativePath);
    if (fs.existsSync(absolutePath)) {
      results.push({ action: "ok", path: relativePath });
      continue;
    }
    results.push({ action: "create", path: relativePath, content });
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

  for (const relativePathFromSkillsRoot of manifest.skills) {
    const skillName = relativePathFromSkillsRoot.split("/")[0];
    for (const supportingPath of listCatalogSkillSupportingFiles(skillName)) {
      const relativePath = `${CLAUDE_ROOT}/skills/${skillName}/${supportingPath}`;
      const absolutePath = resolveRepoPath(cwd, relativePath);
      if (fs.existsSync(absolutePath)) {
        results.push({ action: "ok", path: relativePath });
        continue;
      }
      results.push({
        action: "create",
        path: relativePath,
        content: readCatalogText(`claude-base/claude/skills/${skillName}/${supportingPath}`),
      });
    }
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
