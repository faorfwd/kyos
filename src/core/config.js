const path = require("path");
const {
  MCP_CONFIG_FILE,
  USER_CONFIG_FILE,
} = require("./constants");
const { readJsonIfExists, writeRepoTextFile } = require("./fs");
const { stableStringify } = require("./json");

function getDefaultConfig(repoName) {
  return {
    $schema: "https://example.com/kyos.schema.json",
    repoName,
    extends: ["claude-base"],
    installed: {
      agents: [],
      hooks: [],
      mcps: [],
      skills: [],
    },
    paths: {
      claudeMd: "CLAUDE.md",
      managedSourceDir: ".kyos/claude",
      customClaudeDir: ".claude"
    },
    policy: {
      analyzeExistingBeforeApply: true,
      neverOverwriteUnmanagedFiles: true,
    },
  };
}

function loadUserConfig(cwd, repoName) {
  const configPath = path.resolve(cwd, USER_CONFIG_FILE);
  const config = readJsonIfExists(configPath);
  return config || getDefaultConfig(repoName);
}

function saveUserConfig(cwd, config) {
  writeRepoTextFile(cwd, USER_CONFIG_FILE, stableStringify(config));
}

function loadMcpConfig(cwd) {
  const filePath = path.resolve(cwd, MCP_CONFIG_FILE);
  const data = readJsonIfExists(filePath) || {};
  return { enabledPlugins: data.enabledPlugins || {} };
}

function saveMcpConfig(cwd, mcpConfig) {
  const filePath = path.resolve(cwd, MCP_CONFIG_FILE);
  const existing = readJsonIfExists(filePath) || {};
  writeRepoTextFile(cwd, MCP_CONFIG_FILE, stableStringify({ ...existing, enabledPlugins: mcpConfig.enabledPlugins }));
}

const BASE_AGENT_HOOK = {
  matcher: "Agent",
  hooks: [
    {
      type: "command",
      command:
        "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"PROCESS RULE: A subagent just completed. If the user now reports a bug or issue with its output, re-spawn the SAME agent type via the Agent tool — do NOT call Edit or Write inline. Only fix inline if it is a single-line typo or wiring mistake faster to correct than to brief an agent (per .claude/rules/process.md).\"}}' ",
    },
  ],
};

function mergeSettingsHookEntry(existing, event, entry) {
  const eventEntries = (existing.hooks && existing.hooks[event]) || [];
  return {
    ...existing,
    hooks: {
      ...(existing.hooks || {}),
      [event]: [...eventEntries, entry],
    },
  };
}

function ensureBaseHooks(cwd) {
  const existing = readJsonIfExists(path.resolve(cwd, MCP_CONFIG_FILE)) || {};
  const postToolUse = (existing.hooks && existing.hooks.PostToolUse) || [];
  if (postToolUse.some((entry) => entry.matcher === "Agent")) {
    return false;
  }
  writeRepoTextFile(cwd, MCP_CONFIG_FILE, stableStringify(mergeSettingsHookEntry(existing, "PostToolUse", BASE_AGENT_HOOK)));
  return true;
}

function installHookWiring(cwd, { event, matcher, command }) {
  const existing = readJsonIfExists(path.resolve(cwd, MCP_CONFIG_FILE)) || {};
  const eventEntries = (existing.hooks && existing.hooks[event]) || [];
  const alreadyWired = eventEntries.some(
    (e) => e.matcher === matcher &&
            Array.isArray(e.hooks) &&
            e.hooks.some((h) => h.command === command)
  );
  if (alreadyWired) return;
  const entry = { matcher, hooks: [{ type: "command", command }] };
  writeRepoTextFile(cwd, MCP_CONFIG_FILE, stableStringify(mergeSettingsHookEntry(existing, event, entry)));
}

function addInstalledCapability(config, type, name) {
  const bucket = config.installed[type];
  if (!Array.isArray(bucket)) {
    config.installed[type] = [name];
    return;
  }

  if (!bucket.includes(name)) {
    bucket.push(name);
    bucket.sort();
  }
}

module.exports = {
  addInstalledCapability,
  ensureBaseHooks,
  getDefaultConfig,
  installHookWiring,
  loadMcpConfig,
  loadUserConfig,
  saveMcpConfig,
  saveUserConfig,
};
