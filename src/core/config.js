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
  getDefaultConfig,
  loadMcpConfig,
  loadUserConfig,
  saveMcpConfig,
  saveUserConfig,
};
