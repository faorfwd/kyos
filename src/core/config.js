const fs = require("fs");
const path = require("path");
const {
  FRAMEWORK_PACKAGE,
  FRAMEWORK_VERSION,
  HOOK_MARKER_PREFIX,
  LEGACY_USER_CONFIG_FILE,
  MCP_CONFIG_FILE,
  USER_CONFIG_FILE,
} = require("./constants");
const { readJsonIfExists, resolveRepoPath, writeRepoTextFile } = require("./fs");
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
  const config = readJsonIfExists(path.resolve(cwd, USER_CONFIG_FILE));
  if (config) return config;
  // Fall back to the pre-1.4 location so existing repos keep working until they
  // migrate (via --doctor --fix or any write of the new config).
  const legacy = readJsonIfExists(path.resolve(cwd, LEGACY_USER_CONFIG_FILE));
  return legacy || getDefaultConfig(repoName);
}

function saveUserConfig(cwd, config) {
  writeRepoTextFile(cwd, USER_CONFIG_FILE, stableStringify(config));
  // Any write migrates a pre-1.4 repo: drop the gitignored legacy copy so it can't
  // drift from the committable kyos.json. No-op when the legacy file is absent.
  fs.rmSync(resolveRepoPath(cwd, LEGACY_USER_CONFIG_FILE), { force: true });
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

// The full marker written into a command comment: the (unchanged) match key plus the
// package@version that wrote it. Detection still keys off `hookMarker(name)` alone, so
// older entries without the `package=` segment keep matching.
function hookMarkerWithPackage(name) {
  return `${hookMarker(name)} package=${FRAMEWORK_PACKAGE}@${FRAMEWORK_VERSION}`;
}

// Read the kyos hook name off a command comment (`managedBy=kyos/<name>`), or null.
function parseOwnedHookName(command) {
  if (typeof command !== "string") return null;
  const match = command.match(/managedBy=kyos\/([^\s#]+)/);
  return match ? match[1] : null;
}

// Read the package version off a command comment (`package=kyos-cli@<version>`), or null.
// Null means a pre-package (legacy) marker — still kyos-owned, just unversioned.
function parsePackageVersion(command) {
  if (typeof command !== "string") return null;
  const match = command.match(/package=kyos-cli@([^\s#]+)/);
  return match ? match[1] : null;
}

// Numeric `a.b.c` compare. Null/non-numeric versions sort lowest (a pre-package marker
// never beats a versioned one). Returns negative/zero/positive like a comparator.
function compareHookVersions(a, b) {
  const parse = (v) => {
    if (typeof v !== "string") return null;
    const parts = v.split(".").map((n) => Number(n));
    return parts.some((n) => !Number.isInteger(n)) ? null : parts;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

// Version recorded on the marked hook within an entry (matched via `marker`), or null.
function ownedEntryVersion(entry, marker) {
  if (!Array.isArray(entry.hooks)) return null;
  const hook = entry.hooks.find((h) => typeof h.command === "string" && h.command.includes(marker));
  return hook ? parsePackageVersion(hook.command) : null;
}

// True when any of an entry's commands carries a kyos marker (any name).
function entryIsKyosOwned(entry) {
  return Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => typeof h.command === "string" && /managedBy=kyos\//.test(h.command));
}

const BASE_AGENT_HOOK_PAYLOAD =
  "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"PROCESS RULE: A subagent just completed. If the user now reports a bug or issue with its output, re-spawn the SAME agent type via the Agent tool — do NOT call Edit or Write inline. Only fix inline if it is a single-line typo or wiring mistake faster to correct than to brief an agent.\"}}' ";

const BASE_AGENT_MARKER = hookMarker("base-agent");
const BASE_AGENT_HOOK = {
  matcher: "Agent",
  hooks: [
    {
      type: "command",
      command: `${BASE_AGENT_HOOK_PAYLOAD}# ${hookMarkerWithPackage("base-agent")}`,
    },
  ],
};

// Stable content signature of the base-agent payload — recognizes our entry across
// whitespace/version differences without clobbering a foreign Agent hook.
const BASE_AGENT_SIGNATURE = "PROCESS RULE: A subagent just completed";

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

// Pure, read-only scan of settings.json for hook-wiring problems. `managedHooks` is the
// set of hooks the repo knows about (each `{ name, event, matcher }`); `runningVersion`
// is the version the CLI would write. Returns three finding lists, no I/O.
function auditHookEntries(settings, { managedHooks, runningVersion }) {
  const duplicates = [];
  const staleVersions = [];
  const unmarkedShadows = [];
  const hooks = (settings && settings.hooks) || {};

  for (const { name, event, matcher } of managedHooks) {
    const marker = hookMarker(name);
    const eventEntries = hooks[event] || [];
    const owned = eventEntries.filter((e) => entryHasMarker(e, marker));

    if (owned.length >= 2) {
      duplicates.push({
        event,
        name,
        count: owned.length,
        versions: owned.map((e) => ownedEntryVersion(e, marker)),
      });
    } else if (owned.length === 1) {
      const version = ownedEntryVersion(owned[0], marker);
      if (version !== runningVersion) {
        staleVersions.push({ event, name, version });
      }
    }

    if (owned.length >= 1) {
      const hasUnmarkedShadow = eventEntries.some(
        (e) => e.matcher === matcher && !entryIsKyosOwned(e)
      );
      if (hasUnmarkedShadow) {
        unmarkedShadows.push({ event, name, matcher });
      }
    }
  }

  return { duplicates, staleVersions, unmarkedShadows };
}

// Collapse duplicate kyos-owned entries for a hook to a single survivor: the
// highest-version one, kept verbatim (no version pull). Returns null when there is
// nothing to collapse (owned count <= 1). Non-owned entries are left untouched.
function dedupeMarkedHookEntry(existing, event, { name, marker }) {
  const eventEntries = (existing.hooks && existing.hooks[event]) || [];
  const marked = eventEntries.filter((e) => entryHasMarker(e, marker));
  if (marked.length <= 1) return null;

  let survivor = marked[0];
  let survivorVersion = ownedEntryVersion(survivor, marker);
  for (const entry of marked.slice(1)) {
    const version = ownedEntryVersion(entry, marker);
    if (compareHookVersions(version, survivorVersion) > 0) {
      survivor = entry;
      survivorVersion = version;
    }
  }

  const next = eventEntries.filter((e) => !entryHasMarker(e, marker) || e === survivor);
  return {
    name,
    count: marked.length,
    version: survivorVersion,
    settings: { ...existing, hooks: { ...(existing.hooks || {}), [event]: next } },
  };
}

function ensureBaseHooks(cwd, { adoptLegacy = false, updateOnly = false } = {}) {
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

  // No marked entry exists.
  const postToolUse = (existing.hooks && existing.hooks.PostToolUse) || [];

  // Adopt a legacy unmarked Agent entry only when it carries our payload signature —
  // a foreign Agent hook is never overwritten.
  if (adoptLegacy) {
    const legacyIndex = postToolUse.findIndex(
      (entry) =>
        entry.matcher === "Agent" &&
        Array.isArray(entry.hooks) &&
        entry.hooks.some(
          (h) => typeof h.command === "string" && h.command.includes(BASE_AGENT_SIGNATURE)
        )
    );
    if (legacyIndex !== -1) {
      const next = postToolUse.map((entry, i) => (i === legacyIndex ? BASE_AGENT_HOOK : entry));
      writeRepoTextFile(
        cwd,
        MCP_CONFIG_FILE,
        stableStringify({ ...existing, hooks: { ...(existing.hooks || {}), PostToolUse: next } })
      );
      return true;
    }
  }

  // Update-only never appends a base-agent entry where none exists.
  if (updateOnly) return false;

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

// Update-only wiring: refresh the existing marked entry in place when stale, but never
// append. Returns `{ action: "absent" }` when no marked entry exists (caller skips).
function refreshHookWiring(cwd, { event, matcher, command, marker }) {
  const existing = readJsonIfExists(path.resolve(cwd, MCP_CONFIG_FILE)) || {};
  const reconciled = reconcileMarkedHookEntry(existing, event, { matcher, command, marker });
  if (!reconciled) return { action: "absent" };
  if (reconciled.action === "none") return { action: "none" };
  writeRepoTextFile(cwd, MCP_CONFIG_FILE, stableStringify(reconciled.settings));
  return { action: "updated" };
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
  auditHookEntries,
  compareHookVersions,
  dedupeMarkedHookEntry,
  ensureBaseHooks,
  getDefaultConfig,
  hookMarker,
  hookMarkerWithPackage,
  installHookWiring,
  loadMcpConfig,
  loadUserConfig,
  parseOwnedHookName,
  parsePackageVersion,
  refreshHookWiring,
  saveMcpConfig,
  saveUserConfig,
};
