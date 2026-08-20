const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  runApply,
  runBootstrap,
  runDoctor,
  runUpdateKyos,
  addCapability,
  assertSeededAgentsHaveDefinitions,
  managedAgentWrapper,
  managedSkillWrapper,
} = require("../src/core/workflows");
const { listCatalogMarkdown, listCatalogSkills, listCatalogSkillSupportingFiles } = require("../src/core/managed-files");
const {
  ensureBaseHooks,
  parseOwnedHookName,
  parsePackageVersion,
  compareHookVersions,
  auditHookEntries,
  dedupeMarkedHookEntry,
} = require("../src/core/config");
const { version: PKG_VERSION } = require("../package.json");

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function exists(dir, relativePath) {
  return fs.existsSync(path.join(dir, ...relativePath.split("/")));
}

module.exports = function register(test) {
  test("bootstrap creates .kyos and .claude in a fresh repo", () => {
    const cwd = mkTempDir("kyos-flow-");
    fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");
    const result = runBootstrap({ cwd, apply: false });

    assert.equal(result.ok, true);
    assert.ok(exists(cwd, "kyos.json"));
    assert.ok(exists(cwd, ".kyos/lock.json"));
    assert.ok(exists(cwd, ".claude/settings.json"));
    assert.ok(exists(cwd, ".kyos/claude/rules/README.md"));
    assert.ok(exists(cwd, "CLAUDE.md"));

    assert.ok(exists(cwd, ".kyos/claude/agents/README.md"));
    assert.ok(exists(cwd, ".kyos/claude/skills/silent-execution/SKILL.md"));
    assert.ok(exists(cwd, ".kyos/claude/skills/tech/SKILL.md"));

    assert.ok(exists(cwd, ".claude/commands/README.md"));
    assert.ok(!exists(cwd, ".claude/commands/spec.md"));
    assert.ok(!exists(cwd, ".kyos/claude/commands"));
    for (const name of ["spec", "tech", "tasks", "implement", "verify", "prevalidate", "architecture", "hire"]) {
      assert.ok(!exists(cwd, `.kyos/claude/commands/${name}.md`));
    }

    assert.ok(exists(cwd, ".claude/skills/tech/SKILL.md"));
    assert.ok(exists(cwd, ".claude/skills/tech/agents/openai.yaml"));

    const managedTech = fs.readFileSync(path.join(cwd, ".kyos", "claude", "skills", "tech", "SKILL.md"), "utf8");
    const localTech = fs.readFileSync(path.join(cwd, ".claude", "skills", "tech", "SKILL.md"), "utf8");
    assert.ok(localTech.includes("../../../.kyos/claude/skills/tech/SKILL.md"));
    assert.ok(managedTech.includes("disable-model-invocation: true"));
    assert.ok(localTech.includes("disable-model-invocation: true"));
    assert.ok(localTech.length < managedTech.length);

    const managedSidecar = fs.readFileSync(
      path.join(cwd, ".kyos", "claude", "skills", "tech", "agents", "openai.yaml"),
      "utf8"
    );
    const localSidecar = fs.readFileSync(path.join(cwd, ".claude", "skills", "tech", "agents", "openai.yaml"), "utf8");
    assert.equal(localSidecar, managedSidecar);

    const catalogTech = fs.readFileSync(
      path.join(__dirname, "..", "catalog", "claude-base", "claude", "skills", "tech", "SKILL.md"),
      "utf8"
    );
    assert.equal(managedTech, catalogTech);
    assert.ok(exists(cwd, ".claude/agents/README.md"));
    assert.ok(exists(cwd, ".claude/rules/README.md"));
    assert.ok(exists(cwd, ".claude/skills/README.md"));
    assert.ok(exists(cwd, ".claude/skills/silent-execution/SKILL.md"));
    assert.ok(exists(cwd, ".claude/skill-overrides/README.md"));
    assert.ok(exists(cwd, ".claude/skill-overrides/_shared.md"));

    const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    assert.ok(gitignore.includes("node_modules/"));
    assert.ok(gitignore.includes(".kyos/claude/"));
  });

  test("bootstrap seeds settings.json with PostToolUse Agent hook", () => {
    const cwd = mkTempDir("kyos-settings-hooks-");
    runBootstrap({ cwd, apply: false });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    assert.ok(Array.isArray(settings.hooks?.PostToolUse), "hooks.PostToolUse must be an array");
    const agentMatcher = settings.hooks.PostToolUse.find((h) => h.matcher === "Agent");
    assert.ok(agentMatcher, "must have a PostToolUse entry with matcher 'Agent'");
    assert.ok(Array.isArray(agentMatcher.hooks) && agentMatcher.hooks.length > 0, "Agent matcher must have hooks");
    assert.equal(agentMatcher.hooks[0].type, "command");
  });

  test("bootstrap (analysis mode) does not touch settings.json when Claude setup already exists", () => {
    const cwd = mkTempDir("kyos-settings-no-overwrite-");
    const settingsPath = path.join(cwd, ".claude");
    fs.mkdirSync(settingsPath, { recursive: true });
    // plant enough structure so detectExistingClaudeSetup returns true
    fs.mkdirSync(path.join(cwd, ".kyos"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "kyos.json"), JSON.stringify({}), "utf8");
    const existing = {
      permissions: { defaultMode: "allow" },
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] }] },
    };
    const before = JSON.stringify(existing);
    fs.writeFileSync(path.join(settingsPath, "settings.json"), before, "utf8");

    runBootstrap({ cwd, apply: false });

    const after = fs.readFileSync(path.join(settingsPath, "settings.json"), "utf8");
    assert.equal(after, before, "settings.json must be byte-for-byte unchanged in analysis mode");
  });

  test("--apply merges base Agent hook into existing settings.json, preserving other hooks", () => {
    const cwd = mkTempDir("kyos-apply-merge-hooks-");
    runBootstrap({ cwd, apply: false });

    // Simulate a user who already has their own PostToolUse hook (no Agent entry yet)
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const existing = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    existing.hooks = { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] }] };
    fs.writeFileSync(settingsPath, JSON.stringify(existing), "utf8");

    runApply({ cwd });

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(settings.permissions.defaultMode, "default", "original permissions must be preserved");
    const postToolUse = settings.hooks.PostToolUse;
    assert.ok(postToolUse.some((h) => h.matcher === "Bash"), "user's Bash hook must be preserved");
    assert.ok(postToolUse.some((h) => h.matcher === "Agent"), "Agent hook must be merged in");
  });

  test("--apply does not duplicate the Agent hook when already present", () => {
    const cwd = mkTempDir("kyos-apply-hooks-idempotent-");
    runBootstrap({ cwd, apply: false });

    runApply({ cwd });
    runApply({ cwd });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    const agentHooks = settings.hooks.PostToolUse.filter((h) => h.matcher === "Agent");
    assert.equal(agentHooks.length, 1, "Agent hook must appear exactly once after multiple applies");
  });

  test("ensureBaseHooks appends Agent hook alongside existing user hooks without removing them", () => {
    const cwd = mkTempDir("kyos-ensure-hooks-merge-");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };
    const initial = { permissions: { defaultMode: "allow" }, hooks: { PostToolUse: [userHook] } };
    fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify(initial), "utf8");

    const changed = ensureBaseHooks(cwd);

    assert.equal(changed, true, "should report a change was made");
    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.permissions.defaultMode, "allow", "other top-level keys must be preserved");
    const postToolUse = settings.hooks.PostToolUse;
    assert.equal(postToolUse.length, 2, "both hooks must be present");
    assert.ok(postToolUse.some((h) => h.matcher === "Bash"), "user Bash hook must be preserved");
    assert.ok(postToolUse.some((h) => h.matcher === "Agent"), "Agent hook must be added");
  });

  test("ensureBaseHooks is idempotent when Agent hook is already present", () => {
    const cwd = mkTempDir("kyos-ensure-hooks-noop-");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    const agentHook = { matcher: "Agent", hooks: [{ type: "command", command: "echo existing" }] };
    const initial = { hooks: { PostToolUse: [agentHook] } };
    const before = JSON.stringify(initial);
    fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), before, "utf8");

    const changed = ensureBaseHooks(cwd);

    assert.equal(changed, false, "should report no change was made");
    const after = fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8");
    assert.equal(after, before, "file must be byte-for-byte unchanged");
  });

  test("bootstrap creates .gitignore with .kyos/claude/ when missing", () => {
    const cwd = mkTempDir("kyos-gitignore-missing-");

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);

    const gitignorePath = path.join(cwd, ".gitignore");
    assert.ok(fs.existsSync(gitignorePath));

    const gitignore = fs.readFileSync(gitignorePath, "utf8");
    assert.ok(gitignore.includes(".kyos/claude/"));
  });

  test("bootstrap appends .kyos/claude/ to an existing .gitignore", () => {
    const cwd = mkTempDir("kyos-gitignore-existing-");
    fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);

    const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    assert.ok(gitignore.includes("node_modules/"));

    const lines = gitignore.replace(/\r\n/g, "\n").split("\n");
    const kyosCount = lines.filter((line) => {
      const trimmed = line.trim();
      return trimmed === ".kyos/claude" || trimmed === ".kyos/claude/";
    }).length;

    assert.equal(kyosCount, 1);
  });

  test("init switches to analysis mode once Claude setup exists", () => {
    const cwd = mkTempDir("kyos-flow-");
    runBootstrap({ cwd, apply: false });

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.warnings));
    assert.ok(result.warnings.some((w) => String(w).toLowerCase().includes("no files were changed")));
    assert.ok(result.warnings.some((w) => String(w).toLowerCase().includes("no changes detected")));
  });

  test("analysis warning mentions force when safe updates exist", () => {
    const cwd = mkTempDir("kyos-flow-");
    runBootstrap({ cwd, apply: false });

    fs.rmSync(path.join(cwd, ".kyos", "claude", "skills", "tech", "SKILL.md"));

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => String(w).toLowerCase().includes("--force")));
  });

  test("doctor is ok after bootstrap", () => {
    const cwd = mkTempDir("kyos-flow-");
    runBootstrap({ cwd, apply: false });

    const doctor = runDoctor({ cwd });
    assert.equal(doctor.ok, true);
  });

  test("doctor reports when a managed file's checksum drifts", () => {
    const cwd = mkTempDir("kyos-flow-");
    runBootstrap({ cwd, apply: false });

    const managedTechPath = path.join(cwd, ".kyos", "claude", "skills", "tech", "SKILL.md");
    const original = fs.readFileSync(managedTechPath, "utf8");
    fs.writeFileSync(managedTechPath, `${original}\ncustom note\n`, "utf8");

    const doctor = runDoctor({ cwd });
    assert.equal(doctor.ok, true);
    assert.ok(
      doctor.warnings.some((w) => String(w).includes(".kyos/claude/skills/tech/SKILL.md") && String(w).includes("differs"))
    );
  });

  test("--force resets .claude/.kyos/CLAUDE.md", () => {
    const cwd = mkTempDir("kyos-force-");
    runBootstrap({ cwd, apply: false });

    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "# custom\n", "utf8");
    fs.mkdirSync(path.join(cwd, ".claude", "skills", "tech"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "skills", "tech", "SKILL.md"), "# custom tech\n", "utf8");
    fs.mkdirSync(path.join(cwd, ".claude", "commands", "extra"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "commands", "extra", "note.md"), "hello", "utf8");

    const result = runBootstrap({ cwd, apply: false, force: true });
    assert.equal(result.ok, true);

    const resetClaude = fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8");
    assert.ok(resetClaude.includes("kyos-cli"));
    assert.notEqual(resetClaude, "# custom\n");

    assert.equal(exists(cwd, ".claude/commands/extra/note.md"), false);

    const localTech = fs.readFileSync(path.join(cwd, ".claude", "skills", "tech", "SKILL.md"), "utf8");
    assert.ok(localTech.includes("../../../.kyos/claude/skills/tech/SKILL.md"));

    assert.ok(exists(cwd, ".kyos/claude/skills/tech/SKILL.md"));
  });

  test("--update rewrites only .kyos", () => {
    const cwd = mkTempDir("kyos-update-");
    runBootstrap({ cwd, apply: false });

    const localTechPath = path.join(cwd, ".claude", "skills", "tech", "SKILL.md");
    fs.writeFileSync(localTechPath, "# custom tech\n", "utf8");

    const managedTechPath = path.join(cwd, ".kyos", "claude", "skills", "tech", "SKILL.md");
    fs.writeFileSync(managedTechPath, "# tampered managed tech\n", "utf8");

    const result = runUpdateKyos({ cwd });
    assert.equal(result.ok, true);

    // .claude should be untouched
    assert.equal(fs.readFileSync(localTechPath, "utf8"), "# custom tech\n");

    // .kyos should be regenerated to catalog baseline
    const catalogTech = fs.readFileSync(
      path.join(__dirname, "..", "catalog", "claude-base", "claude", "skills", "tech", "SKILL.md"),
      "utf8"
    );
    assert.equal(fs.readFileSync(managedTechPath, "utf8"), catalogTech);

    // kyos.json lives at the repo root, outside .kyos, so --update never touches it
    assert.ok(exists(cwd, "kyos.json"), "kyos.json should not be deleted by --update");
  });

  test("--update preserves user config across reset", () => {
    const cwd = mkTempDir("kyos-update-config-");
    runBootstrap({ cwd, apply: false });

    // Add a capability so config.json has non-default content
    addCapability({ cwd, type: "skill", name: "critic" });

    const configPath = path.join(cwd, "kyos.json");
    const configBefore = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.ok(configBefore.installed.skills.includes("critic"));

    runUpdateKyos({ cwd });

    const configAfter = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(configAfter, configBefore, "config.json must be identical after --update");
  });

  test(".claude skill wrappers are not overwritten if customized", () => {
    const cwd = mkTempDir("kyos-flow-");
    runBootstrap({ cwd, apply: false });

    const localTechPath = path.join(cwd, ".claude", "skills", "tech", "SKILL.md");
    fs.writeFileSync(localTechPath, "# custom tech\n", "utf8");

    runBootstrap({ cwd, apply: true });

    const after = fs.readFileSync(localTechPath, "utf8");
    assert.equal(after, "# custom tech\n");
  });

  test("capability name validation blocks traversal-style input", () => {
    const cwd = mkTempDir("kyos-flow-");
    runBootstrap({ cwd, apply: false });

    const bad = addCapability({ cwd, type: "skill", name: "..\\..\\pwned" });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors && bad.errors.length > 0);
  });

  test("add skill creates a local stub under .claude", () => {
    const cwd = mkTempDir("kyos-flow-");
    runBootstrap({ cwd, apply: false });

    const result = addCapability({ cwd, type: "skill", name: "critic" });
    assert.equal(result.ok, true);
    assert.ok(exists(cwd, ".claude/skills/critic/SKILL.md"));
  });

  test("--apply on a fresh dir with no Claude setup returns info and does nothing", () => {
    const cwd = mkTempDir("kyos-apply-fresh-");
    const result = runApply({ cwd });
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes("Nothing to apply"));
    assert.equal(exists(cwd, "CLAUDE.md"), false);
    assert.equal(exists(cwd, ".kyos"), false);
  });

  test("--apply after bootstrap creates nothing (all files already exist)", () => {
    const cwd = mkTempDir("kyos-apply-noop-");
    runBootstrap({ cwd, apply: false });

    const result = runApply({ cwd });
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes("0 created"));
  });

  test("--apply creates a missing managed file without touching other files", () => {
    const cwd = mkTempDir("kyos-apply-missing-");
    runBootstrap({ cwd, apply: false });

    const techPath = path.join(cwd, ".kyos", "claude", "skills", "tech", "SKILL.md");
    const originalTech = fs.readFileSync(techPath, "utf8");
    fs.rmSync(techPath);

    const localTechPath = path.join(cwd, ".claude", "skills", "tech", "SKILL.md");
    fs.writeFileSync(localTechPath, "# custom tech\n", "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes("1 created"));

    assert.ok(exists(cwd, ".kyos/claude/skills/tech/SKILL.md"));
    assert.equal(fs.readFileSync(techPath, "utf8"), originalTech);

    assert.equal(fs.readFileSync(localTechPath, "utf8"), "# custom tech\n");
  });

  test("--apply skips files that already exist on disk", () => {
    const cwd = mkTempDir("kyos-apply-skip-");
    runBootstrap({ cwd, apply: false });

    const claudeMdPath = path.join(cwd, "CLAUDE.md");
    fs.writeFileSync(claudeMdPath, "# custom\n", "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);

    assert.equal(fs.readFileSync(claudeMdPath, "utf8"), "# custom\n");
  });

  test("--apply updates the lock file for files it writes", () => {
    const cwd = mkTempDir("kyos-apply-lock-");
    runBootstrap({ cwd, apply: false });

    const techPath = path.join(cwd, ".kyos", "claude", "skills", "tech", "SKILL.md");
    fs.rmSync(techPath);

    const lockBefore = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "lock.json"), "utf8"));
    const techKey = ".kyos/claude/skills/tech/SKILL.md";
    delete lockBefore.files[techKey];
    fs.writeFileSync(path.join(cwd, ".kyos", "lock.json"), JSON.stringify(lockBefore), "utf8");

    runApply({ cwd });

    const lockAfter = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "lock.json"), "utf8"));
    assert.ok(lockAfter.files[techKey], "lock should have an entry for the created file");
    assert.ok(lockAfter.files[techKey].checksum, "lock entry should have a checksum");
  });

  test("analysis warning mentions --apply when safe creates exist", () => {
    const cwd = mkTempDir("kyos-apply-warning-");
    runBootstrap({ cwd, apply: false });

    fs.rmSync(path.join(cwd, ".kyos", "claude", "skills", "tech", "SKILL.md"));

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => String(w).includes("--apply")));
    assert.ok(result.warnings.some((w) => String(w).includes("--force")));
  });

  test("refuses to write through a symlink/junction parent (when supported)", (t) => {
    const cwd = mkTempDir("kyos-symlink-");
    const outside = mkTempDir("kyos-outside-");

    fs.mkdirSync(path.join(cwd, ".kyos"), { recursive: true });

    const linkPath = path.join(cwd, ".kyos", "claude");
    try {
      fs.symlinkSync(outside, linkPath, "junction");
    } catch (error) {
      t.skip(`symlink/junction not supported: ${String(error && error.message)}`);
      return;
    }

    assert.throws(() => runBootstrap({ cwd, apply: false }), /symlink|junction|outside repo root/i);
    assert.equal(exists(outside, "commands/README.md"), false);
    assert.equal(exists(outside, "settings.json"), false);
  });

  test("conflict detected when a managed file has been locally edited", () => {
    const cwd = mkTempDir("kyos-conflict-");
    runBootstrap({ cwd, apply: false });

    const managedTechPath = path.join(cwd, ".kyos", "claude", "skills", "tech", "SKILL.md");
    fs.writeFileSync(managedTechPath, "# custom edit\n", "utf8");

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes("1 managed conflicts"), `expected conflict in summary: ${result.summary}`);
    assert.ok(result.lines.some((line) => String(line).includes("tech/SKILL.md") && String(line).includes("local changes")));
  });

  test("blocked detected when an unmanaged file occupies a managed path", () => {
    const cwd = mkTempDir("kyos-blocked-");
    runBootstrap({ cwd, apply: false });

    const lockPath = path.join(cwd, ".kyos", "lock.json");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const managedKey = ".kyos/claude/skills/tech/SKILL.md";
    delete lock.files[managedKey];
    fs.writeFileSync(lockPath, JSON.stringify(lock), "utf8");

    const techPath = path.join(cwd, ".kyos", "claude", "skills", "tech", "SKILL.md");
    fs.writeFileSync(techPath, "# unmanaged content\n", "utf8");

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes("1 unmanaged blockers"), `expected blocker in summary: ${result.summary}`);
    assert.ok(result.lines.some((line) => String(line).includes("tech/SKILL.md")));
  });

  test("add rejects a skill or agent the package does not ship", () => {
    const cwd = mkTempDir("kyos-add-unknown-");
    runBootstrap({ cwd, apply: false });

    for (const type of ["skill", "agent"]) {
      const result = addCapability({ cwd, type, name: "not-in-the-catalog" });
      assert.equal(result.ok, false, `--add ${type} must reject an unknown name`);
      assert.ok(result.errors.some((e) => e.includes("catalog/registry.json")), "error should point at the registry");
      assert.equal(exists(cwd, `.claude/agents/not-in-the-catalog.md`), false);
      assert.equal(exists(cwd, `.claude/skills/not-in-the-catalog/SKILL.md`), false);
    }

    const config = JSON.parse(fs.readFileSync(path.join(cwd, "kyos.json"), "utf8"));
    assert.ok(!(config.installed.agents || []).includes("not-in-the-catalog"));
    assert.ok(!(config.installed.skills || []).includes("not-in-the-catalog"));
  });

  test("wrappers take their title from the definition they wrap", () => {
    const catalogRoot = path.join(__dirname, "..", "catalog", "claude-base", "claude");
    const headingOf = (abs) => {
      const body = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
      return body.match(/^#\s+(.+)$/m)[1].trim();
    };

    for (const relativePath of listCatalogSkills()) {
      const wrapper = managedSkillWrapper(relativePath);
      const expected = headingOf(path.join(catalogRoot, "skills", ...relativePath.split("/")));
      assert.ok(
        wrapper.includes(`# ${expected}\n`),
        `skill wrapper for ${relativePath} should be titled "${expected}", got: ${wrapper.split("\n").find((l) => l.startsWith("# "))}`
      );
    }

    for (const filename of listCatalogMarkdown("agents")) {
      const wrapper = managedAgentWrapper(filename);
      const expected = headingOf(path.join(catalogRoot, "agents", filename));
      assert.ok(wrapper.includes(`# ${expected}\n`), `agent wrapper for ${filename} should be titled "${expected}"`);
    }
  });

  test("wrappers never invent frontmatter the definition does not declare", () => {
    // A wrapper declaring model:/skills: silently overrides how the agent runs. Agents in this
    // catalog carry no frontmatter, so their wrappers must carry none either.
    for (const filename of listCatalogMarkdown("agents")) {
      const wrapper = managedAgentWrapper(filename);
      assert.ok(!wrapper.startsWith("---"), `agent wrapper for ${filename} must not add frontmatter`);
      assert.ok(!wrapper.includes("model:"), `agent wrapper for ${filename} must not pin a model`);
      assert.ok(!wrapper.includes("skills:"), `agent wrapper for ${filename} must not inject skills`);
    }

    // Skills do declare frontmatter, and it must be copied from the source verbatim.
    for (const relativePath of listCatalogSkills()) {
      const wrapper = managedSkillWrapper(relativePath);
      const source = fs
        .readFileSync(path.join(__dirname, "..", "catalog", "claude-base", "claude", "skills", ...relativePath.split("/")), "utf8")
        .replace(/\r\n/g, "\n");
      const block = source.slice(0, source.indexOf("\n---\n", 3) + 5);
      assert.ok(wrapper.startsWith(block), `skill wrapper for ${relativePath} must copy source frontmatter verbatim`);
    }
  });

  test("seeded agents must have a catalog definition", () => {
    // The product-manager bug: baseline listed an agent the catalog never rendered, so every
    // repo got a wrapper whose "Full definition" link dangled.
    assert.throws(
      () => assertSeededAgentsHaveDefinitions(["ghost-agent.md"]),
      /no catalog definition: ghost-agent\.md/,
      "a seeded agent with no definition must fail loudly"
    );

    // The real baseline must satisfy the invariant.
    const catalogAgents = listCatalogMarkdown("agents");
    assert.doesNotThrow(() => assertSeededAgentsHaveDefinitions(catalogAgents));
    assert.doesNotThrow(() => assertSeededAgentsHaveDefinitions([]));
  });

  test("the managed set is derived from the catalog, not hardcoded", () => {
    const cwd = mkTempDir("kyos-derived-managed-");
    runBootstrap({ cwd, apply: false });

    for (const filename of listCatalogMarkdown("agents")) {
      assert.ok(exists(cwd, `.kyos/claude/agents/${filename}`), `agent ${filename} must render`);
    }
    for (const relativePath of listCatalogSkills()) {
      assert.ok(exists(cwd, `.kyos/claude/skills/${relativePath}`), `skill ${relativePath} must render`);
    }

    // Project context now lives in the repo-owned skill-overrides file, not a managed/generated
    // commands/project-context.md — that concept survives both kyos-cli and skills.sh installs.
    assert.equal(listCatalogMarkdown("commands").length, 0, "there is no commands catalog collection anymore");
    assert.ok(exists(cwd, ".claude/skill-overrides/_shared.md"), "shared override file still seeds");
  });

  test("--init seeds no agent wrappers while baseline.agents is empty", () => {
    const cwd = mkTempDir("kyos-no-baseline-agents-");
    runBootstrap({ cwd, apply: false });

    const agentsDir = path.join(cwd, ".claude", "agents");
    const seeded = fs.existsSync(agentsDir)
      ? fs.readdirSync(agentsDir).filter((f) => f !== "README.md")
      : [];
    assert.deepEqual(seeded, [], `no agent wrappers expected, got ${JSON.stringify(seeded)}`);

    // The catalog ships no agent definitions, so nothing renders into the managed layer either.
    const managed = listCatalogMarkdown("agents").filter((f) => f !== "README.md");
    assert.deepEqual(managed, [], `no catalog agent definitions expected, got ${JSON.stringify(managed)}`);
  });

  test("listCatalogSkillSupportingFiles finds a real sidecar, excludes SKILL.md", () => {
    const supporting = listCatalogSkillSupportingFiles("kyos-setup");
    assert.ok(
      supporting.includes(path.posix.join("agents", "openai.yaml")),
      `expected agents/openai.yaml supporting file, got: ${JSON.stringify(supporting)}`
    );
    assert.ok(!supporting.includes("SKILL.md"), "SKILL.md must not be treated as a supporting file");

    assert.deepEqual(listCatalogSkillSupportingFiles("does-not-exist"), []);
  });

  test("a skill's supporting files render into both the managed and local layers on bootstrap", () => {
    const cwd = mkTempDir("kyos-skill-supporting-files-");
    runBootstrap({ cwd, apply: false });

    const managedPath = ".kyos/claude/skills/kyos-setup/agents/openai.yaml";
    const localPath = ".claude/skills/kyos-setup/agents/openai.yaml";
    assert.ok(exists(cwd, managedPath), `expected managed supporting file at ${managedPath}`);
    assert.ok(exists(cwd, localPath), `expected local supporting file at ${localPath}`);

    const catalogContent = fs.readFileSync(
      path.join(__dirname, "..", "catalog", "claude-base", "claude", "skills", "kyos-setup", "agents", "openai.yaml"),
      "utf8"
    );
    assert.equal(fs.readFileSync(path.join(cwd, ...managedPath.split("/")), "utf8"), catalogContent);
    assert.equal(fs.readFileSync(path.join(cwd, ...localPath.split("/")), "utf8"), catalogContent);

    const lock = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "lock.json"), "utf8"));
    assert.ok(lock.files[managedPath], "supporting file must be checksum-tracked in the lock file");
  });

  test("add mcp writes to .claude/settings.json and records in config", () => {
    const cwd = mkTempDir("kyos-add-mcp-");
    runBootstrap({ cwd, apply: false });

    const result = addCapability({ cwd, type: "mcp", name: "context7" });
    assert.equal(result.ok, true);

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.enabledPlugins && settings.enabledPlugins["context7@claude-plugins-official"] === true, "context7 entry should exist in enabledPlugins");
    assert.ok(settings.permissions, "existing settings keys must be preserved");

    const config = JSON.parse(fs.readFileSync(path.join(cwd, "kyos.json"), "utf8"));
    assert.ok((config.installed.mcps || []).includes("context7"));
  });

  test("add mcp creates .claude/settings.json when it does not exist yet", () => {
    const cwd = mkTempDir("kyos-add-mcp-no-settings-");
    runBootstrap({ cwd, apply: false });
    fs.rmSync(path.join(cwd, ".claude", "settings.json"));

    const result = addCapability({ cwd, type: "mcp", name: "context7" });
    assert.equal(result.ok, true);

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.enabledPlugins && settings.enabledPlugins["context7@claude-plugins-official"] === true, "context7 entry should exist");
  });

  test("add mcp accumulates multiple MCPs without overwriting earlier ones", () => {
    const cwd = mkTempDir("kyos-add-mcp-multi-");
    runBootstrap({ cwd, apply: false });

    addCapability({ cwd, type: "mcp", name: "context7" });
    addCapability({ cwd, type: "mcp", name: "filesystem" });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.enabledPlugins["context7@claude-plugins-official"] === true, "context7 must still be present");
    assert.ok(settings.enabledPlugins.filesystem === true, "filesystem must be present");
    assert.ok(settings.permissions, "other settings keys must be preserved");
  });

  test("add mcp is idempotent when called twice with the same name", () => {
    const cwd = mkTempDir("kyos-add-mcp-idempotent-");
    runBootstrap({ cwd, apply: false });

    addCapability({ cwd, type: "mcp", name: "context7" });
    addCapability({ cwd, type: "mcp", name: "context7" });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    assert.equal(Object.keys(settings.enabledPlugins).length, 1, "enabledPlugins should have exactly one entry");

    const config = JSON.parse(fs.readFileSync(path.join(cwd, "kyos.json"), "utf8"));
    assert.equal(config.installed.mcps.filter((n) => n === "context7").length, 1, "installed.mcps should not duplicate");
  });

  test("add skill records capability in config.json", () => {
    const cwd = mkTempDir("kyos-add-skill-config-");
    runBootstrap({ cwd, apply: false });

    const result = addCapability({ cwd, type: "skill", name: "silent-execution" });
    assert.equal(result.ok, true);

    const config = JSON.parse(fs.readFileSync(path.join(cwd, "kyos.json"), "utf8"));
    assert.ok((config.installed.skills || []).includes("silent-execution"));
  });

  test("--apply replays installed skill stub when .claude file is missing", () => {
    const cwd = mkTempDir("kyos-apply-installed-skill-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "skill", name: "critic" });

    // simulate fresh clone: remove the .claude stub that --add wrote
    const stubPath = path.join(cwd, ".claude", "skills", "critic", "SKILL.md");
    fs.rmSync(stubPath);
    assert.equal(exists(cwd, ".claude/skills/critic/SKILL.md"), false);

    const result = runApply({ cwd });
    assert.equal(result.ok, true);
    assert.ok(exists(cwd, ".claude/skills/critic/SKILL.md"), "stub should be recreated by --apply");
    assert.ok(result.lines.some((l) => String(l).includes("critic")));
  });

  test("--apply reports an orphaned capability instead of fabricating a stub", () => {
    const cwd = mkTempDir("kyos-apply-orphan-agent-");
    runBootstrap({ cwd, apply: false });

    // Simulate a repo whose config records a capability the registry no longer defines.
    const configPath = path.join(cwd, "kyos.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.installed.agents = [...(config.installed.agents || []), "retired-agent"];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);
    assert.equal(exists(cwd, ".claude/agents/retired-agent.md"), false, "must not invent a stub for an unknown name");
    assert.ok(
      result.lines.some((l) => String(l).includes("retired-agent") && String(l).startsWith("!")),
      `expected an orphan report line: ${JSON.stringify(result.lines)}`
    );
  });

  test("--apply replays installed mcp when missing from settings", () => {
    const cwd = mkTempDir("kyos-apply-installed-mcp-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "mcp", name: "context7" });

    // remove the mcp entry from settings to simulate fresh clone
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    delete settings.enabledPlugins["context7@claude-plugins-official"];
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.ok(after.enabledPlugins && after.enabledPlugins["context7@claude-plugins-official"] === true, "context7 should be re-registered by --apply");
    assert.ok(result.lines.some((l) => String(l).includes("context7")));
  });

  test("--apply does not duplicate installed skill stub when already present", () => {
    const cwd = mkTempDir("kyos-apply-skill-noop-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "skill", name: "critic" });

    const stubPath = path.join(cwd, ".claude", "skills", "critic", "SKILL.md");
    const contentBefore = fs.readFileSync(stubPath, "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);

    const contentAfter = fs.readFileSync(stubPath, "utf8");
    assert.equal(contentAfter, contentBefore, "existing stub must not be modified");
    assert.ok(!result.lines.some((l) => String(l).includes("critic")), "no line for already-present stub");
  });

  test("--apply leaves a locally authored agent alone and does not report it", () => {
    const cwd = mkTempDir("kyos-apply-agent-noop-");
    runBootstrap({ cwd, apply: false });

    // /hire authors agents directly, so the file exists without a registry entry.
    const configPath = path.join(cwd, "kyos.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.installed.agents = [...(config.installed.agents || []), "repo-specific-agent"];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

    const stubPath = path.join(cwd, ".claude", "agents", "repo-specific-agent.md");
    fs.mkdirSync(path.dirname(stubPath), { recursive: true });
    fs.writeFileSync(stubPath, "# Repo specific agent\n", "utf8");
    const contentBefore = fs.readFileSync(stubPath, "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);

    const contentAfter = fs.readFileSync(stubPath, "utf8");
    assert.equal(contentAfter, contentBefore, "existing agent file must not be modified");
    assert.ok(!result.lines.some((l) => String(l).includes("repo-specific-agent")), "no line for a file that is already present");
  });

  test("--apply does not duplicate installed mcp when already in settings", () => {
    const cwd = mkTempDir("kyos-apply-mcp-noop-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "mcp", name: "context7" });

    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const settingsBefore = fs.readFileSync(settingsPath, "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);

    assert.equal(fs.readFileSync(settingsPath, "utf8"), settingsBefore, "settings.json must not be modified");
    assert.ok(!result.lines.some((l) => String(l).includes("context7")), "no line for already-registered mcp");
  });

  // ── Hook tests (T7) ────────────────────────────────────────────────────────

  test("add hook repo-sandbox installs script and wires PreToolUse entry", () => {
    const cwd = mkTempDir("kyos-add-hook-");
    runBootstrap({ cwd, apply: false });

    const result = addCapability({ cwd, type: "hook", name: "repo-sandbox" });
    assert.equal(result.ok, true, `expected ok:true, got: ${result.errors}`);
    assert.ok(result.summary.includes("installed hook 'repo-sandbox'"));

    // Script was copied (js or ps1 depending on runtime)
    const hasJs = exists(cwd, ".claude/hooks/repo-sandbox.js");
    const hasPs1 = exists(cwd, ".claude/hooks/repo-sandbox.ps1");
    assert.ok(hasJs || hasPs1, "at least one hook script must be installed");

    // Script must not contain obsidian-vault or any hardcoded absolute root
    const scriptPath = hasPs1
      ? path.join(cwd, ".claude", "hooks", "repo-sandbox.ps1")
      : path.join(cwd, ".claude", "hooks", "repo-sandbox.js");
    const scriptContent = fs.readFileSync(scriptPath, "utf8");
    assert.ok(!scriptContent.includes("obsidian-vault"), "script must not contain obsidian-vault");
    assert.ok(!scriptContent.includes("c:\\git-repo\\kyos"), "script must not embed absolute repo root");
    assert.ok(!scriptContent.includes("c:/git-repo/kyos"), "script must not embed absolute repo root");

    // Script uses self-resolving root
    if (hasPs1) {
      assert.ok(scriptContent.includes("$PSScriptRoot"), "ps1 must resolve root from $PSScriptRoot");
    } else {
      assert.ok(scriptContent.includes("__dirname"), "js must resolve root from __dirname");
    }
  });

  test("add hook repo-sandbox wires PreToolUse in settings.json, preserves PostToolUse", () => {
    const cwd = mkTempDir("kyos-hook-settings-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    assert.ok(Array.isArray(settings.hooks?.PreToolUse), "hooks.PreToolUse must be an array");
    const entry = settings.hooks.PreToolUse.find((h) => h.matcher === "Read|Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell");
    assert.ok(entry, "must have PreToolUse entry with the sandbox matcher");
    assert.ok(Array.isArray(entry.hooks) && entry.hooks.length > 0, "entry must have hooks");
    assert.equal(entry.hooks[0].type, "command");
    assert.ok(entry.hooks[0].command.includes("repo-sandbox"), "command must reference repo-sandbox script");

    // PostToolUse Agent hook must still be there
    assert.ok(Array.isArray(settings.hooks?.PostToolUse), "PostToolUse must survive hook install");
    assert.ok(settings.hooks.PostToolUse.some((h) => h.matcher === "Agent"), "Agent PostToolUse hook must be preserved");
  });

  test("add hook repo-sandbox records in config.json installed.hooks", () => {
    const cwd = mkTempDir("kyos-hook-config-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const config = JSON.parse(fs.readFileSync(path.join(cwd, "kyos.json"), "utf8"));
    assert.ok(Array.isArray(config.installed.hooks), "installed.hooks must be an array");
    assert.ok(config.installed.hooks.includes("repo-sandbox"), "installed.hooks must contain repo-sandbox");
  });

  test("--update migrates a legacy .kyos/config.json to kyos.json and removes the old copy", () => {
    const cwd = mkTempDir("kyos-config-migrate-");
    runBootstrap({ cwd, apply: false });

    // Simulate a pre-1.4 repo: move the config back into the gitignored state dir.
    const newPath = path.join(cwd, "kyos.json");
    const original = fs.readFileSync(newPath, "utf8");
    fs.writeFileSync(path.join(cwd, ".kyos", "config.json"), original, "utf8");
    fs.rmSync(newPath);

    const result = runUpdateKyos({ cwd });

    assert.ok(result.lines.some((l) => l.includes("config migrated")));
    assert.ok(exists(cwd, "kyos.json"), "kyos.json must exist after --update");
    assert.ok(!exists(cwd, ".kyos/config.json"), "legacy config must be removed after --update");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(newPath, "utf8")),
      JSON.parse(original),
      "migrated config content must match the original"
    );
  });

  test("plain --doctor reports a legacy config but changes nothing", () => {
    const cwd = mkTempDir("kyos-config-doctor-report-");
    runBootstrap({ cwd, apply: false });

    const newPath = path.join(cwd, "kyos.json");
    fs.writeFileSync(path.join(cwd, ".kyos", "config.json"), fs.readFileSync(newPath, "utf8"), "utf8");
    fs.rmSync(newPath);

    const report = runDoctor({ cwd });
    assert.ok(report.warnings.some((w) => w.includes(".kyos/config.json") && w.includes("--update")));
    assert.ok(exists(cwd, ".kyos/config.json"), "doctor must not move the legacy config");
    assert.ok(!exists(cwd, "kyos.json"), "doctor must not create kyos.json");
  });

  test("loadUserConfig falls back to legacy .kyos/config.json when kyos.json is absent", () => {
    const cwd = mkTempDir("kyos-config-fallback-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "skill", name: "critic" });

    // Move the config to the legacy location without migrating.
    const newPath = path.join(cwd, "kyos.json");
    fs.writeFileSync(path.join(cwd, ".kyos", "config.json"), fs.readFileSync(newPath, "utf8"), "utf8");
    fs.rmSync(newPath);

    // doctor reads via the fallback, so the installed skill count is still reported.
    const report = runDoctor({ cwd });
    assert.ok(report.lines.some((l) => l === "installed skills: 1"));
  });

  test("any config write (e.g. --add) migrates a legacy .kyos/config.json to kyos.json", () => {
    const cwd = mkTempDir("kyos-config-autom-");
    runBootstrap({ cwd, apply: false });

    // Simulate a pre-1.4 repo: config only at the legacy location.
    const newPath = path.join(cwd, "kyos.json");
    fs.writeFileSync(path.join(cwd, ".kyos", "config.json"), fs.readFileSync(newPath, "utf8"), "utf8");
    fs.rmSync(newPath);

    addCapability({ cwd, type: "skill", name: "critic" });

    assert.ok(exists(cwd, "kyos.json"), "kyos.json must be created on the write");
    assert.ok(!exists(cwd, ".kyos/config.json"), "legacy config must be removed on the write");
    const config = JSON.parse(fs.readFileSync(newPath, "utf8"));
    assert.ok((config.installed.skills || []).includes("critic"));
  });

  test("add hook repo-sandbox is idempotent (no duplicate settings or config entries)", () => {
    const cwd = mkTempDir("kyos-hook-idempotent-");
    runBootstrap({ cwd, apply: false });

    addCapability({ cwd, type: "hook", name: "repo-sandbox" });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    const preToolUse = settings.hooks?.PreToolUse || [];
    const sandboxEntries = preToolUse.filter((h) => h.matcher === "Read|Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell");
    assert.equal(sandboxEntries.length, 1, "must have exactly one PreToolUse sandbox entry after two installs");

    const config = JSON.parse(fs.readFileSync(path.join(cwd, "kyos.json"), "utf8"));
    const hookCount = (config.installed.hooks || []).filter((n) => n === "repo-sandbox").length;
    assert.equal(hookCount, 1, "installed.hooks must not duplicate repo-sandbox");
  });

  test("add hook unknown name returns ok:false with clear error", () => {
    const cwd = mkTempDir("kyos-hook-unknown-");
    runBootstrap({ cwd, apply: false });

    const result = addCapability({ cwd, type: "hook", name: "nope" });
    assert.equal(result.ok, false);
    assert.ok(result.errors && result.errors.some((e) => e.includes("nope") && e.includes("catalog/registry.json")));
  });

  test("--apply replays hook when settings entry is missing", () => {
    const cwd = mkTempDir("kyos-hook-replay-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    // Remove the PreToolUse entry to simulate fresh clone
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    delete settings.hooks.PreToolUse;
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.ok(Array.isArray(after.hooks?.PreToolUse), "PreToolUse must be restored by --apply");
    assert.ok(
      after.hooks.PreToolUse.some((h) => h.matcher === "Read|Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell"),
      "sandbox entry must be restored"
    );
    assert.ok(result.lines.some((l) => String(l).includes("repo-sandbox")), "result must mention repo-sandbox");
  });

  function getSandboxEntry(cwd) {
    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    const entries = (settings.hooks?.PreToolUse || []).filter(
      (h) => h.matcher === "Read|Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell"
    );
    return { settings, entries };
  }

  function writeSettings(cwd, settings) {
    fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify(settings), "utf8");
  }

  test("hook command is portable and marked (no absolute path)", () => {
    const cwd = mkTempDir("kyos-hook-portable-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { entries } = getSandboxEntry(cwd);
    assert.equal(entries.length, 1);
    const command = entries[0].hooks[0].command;
    assert.ok(
      command.includes("${CLAUDE_PROJECT_DIR}/.claude/hooks/repo-sandbox."),
      "command must reference the script via ${CLAUDE_PROJECT_DIR}"
    );
    assert.ok(command.includes(" # managedBy=kyos/repo-sandbox"), "command must carry the kyos marker comment");
    assert.ok(!command.includes(cwd), "command must not contain the absolute repo path");
  });

  test("--apply rewrites a hand-edited marked hook command in place", () => {
    const cwd = mkTempDir("kyos-hook-selfheal-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { settings, entries } = getSandboxEntry(cwd);
    entries[0].hooks[0].command = "echo broken # managedBy=kyos/repo-sandbox";
    writeSettings(cwd, settings);

    const result = runApply({ cwd });

    const after = getSandboxEntry(cwd);
    assert.equal(after.entries.length, 1, "still exactly one sandbox entry");
    assert.ok(
      after.entries[0].hooks[0].command.includes("${CLAUDE_PROJECT_DIR}"),
      "command must be restored to canonical portable form"
    );
    assert.ok(result.lines.some((l) => String(l).includes("~ hook:repo-sandbox")), "must report the rewire");
  });

  test("--apply dedupes duplicated marked hook entries", () => {
    const cwd = mkTempDir("kyos-hook-dedupe-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { settings, entries } = getSandboxEntry(cwd);
    settings.hooks.PreToolUse.push(JSON.parse(JSON.stringify(entries[0])));
    writeSettings(cwd, settings);

    runApply({ cwd });

    const after = getSandboxEntry(cwd);
    assert.equal(after.entries.length, 1, "duplicated marked entries must be deduped to one");
  });

  test("--apply leaves legacy unmarked hook wiring untouched and warns on unknown version", () => {
    const cwd = mkTempDir("kyos-hook-legacy-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    // Rewrite the wired entry the way pre-marker releases did: absolute path, no marker.
    const { settings, entries } = getSandboxEntry(cwd);
    const command = entries[0].hooks[0].command;
    const legacyCommand = command
      .replace(" # managedBy=kyos/repo-sandbox", "")
      .replace("${CLAUDE_PROJECT_DIR}", cwd.replace(/\\/g, "/"));
    entries[0].hooks[0].command = legacyCommand;
    writeSettings(cwd, settings);

    // Simulate an installation last written by a pre-stamp (unknown) version.
    fs.rmSync(path.join(cwd, ".kyos", "version.json"));

    const result = runApply({ cwd });

    const after = getSandboxEntry(cwd);
    // The unmarked legacy entry is repo-owned now: kyos no longer migrates it. It is
    // left untouched and a marked portable entry is appended beside it; the warning
    // tells the user to review and remove the orphan.
    assert.ok(
      after.entries.some((e) => e.hooks[0].command === legacyCommand),
      "legacy unmarked entry must be left untouched"
    );
    assert.ok(
      after.entries.some((e) => e.hooks[0].command.includes("managedBy=kyos/repo-sandbox")),
      "a marked portable entry must be present"
    );
    assert.ok(
      (result.warnings || []).some((w) => /unknown kyos version/i.test(w) && /orphaned/i.test(w)),
      "must warn to review hooks for orphaned entries"
    );
  });

  test("--apply does not warn about unknown version when the stamp is current", () => {
    const cwd = mkTempDir("kyos-hook-known-version-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    // runBootstrap stamped the current version, so this apply is a known upgrade.
    const result = runApply({ cwd });

    assert.ok(
      !(result.warnings || []).some((w) => /unknown kyos version/i.test(w)),
      "must not warn when the recorded version is known"
    );
  });

  test("--apply leaves foreign same-matcher entries untouched", () => {
    const cwd = mkTempDir("kyos-hook-foreign-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { settings } = getSandboxEntry(cwd);
    const foreign = {
      matcher: "Read|Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell",
      hooks: [{ type: "command", command: "echo my-own-guard" }],
    };
    settings.hooks.PreToolUse.push(foreign);
    writeSettings(cwd, settings);

    runApply({ cwd });

    const after = getSandboxEntry(cwd);
    assert.equal(after.entries.length, 2, "foreign entry must survive alongside the marked one");
    assert.ok(
      after.entries.some((e) => e.hooks[0].command === "echo my-own-guard"),
      "foreign command must be unchanged"
    );
  });

  test("base Agent hook is marked and self-heals when payload is edited", () => {
    const cwd = mkTempDir("kyos-base-hook-marker-");
    runBootstrap({ cwd, apply: false });

    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const agentEntry = settings.hooks.PostToolUse.find((h) => h.matcher === "Agent");
    assert.ok(
      agentEntry.hooks[0].command.includes("# managedBy=kyos/base-agent"),
      "base Agent hook command must carry the kyos marker"
    );

    agentEntry.hooks[0].command = "echo tampered # managedBy=kyos/base-agent";
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");

    const changed = ensureBaseHooks(cwd);
    assert.equal(changed, true, "must report the repair");
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const repaired = after.hooks.PostToolUse.find((h) => h.matcher === "Agent");
    assert.ok(repaired.hooks[0].command.includes("hookSpecificOutput"), "payload must be restored");
  });

  test("ensureBaseHooks leaves an unmarked Agent hook untouched", () => {
    const cwd = mkTempDir("kyos-base-hook-legacy-");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    const legacyCommand =
      "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"PROCESS RULE: A subagent just completed. If the user now reports a bug or issue with its output, re-spawn the SAME agent type via the Agent tool — do NOT call Edit or Write inline. Only fix inline if it is a single-line typo or wiring mistake faster to correct than to brief an agent.\"}}' ";
    const initial = {
      hooks: { PostToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: legacyCommand }] }] },
    };
    fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify(initial), "utf8");

    const changed = ensureBaseHooks(cwd);

    // Unmarked entries are repo-owned: kyos no longer migrates them. The unknown-version
    // warning (surfaced by --apply) is what prompts the user to clean up the orphan.
    assert.equal(changed, false, "unmarked Agent entry must be left untouched");
    const after = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    const agentEntries = after.hooks.PostToolUse.filter((h) => h.matcher === "Agent");
    assert.equal(agentEntries.length, 1, "no entry added or removed");
    assert.equal(agentEntries[0].hooks[0].command, legacyCommand, "command must be unchanged");
  });

  test("version stamp is written on init and refreshed by --apply", () => {
    const cwd = mkTempDir("kyos-version-stamp-");
    runBootstrap({ cwd, apply: false });

    const { version: currentVersion } = require("../package.json");
    const stampPath = path.join(cwd, ".kyos", "version.json");
    const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    assert.equal(stamp.version, currentVersion, "stamp must record the running kyos version");

    stamp.version = "0.0.1";
    fs.writeFileSync(stampPath, JSON.stringify(stamp), "utf8");
    runApply({ cwd });

    const refreshed = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    assert.equal(refreshed.version, currentVersion, "--apply must refresh the stamp to the running version");

    const lock = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "lock.json"), "utf8"));
    assert.ok(!Object.keys(lock.files || {}).includes(".kyos/version.json"), "version.json must not be a checksummed managed file");
  });

  test("installed node script blocks outside-path payload and allows inside-path", (t) => {
    const cwd = mkTempDir("kyos-hook-behavioral-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const scriptPath = path.join(cwd, ".claude", "hooks", "repo-sandbox.js");
    if (!exists(cwd, ".claude/hooks/repo-sandbox.js")) {
      t.skip("node script not installed (pwsh was selected as runtime)");
      return;
    }

    const outsidePayload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "C:/some/other/repo/secret.txt" },
    });
    const blocked = spawnSync("node", [scriptPath], { input: outsidePayload, encoding: "utf8" });
    assert.equal(blocked.status, 2, "outside path must be blocked with exit code 2");
    assert.ok(blocked.stderr && blocked.stderr.includes("repo-sandbox"), "stderr must mention repo-sandbox");

    const insidePayload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: path.join(cwd, "README.md") },
    });
    const allowed = spawnSync("node", [scriptPath], { input: insidePayload, encoding: "utf8" });
    assert.equal(allowed.status, 0, "inside path must be allowed with exit code 0");
  });

  test("doctor reports installed hooks count", () => {
    const cwd = mkTempDir("kyos-hook-doctor-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const doctor = runDoctor({ cwd });
    assert.ok(doctor.lines.some((l) => String(l).includes("installed hooks: 1")), "doctor must report installed hooks count");
  });

  // ── Slice 1: marker carries package@version ──────────────────────────────────

  test("newly wired hook command carries package=kyos-cli@<version>", () => {
    const cwd = mkTempDir("kyos-marker-pkg-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { entries } = getSandboxEntry(cwd);
    const command = entries[0].hooks[0].command;
    assert.ok(command.includes("managedBy=kyos/repo-sandbox"), "marker prefix must remain");
    assert.ok(command.includes(`package=kyos-cli@${PKG_VERSION}`), "command must carry package marker with current version");
  });

  test("base-agent command carries package=kyos-cli@<version>", () => {
    const cwd = mkTempDir("kyos-marker-base-pkg-");
    runBootstrap({ cwd, apply: false });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    const agent = settings.hooks.PostToolUse.find((h) => h.matcher === "Agent");
    assert.ok(agent.hooks[0].command.includes(`package=kyos-cli@${PKG_VERSION}`), "base-agent must carry package marker");
  });

  test("pre-package marker is still recognized and gains package= on reconcile", () => {
    const cwd = mkTempDir("kyos-marker-legacy-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    // Strip the package= segment to mimic an entry written by an older kyos-cli.
    const { settings, entries } = getSandboxEntry(cwd);
    entries[0].hooks[0].command = entries[0].hooks[0].command.replace(/ package=kyos-cli@[^\s#]+/, "");
    writeSettings(cwd, settings);
    assert.ok(!getSandboxEntry(cwd).entries[0].hooks[0].command.includes("package="), "precondition: no package segment");

    runApply({ cwd });

    const after = getSandboxEntry(cwd);
    assert.equal(after.entries.length, 1, "still one entry — reconciled in place, not duplicated");
    assert.ok(after.entries[0].hooks[0].command.includes(`package=kyos-cli@${PKG_VERSION}`), "reconcile must add the package marker");
  });

  // ── Slice 2: marker parsing + version compare ────────────────────────────────

  test("parseOwnedHookName reads kyos name off marked commands only", () => {
    assert.equal(parseOwnedHookName("echo x # managedBy=kyos/repo-sandbox package=kyos-cli@1.2.0"), "repo-sandbox");
    assert.equal(parseOwnedHookName("echo x # managedBy=kyos/base-agent"), "base-agent");
    assert.equal(parseOwnedHookName("echo my-own-guard"), null);
    assert.equal(parseOwnedHookName(undefined), null);
  });

  test("parsePackageVersion returns version or null for pre-package markers", () => {
    assert.equal(parsePackageVersion("x # managedBy=kyos/repo-sandbox package=kyos-cli@1.3.0"), "1.3.0");
    assert.equal(parsePackageVersion("x # managedBy=kyos/repo-sandbox"), null);
    assert.equal(parsePackageVersion("echo nope"), null);
  });

  test("compareHookVersions orders numerically and treats null as lowest", () => {
    assert.ok(compareHookVersions("1.10.0", "1.9.0") > 0, "1.10.0 > 1.9.0");
    assert.ok(compareHookVersions("1.9.0", "1.10.0") < 0, "1.9.0 < 1.10.0");
    assert.equal(compareHookVersions("1.2.0", "1.2.0"), 0, "equal versions");
    assert.ok(compareHookVersions(null, "1.0.0") < 0, "null sorts lowest");
    assert.ok(compareHookVersions("1.0.0", null) > 0, "versioned beats null");
    assert.equal(compareHookVersions(null, null), 0, "two nulls equal");
    assert.ok(compareHookVersions("abc", "1.0.0") < 0, "non-numeric sorts lowest");
  });

  // ── Slice 3: doctor read-only audit ──────────────────────────────────────────

  const SANDBOX_MATCHER = "Read|Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell";

  test("doctor warns on two kyos-owned repo-sandbox entries and stays exit-0", () => {
    const cwd = mkTempDir("kyos-doctor-dup-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { settings, entries } = getSandboxEntry(cwd);
    settings.hooks.PreToolUse.push(JSON.parse(JSON.stringify(entries[0])));
    writeSettings(cwd, settings);

    const doctor = runDoctor({ cwd });
    assert.equal(doctor.ok, true, "duplicates are warnings, not errors");
    assert.ok(
      doctor.warnings.some((w) => /repo-sandbox/.test(w) && /2 kyos-owned entries/.test(w) && /--doctor --fix/.test(w)),
      "must warn about the duplicate"
    );
  });

  test("doctor reports a lone stale-version owned entry without changing the file", () => {
    const cwd = mkTempDir("kyos-doctor-stale-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { settings, entries } = getSandboxEntry(cwd);
    entries[0].hooks[0].command = entries[0].hooks[0].command.replace(/package=kyos-cli@[^\s#]+/, "package=kyos-cli@0.0.1");
    writeSettings(cwd, settings);
    const before = fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8");

    const doctor = runDoctor({ cwd });
    assert.equal(doctor.ok, true);
    assert.ok(
      doctor.warnings.some((w) => /repo-sandbox/.test(w) && /kyos-cli@0\.0\.1/.test(w) && w.includes(PKG_VERSION)),
      "must report stale version and the running version"
    );
    assert.equal(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"), before, "plain doctor must not write");
  });

  test("doctor warns on an unmarked entry shadowing a managed hook", () => {
    const cwd = mkTempDir("kyos-doctor-shadow-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { settings } = getSandboxEntry(cwd);
    settings.hooks.PreToolUse.push({ matcher: SANDBOX_MATCHER, hooks: [{ type: "command", command: "echo my-own-guard" }] });
    writeSettings(cwd, settings);

    const doctor = runDoctor({ cwd });
    assert.equal(doctor.ok, true);
    assert.ok(
      doctor.warnings.some((w) => /repo-sandbox/.test(w) && /unmarked entry/.test(w)),
      "must surface the unmarked shadow"
    );
  });

  test("doctor handles a lone unmarked legacy base-agent without crashing, exit-0", () => {
    const cwd = mkTempDir("kyos-doctor-legacy-base-");
    runBootstrap({ cwd, apply: false });

    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const agent = settings.hooks.PostToolUse.find((h) => h.matcher === "Agent");
    agent.hooks[0].command = agent.hooks[0].command.replace(/ # managedBy=kyos\/base-agent[^\n]*/, "");
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
    const before = fs.readFileSync(settingsPath, "utf8");

    const doctor = runDoctor({ cwd });
    assert.equal(doctor.ok, true, "must stay exit-0");
    // A lone unmarked entry with no marked counterpart is the legacy case: no shadow finding.
    assert.equal(fs.readFileSync(settingsPath, "utf8"), before, "plain doctor must not write");
  });

  test("plain doctor leaves settings.json byte-identical", () => {
    const cwd = mkTempDir("kyos-doctor-readonly-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const before = fs.readFileSync(settingsPath, "utf8");
    runDoctor({ cwd });
    assert.equal(fs.readFileSync(settingsPath, "utf8"), before, "doctor must be read-only");
  });

  test("auditHookEntries is a pure detector over the three finding types", () => {
    const marked = (version) => ({
      matcher: SANDBOX_MATCHER,
      hooks: [{ type: "command", command: `echo x # managedBy=kyos/repo-sandbox package=kyos-cli@${version}` }],
    });
    const managedHooks = [{ name: "repo-sandbox", event: "PreToolUse", matcher: SANDBOX_MATCHER }];

    const dup = auditHookEntries({ hooks: { PreToolUse: [marked("1.2.0"), marked("1.3.0")] } }, { managedHooks, runningVersion: "1.3.0" });
    assert.equal(dup.duplicates.length, 1);
    assert.deepEqual(dup.duplicates[0].versions, ["1.2.0", "1.3.0"]);

    const stale = auditHookEntries({ hooks: { PreToolUse: [marked("0.0.1")] } }, { managedHooks, runningVersion: "1.3.0" });
    assert.equal(stale.staleVersions.length, 1);
    assert.equal(stale.staleVersions[0].version, "0.0.1");

    const shadow = auditHookEntries(
      { hooks: { PreToolUse: [marked("1.3.0"), { matcher: SANDBOX_MATCHER, hooks: [{ type: "command", command: "echo own" }] }] } },
      { managedHooks, runningVersion: "1.3.0" }
    );
    assert.equal(shadow.unmarkedShadows.length, 1);
  });

  // ── Slice 4: doctor --fix dedupe ─────────────────────────────────────────────

  test("--doctor --fix collapses duplicates to the highest-version entry, kept verbatim", () => {
    const cwd = mkTempDir("kyos-fix-dedupe-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { settings, entries } = getSandboxEntry(cwd);
    const low = JSON.parse(JSON.stringify(entries[0]));
    low.hooks[0].command = low.hooks[0].command.replace(/package=kyos-cli@[^\s#]+/, "package=kyos-cli@1.2.0");
    const high = JSON.parse(JSON.stringify(entries[0]));
    high.hooks[0].command = high.hooks[0].command.replace(/package=kyos-cli@[^\s#]+/, "package=kyos-cli@1.3.0");
    settings.hooks.PreToolUse = [low, high];
    writeSettings(cwd, settings);
    const keptCommand = high.hooks[0].command;

    const doctor = runDoctor({ cwd, fix: true });
    assert.equal(doctor.ok, true);

    const after = getSandboxEntry(cwd);
    assert.equal(after.entries.length, 1, "collapsed to one");
    assert.equal(after.entries[0].hooks[0].command, keptCommand, "survivor is the 1.3.0 entry, verbatim");
    assert.ok(doctor.lines.some((l) => /collapsed 2 -> 1/.test(l) && /1\.3\.0/.test(l)), "must report the collapse");
  });

  test("--doctor --fix leaves a lone stale entry unchanged", () => {
    const cwd = mkTempDir("kyos-fix-lone-stale-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { settings, entries } = getSandboxEntry(cwd);
    entries[0].hooks[0].command = entries[0].hooks[0].command.replace(/package=kyos-cli@[^\s#]+/, "package=kyos-cli@0.0.1");
    writeSettings(cwd, settings);
    const before = fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8");

    runDoctor({ cwd, fix: true });
    assert.equal(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"), before, "--fix must not touch a lone stale entry");
  });

  test("--doctor --fix never removes an unmarked entry but still reports the shadow", () => {
    const cwd = mkTempDir("kyos-fix-unmarked-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    const { settings } = getSandboxEntry(cwd);
    settings.hooks.PreToolUse.push({ matcher: SANDBOX_MATCHER, hooks: [{ type: "command", command: "echo my-own-guard" }] });
    writeSettings(cwd, settings);

    const doctor = runDoctor({ cwd, fix: true });
    const after = getSandboxEntry(cwd);
    assert.ok(
      after.settings.hooks.PreToolUse.some((h) => h.hooks[0].command === "echo my-own-guard"),
      "unmarked entry must survive --fix"
    );
    assert.ok(doctor.warnings.some((w) => /unmarked entry/.test(w)), "shadow still reported");
  });

  test("dedupeMarkedHookEntry returns null when only one owned entry exists", () => {
    const marker = "managedBy=kyos/repo-sandbox";
    const settings = {
      hooks: { PreToolUse: [{ matcher: SANDBOX_MATCHER, hooks: [{ type: "command", command: `x # ${marker} package=kyos-cli@1.2.0` }] }] },
    };
    assert.equal(dedupeMarkedHookEntry(settings, "PreToolUse", { name: "repo-sandbox", marker }), null);
  });

  test("dedupeMarkedHookEntry keeps first on tie / unparseable versions (stable)", () => {
    const marker = "managedBy=kyos/repo-sandbox";
    const mk = (cmd) => ({ matcher: SANDBOX_MATCHER, hooks: [{ type: "command", command: cmd }] });
    const first = mk(`first # ${marker}`);
    const second = mk(`second # ${marker}`);
    const result = dedupeMarkedHookEntry({ hooks: { PreToolUse: [first, second] } }, "PreToolUse", { name: "repo-sandbox", marker });
    assert.equal(result.settings.hooks.PreToolUse.length, 1);
    assert.equal(result.settings.hooks.PreToolUse[0].hooks[0].command, `first # ${marker}`, "first encountered survives on tie");
  });

  test("--fix without --doctor errors with a non-zero exit", () => {
    const cwd = mkTempDir("kyos-fix-cli-guard-");
    const binPath = path.join(__dirname, "..", "bin", "kyos.js");
    const run = spawnSync("node", [binPath, "--fix"], { cwd, encoding: "utf8" });
    assert.notEqual(run.status, 0, "must exit non-zero");
    assert.ok(/--fix is only valid with --doctor/.test(run.stderr || ""), "must explain the constraint");
  });

  // ── Slice 5: ensureBaseHooks modes ───────────────────────────────────────────

  const LEGACY_BASE_COMMAND =
    "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"PROCESS RULE: A subagent just completed. If the user now reports a bug or issue with its output, re-spawn the SAME agent type via the Agent tool — do NOT call Edit or Write inline. Only fix inline if it is a single-line typo or wiring mistake faster to correct than to brief an agent.\"}}' ";

  function writeBaseSettings(cwd, postToolUse) {
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: postToolUse } }), "utf8");
  }

  test("ensureBaseHooks adoptLegacy rewrites a signature-matched unmarked entry to marked+versioned", () => {
    const cwd = mkTempDir("kyos-adopt-legacy-");
    writeBaseSettings(cwd, [{ matcher: "Agent", hooks: [{ type: "command", command: LEGACY_BASE_COMMAND }] }]);

    const changed = ensureBaseHooks(cwd, { adoptLegacy: true });
    assert.equal(changed, true, "must adopt the legacy entry");

    const after = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    const agent = after.hooks.PostToolUse.find((h) => h.matcher === "Agent");
    assert.ok(agent.hooks[0].command.includes(`managedBy=kyos/base-agent package=kyos-cli@${PKG_VERSION}`), "now marked + versioned");
    assert.equal(after.hooks.PostToolUse.filter((h) => h.matcher === "Agent").length, 1, "no duplicate added");
  });

  test("ensureBaseHooks adoptLegacy leaves a foreign Agent entry untouched", () => {
    const cwd = mkTempDir("kyos-adopt-foreign-");
    writeBaseSettings(cwd, [{ matcher: "Agent", hooks: [{ type: "command", command: "echo my-own-agent-hook" }] }]);
    const before = fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8");

    const changed = ensureBaseHooks(cwd, { adoptLegacy: true, updateOnly: true });
    assert.equal(changed, false, "foreign entry is not adopted");
    assert.equal(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"), before, "file unchanged");
  });

  test("ensureBaseHooks updateOnly does not append when no entry exists", () => {
    const cwd = mkTempDir("kyos-updateonly-noappend-");
    writeBaseSettings(cwd, [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }]);

    const changed = ensureBaseHooks(cwd, { updateOnly: true });
    assert.equal(changed, false, "update-only must not append base-agent");
    const after = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    assert.ok(!after.hooks.PostToolUse.some((h) => h.matcher === "Agent"), "no Agent entry added");
  });

  // ── Slice 6: --update refreshes existing managed hooks (update-only) ──────────

  test("--update refreshes an already-wired older-version base-agent", () => {
    const cwd = mkTempDir("kyos-update-base-refresh-");
    runBootstrap({ cwd, apply: false });

    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const agent = settings.hooks.PostToolUse.find((h) => h.matcher === "Agent");
    agent.hooks[0].command = agent.hooks[0].command.replace(/package=kyos-cli@[^\s#]+/, "package=kyos-cli@0.0.1");
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");

    const result = runUpdateKyos({ cwd });
    assert.equal(result.ok, true);
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const refreshed = after.hooks.PostToolUse.find((h) => h.matcher === "Agent");
    assert.ok(refreshed.hooks[0].command.includes(`package=kyos-cli@${PKG_VERSION}`), "base-agent version refreshed");
    assert.ok(result.lines.some((l) => /hook:base-agent refreshed/.test(l)), "must report the refresh");
  });

  test("--update adopts a lone unmarked legacy base-agent", () => {
    const cwd = mkTempDir("kyos-update-adopt-");
    runBootstrap({ cwd, apply: false });

    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const agent = settings.hooks.PostToolUse.find((h) => h.matcher === "Agent");
    agent.hooks[0].command = LEGACY_BASE_COMMAND; // unmarked legacy payload
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");

    runUpdateKyos({ cwd });

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const adopted = after.hooks.PostToolUse.find((h) => h.matcher === "Agent");
    assert.ok(adopted.hooks[0].command.includes(`managedBy=kyos/base-agent package=kyos-cli@${PKG_VERSION}`), "legacy base-agent adopted");
    assert.equal(after.hooks.PostToolUse.filter((h) => h.matcher === "Agent").length, 1, "no duplicate");
  });

  test("--update does not add a catalog hook absent from settings.json", () => {
    const cwd = mkTempDir("kyos-update-no-add-hook-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "hook", name: "repo-sandbox" });

    // Remove the wired PreToolUse entry but keep repo-sandbox in config.json.
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    delete settings.hooks.PreToolUse;
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");

    runUpdateKyos({ cwd });

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.ok(!after.hooks.PreToolUse, "update-only must not re-add the absent catalog hook");
  });

  test("--update with only base-agent present adds nothing else", () => {
    const cwd = mkTempDir("kyos-update-base-only-");
    runBootstrap({ cwd, apply: false });

    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const countEntries = (s) => Object.values(s.hooks || {}).reduce((n, arr) => n + arr.length, 0);
    const before = countEntries(JSON.parse(fs.readFileSync(settingsPath, "utf8")));

    runUpdateKyos({ cwd });

    const after = countEntries(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
    assert.equal(after, before, "no new hook entries added by --update");
  });

  test("--update still resets .kyos to baseline", () => {
    const cwd = mkTempDir("kyos-update-still-resets-");
    runBootstrap({ cwd, apply: false });

    const managedTechPath = path.join(cwd, ".kyos", "claude", "skills", "tech", "SKILL.md");
    fs.writeFileSync(managedTechPath, "# tampered\n", "utf8");

    runUpdateKyos({ cwd });

    const catalogTech = fs.readFileSync(
      path.join(__dirname, "..", "catalog", "claude-base", "claude", "skills", "tech", "SKILL.md"),
      "utf8"
    );
    assert.equal(fs.readFileSync(managedTechPath, "utf8"), catalogTech, ".kyos must be reset to baseline");
  });

  test("stale detection reports a pre-migration commands/tech.md-shaped lock entry", () => {
    const cwd = mkTempDir("kyos-stale-commands-");
    runBootstrap({ cwd, apply: false });

    const lockPath = path.join(cwd, ".kyos", "lock.json");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.files[".kyos/claude/commands/tech.md"] = { checksum: "deadbeef", managed: true };
    fs.writeFileSync(lockPath, JSON.stringify(lock), "utf8");

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => String(w).toLowerCase().includes("stale")));
    assert.ok(
      result.lines.some(
        (line) => String(line).includes(".kyos/claude/commands/tech.md") && String(line).includes("no longer part")
      )
    );
  });

  test("doctor is silent on a foreign SKILL.md dropped under .claude/skills/", () => {
    const cwd = mkTempDir("kyos-foreign-skill-");
    runBootstrap({ cwd, apply: false });

    const foreignDir = path.join(cwd, ".claude", "skills", "some-third-party-skill");
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, "SKILL.md"), "---\nname: some-third-party-skill\n---\n\n# Foreign\n", "utf8");

    const doctor = runDoctor({ cwd });
    assert.equal(doctor.ok, true);
    assert.ok(!doctor.warnings.some((w) => String(w).includes("some-third-party-skill")));
    assert.ok(!doctor.errors.some((e) => String(e).includes("some-third-party-skill")));

    const lock = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "lock.json"), "utf8"));
    assert.ok(
      !Object.keys(lock.files).some((key) => key.includes("some-third-party-skill")),
      "foreign skill must not be lock-tracked"
    );
  });

  test("marketplace.json declares exactly the skills in the registry, each resolving to a real SKILL.md", () => {
    const marketplace = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "marketplace.json"), "utf8")
    );
    const registry = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "catalog", "registry.json"), "utf8")
    );

    const manifestNames = marketplace.plugins
      .flatMap((plugin) => plugin.skills)
      .map((skillPath) => skillPath.split("/").pop())
      .sort();
    const registryNames = Object.keys(registry.skills).sort();

    assert.deepEqual(manifestNames, registryNames);

    for (const plugin of marketplace.plugins) {
      for (const skillPath of plugin.skills) {
        const skillMdPath = path.join(__dirname, "..", skillPath.replace(/^\.\//, ""), "SKILL.md");
        assert.ok(fs.existsSync(skillMdPath), `${skillPath} must resolve to a real SKILL.md`);
      }
    }
  });

  test("kyos-setup ships disable-model-invocation, sidecar, registry entry, and manifest inclusion", () => {
    assert.ok(exists(path.join(__dirname, ".."), "catalog/claude-base/claude/skills/kyos-setup/SKILL.md"));
    const skillContent = fs.readFileSync(
      path.join(__dirname, "..", "catalog", "claude-base", "claude", "skills", "kyos-setup", "SKILL.md"),
      "utf8"
    );
    assert.ok(skillContent.includes("disable-model-invocation: true"));
    assert.ok(
      exists(path.join(__dirname, ".."), "catalog/claude-base/claude/skills/kyos-setup/agents/openai.yaml")
    );

    const registry = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "catalog", "registry.json"), "utf8")
    );
    assert.ok(registry.skills["kyos-setup"]);

    const marketplace = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", ".claude-plugin", "marketplace.json"), "utf8")
    );
    const manifestNames = marketplace.plugins.flatMap((plugin) => plugin.skills).map((p) => p.split("/").pop());
    assert.ok(manifestNames.includes("kyos-setup"));
  });

  test("override-check line present in the eight flow/reference skills, absent from critic/silent-execution", () => {
    const flowSkills = ["spec", "tech", "tasks", "implement", "verify", "prevalidate", "architecture", "hire"];
    for (const name of flowSkills) {
      const content = fs.readFileSync(
        path.join(__dirname, "..", "catalog", "claude-base", "claude", "skills", name, "SKILL.md"),
        "utf8"
      );
      assert.ok(content.includes(".claude/skill-overrides/_shared.md"), `${name} must mention _shared.md`);
      assert.ok(content.includes(`.claude/skill-overrides/${name}.md`), `${name} must mention its own override file`);
    }

    for (const name of ["critic", "silent-execution"]) {
      const content = fs.readFileSync(
        path.join(__dirname, "..", "catalog", "claude-base", "claude", "skills", name, "SKILL.md"),
        "utf8"
      );
      assert.ok(!content.includes("skill-overrides"), `${name} must not mention skill-overrides`);
    }
  });

  test("fresh bootstrap has no flow/reference command files, only skill twins", () => {
    const cwd = mkTempDir("kyos-no-commands-");
    runBootstrap({ cwd, apply: false });

    for (const name of ["spec", "tech", "tasks", "implement", "verify", "prevalidate", "architecture", "hire"]) {
      assert.equal(exists(cwd, `.kyos/claude/commands/${name}.md`), false);
      assert.equal(exists(cwd, `.claude/commands/${name}.md`), false);
      assert.ok(exists(cwd, `.claude/skills/${name}/SKILL.md`));
    }
  });

  test("--add skill end-to-end for a converted flow skill (tech)", () => {
    const cwd = mkTempDir("kyos-add-tech-");
    runBootstrap({ cwd, apply: false });
    fs.rmSync(path.join(cwd, ".claude", "skills", "tech"), { recursive: true, force: true });

    const result = addCapability({ cwd, type: "skill", name: "tech" });
    assert.equal(result.ok, true);
    assert.ok(exists(cwd, ".claude/skills/tech/SKILL.md"));
  });

  test("project context lives in skill-overrides/_shared.md, not a commands/ file, in either install schema", () => {
    const cwd = mkTempDir("kyos-project-context-");
    runBootstrap({ cwd, apply: false });

    // kyos-cli schema: seeded automatically, one level above every skill's own directory.
    assert.ok(!exists(cwd, ".claude/commands/project-context.md"));
    assert.ok(!exists(cwd, ".kyos/claude/commands/project-context.md"));
    const shared = fs.readFileSync(path.join(cwd, ".claude", "skill-overrides", "_shared.md"), "utf8");
    assert.ok(shared.includes("Project context"));
    assert.ok(shared.includes("main components"));

    // skills.sh schema: no project-context.md path is referenced by any shipped skill body, so
    // nothing dangles when a repo has no kyos-cli involvement at all.
    for (const name of ["spec", "tech", "architecture", "hire"]) {
      const skillContent = fs.readFileSync(
        path.join(__dirname, "..", "catalog", "claude-base", "claude", "skills", name, "SKILL.md"),
        "utf8"
      );
      assert.ok(!skillContent.includes(".claude/commands/project-context.md"), `${name} must not reference the retired path`);
      assert.ok(skillContent.includes(".claude/skill-overrides/_shared.md"), `${name} must reference _shared.md instead`);
    }
  });
};
