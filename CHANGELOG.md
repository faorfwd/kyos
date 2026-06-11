# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.2.0] - 2026-06-11
### Changed
- fix(ci): publish to npm on version tag push instead of GitHub release
- chore: updating README with hooksinformation
- feat: add support for hooks with repo-sandbox capability and related functionality
- Potential fix for code scanning alert no. 1: Workflow does not contain permissions

## [0.3.4] - 2026-04-27
### Changed
- fix: move /kyos:release command to repo-local .claude — not a catalog export

## [0.3.3] - 2026-04-27
### Changed
- feat: add /kyos:release command for full branch-based release workflow

## [0.3.2] - 2026-04-27
### Changed
- fix: scrub remaining grillme references from product-manager agent prose

## [0.3.1] - 2026-04-27
### Changed
- feat: replace grillme skill with critic in baseline catalog

## [0.3.0] - 2026-04-27
### Changed
- feat: add product-manager agent and grillme skill to baseline catalog

## [0.2.13] - 2026-04-27
### Changed
- chore: improve Socket score — author, provenance, eslint, CHANGELOG, security docs

## [0.2.12] - 2026-04-25
### Added
- `--doctor` command: checks managed file integrity and reports drift
- Manifest generation for managed-file baselines
- Baseline guard in `managed-files.js` to prevent silent overwrites
- Release script (`scripts/release.js`) with clean-tree assertion, version bump, test gate, and tag

## [0.2.11] - 2026-04-24
### Added
- GitHub Actions publish pipeline with npm provenance attestation
- `SECURITY.md` shipped in the tarball
- `package-lock.json` committed and kept in sync
### Changed
- Renamed `silent-executor` skill to `silent-execution` for consistency

## [0.2.10] - 2026-04-23
### Added
- `--update` flag: force-regenerates `.kyos/` without touching `.claude/`
- New default agent and skill seeded on `--init`
- `.kyos/` added to `.gitignore` on first bootstrap
### Changed
- Refactored skill and agent catalog structure
- Updated `/kyos:implement` and `/kyos:tasks` command prompts

## [0.2.9] - 2026-04-22
### Added
- `security-engineer` agent and `/kyos:prevalidate` command
- Catalog-based managed commands with `--init --force` destructive reset path

## [0.2.8] - 2026-04-21
### Added
- Hardened write paths, write-through-symlink protection
- `rules/` folder seeded on bootstrap
- Integration test suite (`test/flow.test.js`)
- `.kyos/`/`.claude/` two-layer architecture finalized
### Changed
- Migrated local commands and skills to new layer model
- Aligned CLI messaging and `npx kyos-cli` usage docs

## [0.2.7] - 2026-04-20
### Added
- `/kyos:architecture`, `/kyos:hire`, `/kyos:spec`, `/kyos:tech`, `/kyos:implement`, `/kyos:tasks`, `/kyos:verify` workflow commands
- Hardened capability path handling
- Security audit skills in catalog
### Changed
- Renamed CLI from `bootstrap` to `kyos`
- Prepared package for npm publish

## [0.1.0] - 2026-04-20
### Added
- Initial commit: basic bootstrap CLI, `.claude/` layout generation
