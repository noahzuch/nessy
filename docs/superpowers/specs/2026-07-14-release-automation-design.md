# Release Automation Design

**Date:** 2026-07-14
**Status:** Approved, pending implementation plan

## Problem

Deploying Nessy today is manual and error-prone:

1. **Forgetting to build.** `dist/` is committed to `main` and must be rebuilt (`npm run build`) before every push, or stale compiled output ships.
2. **Forgetting to bump the version.** The plugin only reaches users when `plugin.json`'s `version` changes; an unbumped version silently ships nothing.
3. **No CI/CD.** Nothing verifies tests/lint before code is published.
4. **`main` is production.** The marketplace serves the plugin from `main` (`source: "./"`), so any push to `main` is *immediately* released. CI that ran after a push would be too late — the broken code would already be live.
5. Version fields have drifted: `plugin.json` is `0.1.3`, `package.json` is `0.1.0`.

## Goal

A release process where the developer pushes to `main` freely and, when ready, triggers a single manual action that verifies, builds, bumps, and publishes — with a **server-side guarantee that nothing unverified can ever reach users.**

## Key mechanics (verified against Claude Code docs)

- A plugin's marketplace `source` can pin the plugin to a specific git `ref` (branch/tag) or `sha`, **independent of the marketplace repo's default branch.** This is the officially documented "release channel" pattern.
- `plugin.json`'s `version` gates updates: users receive an update **only when the string changes**. (Omitting it makes every commit a new version; we keep it explicit.)
- `claude plugin tag --push` cuts a `nessy--v<version>` tag after validating that `plugin.json` and the marketplace entry agree on the version and the tree is clean.

## Chosen approach: CI-gated promote, moving `release` branch, manual button

### 1. Decouple the published ref

- Change the plugin `source` in `.claude-plugin/marketplace.json` from `"./"` to:
  ```json
  "source": { "source": "github", "repo": "noahzuch/nessy", "ref": "release" }
  ```
- The marketplace *metadata* (name, owner, description) continues to be read from `main`; the plugin *content* is fetched from the `release` branch.
- `main` becomes a freely-pushable development/integration branch that **publishes nothing**.
- The `release` branch is the only ref users track. It advances **only** to CI-verified commits.

### 2. Version handling

- `plugin.json`'s `version` is the single source of truth. Tooling keeps `package.json`'s `version` in sync (they are drifted today).
- One-time alignment: set both to `0.1.3` (the last published `plugin.json` value). The next release produces `0.1.4`.
- Bumps are computed by a small, tested script (see §5), driven by a `patch | minor | major` input on the release button (default `patch`).

### 3. `dist/` leaves `main`

- CI builds `dist/` at release time and commits it **only to the `release` branch**.
- `dist/` is therefore removed from `main`: `git rm -r --cached dist/` and add `dist/` to `.gitignore`.
- Developers still run `npm run build` locally to run integration tests (which invoke `dist/` via `node`), but **never build for a commit and never commit `dist/` again.** This eliminates both the "forgot to build" step and the `dist/` diff noise in source commits.

### 4. Two GitHub Actions workflows

**`ci.yml`** — triggers on push to `main` (and `pull_request`, for the future PR workflow).
- Jobs: `install → lint (tsc --noEmit) → test (vitest)`.
- Purely a signal. A red `main` harms no user because `main` is unpublished.

**`release.yml`** — manual `workflow_dispatch` with a `bump` input (`patch` | `minor` | `major`, default `patch`).
- Steps:
  1. `install → lint → test` — **the gate.** Any failure aborts the run; `release` is never touched.
  2. Bump the version in `plugin.json` + `package.json` via the bump script.
  3. `npm run build`.
  4. Publish a release commit — the version bump plus a freshly built `dist/` — onto the `release` branch, on top of the current `main` tree.
  5. Cut and push an immutable `nessy--v<version>` tag at the release commit for provenance (via `claude plugin tag --push` where practical, or an equivalent tag push).
- Permissions: `contents: write` (to push the `release` branch and the tag), using the workflow `GITHUB_TOKEN`.

### 5. Bump-version script

- `scripts/bump-version.mjs` — reads `plugin.json`, applies a `patch|minor|major` bump, and writes the new version to **both** `plugin.json` and `package.json`.
- Node script in the style of `scripts/merge-hooks.mjs`, unit-tested with vitest (patch/minor/major math, both files updated, invalid input rejected).
- Callable by CI and locally.

## Loop and race analysis

- `release.yml` is manual-only; it never triggers on `push`, so it cannot trigger itself.
- The release commit lands on the `release` branch, which `ci.yml` does not watch (it watches `main` / PRs), so releasing does not trigger CI.
- CI never writes to `main`, so it never races with the developer's direct pushes to `main`.

## `release` branch construction

The `release` branch is advanced by CI without rewriting history so that Claude Code's plugin cache never encounters a force-pushed ref:

- CI reconciles `release` with the chosen `main` commit (bringing in all source changes since the last release), applies the version bump, builds `dist/`, and pushes a normal (fast-forwardable) release commit.
- The immutable `nessy--v<version>` tag provides per-release provenance independent of the moving branch.

*(The exact git command sequence — e.g. a `-X theirs` merge from `main` then commit the built artifacts — is an implementation detail to be pinned down in the plan. The invariant is: no force-push to `release`.)*

## One-time migration

1. Create the `release` branch from the current `main`, with `dist/` built and version `0.1.3`.
2. Flip `marketplace.json`'s plugin `source` to `ref: "release"`.
3. Untrack `dist/` on `main` (`git rm -r --cached dist/`), add to `.gitignore`.
4. Align `plugin.json` and `package.json` versions (`0.1.3`).
5. Add `ci.yml`, `release.yml`, and `scripts/bump-version.mjs`.
6. Update `CLAUDE.md` (its deployment/`dist/`-committed guidance is now wrong) and add an ADR under `docs/adr/` recording the release process.
7. Existing installs (likely just the author) refresh the marketplace once to pick up the new source.

## Resulting developer workflow

Push to `main` as often as desired → when ready to ship, click **Run workflow** on the Release action and pick the bump level → CI verifies, builds, bumps the version, and advances `release`. The developer never builds, never bumps, never touches `dist/`, and no unverified code can reach users.

## Out of scope (future, when PRs are adopted)

- Branch protection and required status checks on `main`.
- `semantic-release` / conventional commits for automatic semver.
- Separate `latest` (dogfood) and `stable` (users) release channels.
- `CHANGELOG.md` generation and GitHub Releases.
- Node-version test matrix.
