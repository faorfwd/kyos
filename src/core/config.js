const path = require("path");
const {
  HOOK_MARKER_PREFIX,
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

function hookMarker(name) {
  return `${HOOK_MARKER_PREFIX}${name}`;
}

const BASE_AGENT_HOOK_PAYLOAD =
  "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"PROCESS RULE: A subagent just completed. If the user now reports a bug or issue with its output, re-spawn the SAME agent type via the Agent tool — do NOT call Edit or Write inline. Only fix inline if it is a single-line typo or wiring mistake faster to correct than to brief an agent (per .claude/rules/process.md).\"}}' ";

// Exact command written by pre-marker releases; recognized once for in-place migration.
const LEGACY_BASE_AGENT_COMMAND = BASE_AGENT_HOOK_PAYLOAD;

const BASE_AGENT_MARKER = hookMarker("base-agent");
const BASE_AGENT_HOOK = {
  matcher: "Agent",
  hooks: [
    {
      type: "command",
      command: `${BASE_AGENT_HOOK_PAYLOAD}# ${BASE_AGENT_MARKER}`,
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

function entryHasMarker(entry, marker) {
  return Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => typeof h.command === "string" && h.command.includes(marker));
}

// Reconcile the single kyos-owned (marked) entry for an event: update it in place
// when stale and drop marked duplicates. Returns null when no marked entry exists
// (the caller decides whether to append). Never touches unmarked entries.
function reconcileMarkedHookEntry(existing, event, { matcher, command, marker }) {
  const eventEntries = (existing.hooks && existing.hooks[event]) || [];
  const marked = eventEntries.filter((e) => entryHasMarker(e, marker));
  if (marked.length === 0) return null;

  const first = marked[0];
  const upToDate =
    marked.length === 1 &&
    first.matcher === matcher &&
    first.hooks.length === 1 &&
    first.hooks[0].command === command;
  if (upToDate) return { action: "none", settings: existing };

  const next = eventEntries
    .filter((e) => !entryHasMarker(e, marker) || e === first)
    .map((e) => (e === first ? { matcher, hooks: [{ type: "command", command }] } : e));
  return {
    action: "updated",
    settings: { ...existing, hooks: { ...(existing.hooks || {}), [event]: next } },
  };
}

function ensureBaseHooks(cwd) {
  const existing = readJsonIfExists(path.resolve(cwd, MCP_CONFIG_FILE)) || {};
  const desired = {
    matcher: BASE_AGENT_HOOK.matcher,
    command: BASE_AGENT_HOOK.hooks[0].command,
    marker: BASE_AGENT_MARKER,
  };

  const reconciled = reconcileMarkedHookEntry(existing, "PostToolUse", desired);
  if (reconciled) {
    if (reconciled.action === "none") return false;
    writeRepoTextFile(cwd, MCP_CONFIG_FILE, stableStringify(reconciled.settings));
    return true;
  }

  const postToolUse = (existing.hooks && existing.hooks.PostToolUse) || [];
  const isLegacy = (e) => Array.isArray(e.hooks) &&
    e.hooks.some((h) => h.command === LEGACY_BASE_AGENT_COMMAND);
  if (postToolUse.some(isLegacy)) {
    const next = postToolUse.map((e) => (isLegacy(e) ? BASE_AGENT_HOOK : e));
    writeRepoTextFile(cwd, MCP_CONFIG_FILE, stableStringify({
      ...existing,
      hooks: { ...(existing.hooks || {}), PostToolUse: next },
    }));
    return true;
  }

  if (postToolUse.some((entry) => entry.matcher === "Agent")) {
    return false;
  }
  writeRepoTextFile(cwd, MCP_CONFIG_FILE, stableStringify(mergeSettingsHookEntry(existing, "PostToolUse", BASE_AGENT_HOOK)));
  return true;
}

function installHookWiring(cwd, { event, matcher, command, marker }) {
  const existing = readJsonIfExists(path.resolve(cwd, MCP_CONFIG_FILE)) || {};
  const reconciled = reconcileMarkedHookEntry(existing, event, { matcher, command, marker });
  if (reconciled) {
    if (reconciled.action === "none") return { action: "none" };
    writeRepoTextFile(cwd, MCP_CONFIG_FILE, stableStringify(reconciled.settings));
    return { action: "updated" };
  }
  const entry = { matcher, hooks: [{ type: "command", command }] };
  writeRepoTextFile(cwd, MCP_CONFIG_FILE, stableStringify(mergeSettingsHookEntry(existing, event, entry)));
  return { action: "added" };
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
  hookMarker,
  installHookWiring,
  loadMcpConfig,
  loadUserConfig,
  saveMcpConfig,
  saveUserConfig,
};
