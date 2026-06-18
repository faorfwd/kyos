const path = require("path");
const { version: FRAMEWORK_VERSION } = require("../../package.json");

const FRAMEWORK_NAME = "kyos";
const FRAMEWORK_PACKAGE = "kyos-cli";
const STATE_ROOT = ".kyos";
const CLAUDE_ROOT = ".claude";
const MANAGED_ROOT = path.posix.join(STATE_ROOT, "claude");
const CLAUDE_MD_FILE = "CLAUDE.md";
const LOCK_FILE = path.posix.join(STATE_ROOT, "lock.json");
const VERSION_FILE = path.posix.join(STATE_ROOT, "version.json");
const USER_CONFIG_FILE = "kyos.json";
// Pre-1.4 location of the user config, inside the gitignored state dir. Kept for
// read fallback and for --doctor --fix migration to USER_CONFIG_FILE at repo root.
const LEGACY_USER_CONFIG_FILE = path.posix.join(STATE_ROOT, "config.json");
const MCP_CONFIG_FILE = path.posix.join(CLAUDE_ROOT, "settings.json");
const CATALOG_DIR = path.resolve(__dirname, "../../catalog");
const CATALOG_FILE = path.join(CATALOG_DIR, "registry.json");
const HOOK_MARKER_PREFIX = "managedBy=kyos/";

module.exports = {
  CATALOG_DIR,
  CATALOG_FILE,
  CLAUDE_MD_FILE,
  CLAUDE_ROOT,
  FRAMEWORK_NAME,
  FRAMEWORK_PACKAGE,
  FRAMEWORK_VERSION,
  HOOK_MARKER_PREFIX,
  LEGACY_USER_CONFIG_FILE,
  LOCK_FILE,
  MANAGED_ROOT,
  MCP_CONFIG_FILE,
  STATE_ROOT,
  USER_CONFIG_FILE,
  VERSION_FILE,
};
