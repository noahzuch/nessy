# ADR 0003: Release automation via a CI-gated `release` branch

## Status
Accepted — 2026-07-14

## Context
The plugin was distributed straight from `main` (marketplace `source: "./"`), so every push to `main` was immediately released. That made `main` production: a stale `dist/` or an unbumped `plugin.json` version silently shipped broken or no-op updates, and there was no CI to catch either. Committing `dist/` on `main` also doubled every source diff with generated output.

## Decision
- Users install the plugin pinned to a `release` branch via the marketplace `source` (`{ source: github, repo: noahzuch/nessy, ref: release }`). Pushing to `main` publishes nothing.
- `dist/` is no longer tracked on `main`; it is built by CI and committed only onto the `release` branch.
- `plugin.json` `version` is the single source of truth (it gates plugin updates); `scripts/bump-version.mjs` keeps `package.json` in sync.
- Two GitHub Actions workflows:
  - `ci.yml` — lint + build + test on every push to `main` and every PR. A signal only; `main` is unpublished.
  - `release.yml` — manual `workflow_dispatch` with a `patch|minor|major` input. Gates on lint + build + test, bumps the version, builds `dist/`, and advances `release`, tagging each release `nessy--v<version>`.

## Invariants
- The `release` branch is never force-pushed, so Claude Code's plugin cache never sees rewritten history.
- Tests run before the release commit is pushed, so a failing gate leaves `release` untouched — no unverified code can reach users.
- `hooks/hooks.json` remains tracked on `main`; only `dist/` moved to release-only.

## Consequences
- Releasing is a single manual action; developers never build, bump, or commit `dist/` by hand.
- `main` can be red transiently without affecting users.
- Adopting a PR workflow later is additive: add branch protection and required checks on `main`.
