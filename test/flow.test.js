const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runApply, runBootstrap, runDoctor, runUpdateKyos, addCapability } = require("../src/core/workflows");

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
    assert.ok(settings.enabledPlugins && settings.enabledPlugins.context7 === true, "context7 entry should exist in enabledPlugins");
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
    assert.ok(settings.enabledPlugins && settings.enabledPlugins.context7 === true, "context7 entry should exist");
  });

  test("add mcp accumulates multiple MCPs without overwriting earlier ones", () => {
    const cwd = mkTempDir("kyos-add-mcp-multi-");
    runBootstrap({ cwd, apply: false });

    addCapability({ cwd, type: "mcp", name: "context7" });
    addCapability({ cwd, type: "mcp", name: "filesystem" });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.enabledPlugins.context7 === true, "context7 must still be present");
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
    delete settings.enabledPlugins.context7;
    fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");

    const result = runApply({ cwd });
    assert.equal(result.ok, true);

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.ok(after.enabledPlugins && after.enabledPlugins.context7 === true, "context7 should be re-registered by --apply");
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
};
