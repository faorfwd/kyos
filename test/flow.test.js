const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { runApply, runBootstrap, runDoctor, runUpdateKyos, addCapability } = require("../src/core/workflows");
const { ensureBaseHooks } = require("../src/core/config");

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
    assert.ok(exists(cwd, ".kyos/config.json"));
    assert.ok(exists(cwd, ".kyos/lock.json"));
    assert.ok(exists(cwd, ".claude/settings.json"));
    assert.ok(exists(cwd, ".kyos/claude/rules/README.md"));
    assert.ok(exists(cwd, "CLAUDE.md"));

    assert.ok(exists(cwd, ".kyos/claude/commands/README.md"));
    assert.ok(exists(cwd, ".kyos/claude/commands/spec.md"));
    assert.ok(exists(cwd, ".kyos/claude/agents/security-engineer.md"));
    assert.ok(exists(cwd, ".kyos/claude/skills/silent-execution/SKILL.md"));

    assert.ok(exists(cwd, ".claude/commands/README.md"));
    assert.ok(exists(cwd, ".claude/commands/spec.md"));
    assert.ok(exists(cwd, ".claude/commands/architecture.md"));
    assert.equal(exists(cwd, ".claude/agents/security-engineer.md"), false);

    const managedSpec = fs.readFileSync(path.join(cwd, ".kyos", "claude", "commands", "spec.md"), "utf8");
    const localSpec = fs.readFileSync(path.join(cwd, ".claude", "commands", "spec.md"), "utf8");
    assert.ok(localSpec.includes("../../.kyos/claude/commands/spec.md"));
    assert.ok(localSpec.includes("/kyos:spec"));
    assert.ok(localSpec.length < managedSpec.length);

    const managedArchitecture = fs.readFileSync(
      path.join(cwd, ".kyos", "claude", "commands", "architecture.md"),
      "utf8"
    );
    const localArchitecture = fs.readFileSync(path.join(cwd, ".claude", "commands", "architecture.md"), "utf8");
    assert.ok(localArchitecture.includes("../../.kyos/claude/commands/architecture.md"));
    assert.ok(localArchitecture.includes("/kyos:architecture"));
    assert.ok(localArchitecture.length < managedArchitecture.length);

    const managedReadme = fs.readFileSync(path.join(cwd, ".kyos", "claude", "commands", "README.md"), "utf8");
    const localReadme = fs.readFileSync(path.join(cwd, ".claude", "commands", "README.md"), "utf8");
    assert.ok(localReadme.includes("../../.kyos/claude/commands/README.md"));
    assert.ok(localReadme.length < managedReadme.length);

    const catalogSpec = fs.readFileSync(
      path.join(__dirname, "..", "catalog", "claude-base", "claude", "commands", "spec.md"),
      "utf8"
    );
    assert.equal(managedSpec, catalogSpec);
    assert.ok(exists(cwd, ".claude/agents/README.md"));
    assert.ok(exists(cwd, ".claude/rules/README.md"));
    assert.ok(exists(cwd, ".claude/skills/README.md"));
    assert.ok(exists(cwd, ".claude/skills/silent-execution/SKILL.md"));

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
    fs.writeFileSync(path.join(cwd, ".kyos", "config.json"), JSON.stringify({}), "utf8");
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
    assert.equal(settings.permissions.defaultMode, "ask", "original permissions must be preserved");
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

    fs.rmSync(path.join(cwd, ".kyos", "claude", "commands", "spec.md"));

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => String(w).toLowerCase().includes("--force")));
  });

  test("doctor is ok after bootstrap", () => {
    const cwd = mkTempDir("kyos-flow-");
    runBootstrap({ cwd, apply: false });

    const doctor = runDoctor({ cwd });
    assert.equal(doctor.ok, true);
    assert.ok(doctor.lines.some((line) => String(line).includes("command: architecture.md local wrapper ok")));
    assert.ok(doctor.lines.some((line) => String(line).includes("command: architecture.md") && String(line).includes("managed ok")));
  });

  test("doctor reports when a .claude command wrapper changes", () => {
    const cwd = mkTempDir("kyos-flow-");
    runBootstrap({ cwd, apply: false });

    const architecturePath = path.join(cwd, ".claude", "commands", "architecture.md");
    const original = fs.readFileSync(architecturePath, "utf8");
    fs.writeFileSync(architecturePath, `${original}\ncustom note\n`, "utf8");

    const doctor = runDoctor({ cwd });
    assert.equal(doctor.ok, true);
    assert.ok(
      doctor.lines.some((line) => String(line).includes("command: architecture.md") && String(line).includes("local changed"))
    );
  });

  test("--force resets .claude/.kyos/CLAUDE.md", () => {
    const cwd = mkTempDir("kyos-force-");
    runBootstrap({ cwd, apply: false });

    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "# custom\n", "utf8");
    fs.writeFileSync(path.join(cwd, ".claude", "commands", "spec.md"), "# custom spec\n", "utf8");
    fs.mkdirSync(path.join(cwd, ".claude", "commands", "extra"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "commands", "extra", "note.md"), "hello", "utf8");

    const result = runBootstrap({ cwd, apply: false, force: true });
    assert.equal(result.ok, true);

    const resetClaude = fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8");
    assert.ok(resetClaude.includes("kyos-cli"));
    assert.notEqual(resetClaude, "# custom\n");

    assert.equal(exists(cwd, ".claude/commands/extra/note.md"), false);

    const localSpec = fs.readFileSync(path.join(cwd, ".claude", "commands", "spec.md"), "utf8");
    assert.ok(localSpec.includes("../../.kyos/claude/commands/spec.md"));
    assert.ok(localSpec.includes("/kyos:spec"));

    assert.ok(exists(cwd, ".kyos/claude/commands/spec.md"));
  });

  test("--update rewrites only .kyos", () => {
    const cwd = mkTempDir("kyos-update-");
    runBootstrap({ cwd, apply: false });

    const localSpecPath = path.join(cwd, ".claude", "commands", "spec.md");
    fs.writeFileSync(localSpecPath, "# custom spec\n", "utf8");

    const managedSpecPath = path.join(cwd, ".kyos", "claude", "commands", "spec.md");
    fs.writeFileSync(managedSpecPath, "# tampered managed spec\n", "utf8");

    const result = runUpdateKyos({ cwd });
    assert.equal(result.ok, true);

    // .claude should be untouched
    assert.equal(fs.readFileSync(localSpecPath, "utf8"), "# custom spec\n");

    // .kyos should be regenerated to catalog baseline
    const catalogSpec = fs.readFileSync(
      path.join(__dirname, "..", "catalog", "claude-base", "claude", "commands", "spec.md"),
      "utf8"
    );
    assert.equal(fs.readFileSync(managedSpecPath, "utf8"), catalogSpec);

    // .kyos/config.json must survive the reset
    assert.ok(exists(cwd, ".kyos/config.json"), ".kyos/config.json should not be deleted by --update");
  });

  test("--update preserves user config across reset", () => {
    const cwd = mkTempDir("kyos-update-config-");
    runBootstrap({ cwd, apply: false });

    // Add a capability so config.json has non-default content
    addCapability({ cwd, type: "skill", name: "release-notes" });

    const configPath = path.join(cwd, ".kyos", "config.json");
    const configBefore = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.ok(configBefore.installed.skills.includes("release-notes"));

    runUpdateKyos({ cwd });

    const configAfter = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(configAfter, configBefore, "config.json must be identical after --update");
  });

  test(".claude command wrappers are not overwritten if customized", () => {
    const cwd = mkTempDir("kyos-flow-");
    runBootstrap({ cwd, apply: false });

    const localSpecPath = path.join(cwd, ".claude", "commands", "spec.md");
    fs.writeFileSync(localSpecPath, "# custom spec\n", "utf8");

    runBootstrap({ cwd, apply: true });

    const after = fs.readFileSync(localSpecPath, "utf8");
    assert.equal(after, "# custom spec\n");
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

    const result = addCapability({ cwd, type: "skill", name: "release-notes" });
    assert.equal(result.ok, true);
    assert.ok(exists(cwd, ".claude/skills/release-notes/SKILL.md"));
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

    const specPath = path.join(cwd, ".kyos", "claude", "commands", "spec.md");
    const originalSpec = fs.readFileSync(specPath, "utf8");
    fs.rmSync(specPath);

    const localSpecPath = path.join(cwd, ".claude", "commands", "spec.md");
    fs.writeFileSync(localSpecPath, "# custom spec\n", "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes("1 created"));

    assert.ok(exists(cwd, ".kyos/claude/commands/spec.md"));
    assert.equal(fs.readFileSync(specPath, "utf8"), originalSpec);

    assert.equal(fs.readFileSync(localSpecPath, "utf8"), "# custom spec\n");
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

    const specPath = path.join(cwd, ".kyos", "claude", "commands", "spec.md");
    fs.rmSync(specPath);

    const lockBefore = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "lock.json"), "utf8"));
    const specKey = ".kyos/claude/commands/spec.md";
    delete lockBefore.files[specKey];
    fs.writeFileSync(path.join(cwd, ".kyos", "lock.json"), JSON.stringify(lockBefore), "utf8");

    runApply({ cwd });

    const lockAfter = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "lock.json"), "utf8"));
    assert.ok(lockAfter.files[specKey], "lock should have an entry for the created file");
    assert.ok(lockAfter.files[specKey].checksum, "lock entry should have a checksum");
  });

  test("analysis warning mentions --apply when safe creates exist", () => {
    const cwd = mkTempDir("kyos-apply-warning-");
    runBootstrap({ cwd, apply: false });

    fs.rmSync(path.join(cwd, ".kyos", "claude", "commands", "spec.md"));

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

    const managedSpecPath = path.join(cwd, ".kyos", "claude", "commands", "spec.md");
    fs.writeFileSync(managedSpecPath, "# custom edit\n", "utf8");

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes("1 managed conflicts"), `expected conflict in summary: ${result.summary}`);
    assert.ok(result.lines.some((line) => String(line).includes("spec.md") && String(line).includes("local changes")));
  });

  test("blocked detected when an unmanaged file occupies a managed path", () => {
    const cwd = mkTempDir("kyos-blocked-");
    runBootstrap({ cwd, apply: false });

    const lockPath = path.join(cwd, ".kyos", "lock.json");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const managedKey = ".kyos/claude/commands/spec.md";
    delete lock.files[managedKey];
    fs.writeFileSync(lockPath, JSON.stringify(lock), "utf8");

    const specPath = path.join(cwd, ".kyos", "claude", "commands", "spec.md");
    fs.writeFileSync(specPath, "# unmanaged content\n", "utf8");

    const result = runBootstrap({ cwd, apply: false });
    assert.equal(result.ok, true);
    assert.ok(result.summary.includes("1 unmanaged blockers"), `expected blocker in summary: ${result.summary}`);
    assert.ok(result.lines.some((line) => String(line).includes("spec.md")));
  });

  test("add agent creates a local stub and records in config", () => {
    const cwd = mkTempDir("kyos-add-agent-");
    runBootstrap({ cwd, apply: false });

    const result = addCapability({ cwd, type: "agent", name: "triage" });
    assert.equal(result.ok, true);
    assert.ok(exists(cwd, ".claude/agents/triage.md"));

    const config = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "config.json"), "utf8"));
    assert.ok((config.installed.agents || []).includes("triage"));
  });

  test("add mcp writes to .claude/settings.json and records in config", () => {
    const cwd = mkTempDir("kyos-add-mcp-");
    runBootstrap({ cwd, apply: false });

    const result = addCapability({ cwd, type: "mcp", name: "context7" });
    assert.equal(result.ok, true);

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.enabledPlugins && settings.enabledPlugins["context7@claude-plugins-official"] === true, "context7 entry should exist in enabledPlugins");
    assert.ok(settings.permissions, "existing settings keys must be preserved");

    const config = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "config.json"), "utf8"));
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

    const config = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "config.json"), "utf8"));
    assert.equal(config.installed.mcps.filter((n) => n === "context7").length, 1, "installed.mcps should not duplicate");
  });

  test("add skill records capability in config.json", () => {
    const cwd = mkTempDir("kyos-add-skill-config-");
    runBootstrap({ cwd, apply: false });

    const result = addCapability({ cwd, type: "skill", name: "path-safety" });
    assert.equal(result.ok, true);

    const config = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "config.json"), "utf8"));
    assert.ok((config.installed.skills || []).includes("path-safety"));
  });

  test("--apply replays installed skill stub when .claude file is missing", () => {
    const cwd = mkTempDir("kyos-apply-installed-skill-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "skill", name: "release-notes" });

    // simulate fresh clone: remove the .claude stub that --add wrote
    const stubPath = path.join(cwd, ".claude", "skills", "release-notes", "SKILL.md");
    fs.rmSync(stubPath);
    assert.equal(exists(cwd, ".claude/skills/release-notes/SKILL.md"), false);

    const result = runApply({ cwd });
    assert.equal(result.ok, true);
    assert.ok(exists(cwd, ".claude/skills/release-notes/SKILL.md"), "stub should be recreated by --apply");
    assert.ok(result.lines.some((l) => String(l).includes("release-notes")));
  });

  test("--apply replays installed agent stub when .claude file is missing", () => {
    const cwd = mkTempDir("kyos-apply-installed-agent-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "agent", name: "triage" });

    const stubPath = path.join(cwd, ".claude", "agents", "triage.md");
    fs.rmSync(stubPath);
    assert.equal(exists(cwd, ".claude/agents/triage.md"), false);

    const result = runApply({ cwd });
    assert.equal(result.ok, true);
    assert.ok(exists(cwd, ".claude/agents/triage.md"), "agent stub should be recreated by --apply");
    assert.ok(result.lines.some((l) => String(l).includes("triage")));
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
    addCapability({ cwd, type: "skill", name: "release-notes" });

    const stubPath = path.join(cwd, ".claude", "skills", "release-notes", "SKILL.md");
    const contentBefore = fs.readFileSync(stubPath, "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);

    const contentAfter = fs.readFileSync(stubPath, "utf8");
    assert.equal(contentAfter, contentBefore, "existing stub must not be modified");
    assert.ok(!result.lines.some((l) => String(l).includes("release-notes")), "no line for already-present stub");
  });

  test("--apply does not duplicate installed agent stub when already present", () => {
    const cwd = mkTempDir("kyos-apply-agent-noop-");
    runBootstrap({ cwd, apply: false });
    addCapability({ cwd, type: "agent", name: "triage" });

    const stubPath = path.join(cwd, ".claude", "agents", "triage.md");
    const contentBefore = fs.readFileSync(stubPath, "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);

    const contentAfter = fs.readFileSync(stubPath, "utf8");
    assert.equal(contentAfter, contentBefore, "existing agent stub must not be modified");
    assert.ok(!result.lines.some((l) => String(l).includes("triage")), "no line for already-present agent");
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

    const config = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "config.json"), "utf8"));
    assert.ok(Array.isArray(config.installed.hooks), "installed.hooks must be an array");
    assert.ok(config.installed.hooks.includes("repo-sandbox"), "installed.hooks must contain repo-sandbox");
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

    const config = JSON.parse(fs.readFileSync(path.join(cwd, ".kyos", "config.json"), "utf8"));
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
};
