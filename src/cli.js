const {
  FRAMEWORK_NAME,
  USER_CONFIG_FILE,
} = require("./core/constants");
const { version: FRAMEWORK_VERSION } = require("../package.json");
const {
  addCapability,
  runApply,
  runBootstrap,
  runDoctor,
  runUpdateKyos,
} = require("./core/workflows");

function printHelp() {
  console.log(`${FRAMEWORK_NAME} v${FRAMEWORK_VERSION}

Usage:
  kyos-cli --init [--force]
  kyos-cli --apply
  kyos-cli --update
  kyos-cli --add <skill|agent|mcp|hook> <name>
  kyos-cli --doctor
Notes:
  - Commands run against the current working directory only.
  - Use '--init' to install a base Claude structure when none exists yet.
  - If .claude/ or CLAUDE.md already exists, '--init' switches to analysis mode and proposes updates without changing files.
  - Use '--apply' to write managed files that are missing from the repo (create-only, never overwrites existing files).
  - Use '--update' to forcibly rewrite only .kyos/ to the current baseline (destructive to .kyos only).
  - Use '--force' with '--init' to reset .claude/, .kyos/, and CLAUDE.md to the current managed baseline (destructive).
  - Use '--add' to install a skill, agent, MCP, or hook from the catalog.
  - Use '--doctor' to check managed file integrity and report drift.
  - Managed state lives in .kyos/.
  - Managed source files live in .kyos/claude/, while repo customizations live in .claude/.
  - User-editable configuration lives in ${USER_CONFIG_FILE}.`);
}

function printResult(result) {
  if (result.summary) {
    console.log(result.summary);
  }

  if (result.lines && result.lines.length > 0) {
    for (const line of result.lines) {
      console.log(line);
    }
  }

  if (result.warnings && result.warnings.length > 0) {
    console.log("");
    for (const warning of result.warnings) {
      console.warn(`warning: ${warning}`);
    }
  }

  if (result.errors && result.errors.length > 0) {
    console.log("");
    for (const error of result.errors) {
      console.error(`error: ${error}`);
    }
  }

  process.exitCode = result.ok ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const hasFlag = (flag) => args.includes(flag);
  const force = hasFlag("--force");

  if (hasFlag("--help") || hasFlag("-h")) {
    printHelp();
    return;
  }

  if (args.length === 0 || hasFlag("--init")) {
    printResult(runBootstrap({ cwd, apply: false, force }));
    return;
  }

  if (hasFlag("--update")) {
    printResult(runUpdateKyos({ cwd }));
    return;
  }

  if (hasFlag("--apply")) {
    if (force) {
      printResult({
        ok: false,
        errors: ["--apply and --force cannot be used together. Use '--init --force' to reset everything to baseline."],
      });
      return;
    }
    printResult(runApply({ cwd }));
    return;
  }

  if (hasFlag("--doctor")) {
    printResult(runDoctor({ cwd }));
    return;
  }

  if (hasFlag("--add")) {
    const addIndex = args.indexOf("--add");
    const type = args[addIndex + 1];
    const name = args[addIndex + 2];

    if (!type || !name) {
      printResult({
        ok: false,
        errors: ["Usage: kyos --add <skill|agent|mcp|hook> <name>"],
      });
      return;
    }

    printResult(addCapability({ cwd, type, name }));
    return;
  }

  printResult({
    ok: false,
    errors: ["Unknown arguments. Run 'kyos-cli --help' for usage."],
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
