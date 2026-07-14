# Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual build-and-bump-and-push deployment with a CI-gated, one-click release that publishes only verified code to a dedicated `release` branch users track.

**Architecture:** Users install the plugin pinned to a `release` git branch (via the marketplace `source.ref`), so pushing to `main` publishes nothing. A manual GitHub Actions "Release" workflow verifies (lint + build + test), bumps the version, builds `dist/`, and advances the `release` branch — the only path by which code reaches users. `dist/` stops being tracked on `main`; it exists only as a CI-produced release artifact.

**Tech Stack:** TypeScript, Node.js ≥20, vitest, GitHub Actions, git.

## Global Constraints

- Node.js `>=20` (from `package.json` `engines`).
- Repo is **public** at `github.com/noahzuch/nessy`; the `github` marketplace source needs no auth.
- `plugin.json` `version` is the single source of truth; `package.json` `version` is kept in sync with it.
- **Never force-push the `release` branch** — advance it only via normal (fast-forwardable) pushes, so Claude Code's plugin cache never sees rewritten history.
- Integration tests spawn `dist/<script>.js` via `node`, so **`npm run build` must run before `npm test`** in any CI job.
- Scripts follow the style of `scripts/merge-hooks.mjs` (plain ESM `.mjs`, `node:` imports).
- `hooks/hooks.json` stays tracked on `main` (status quo); only `dist/` moves to release-only.

---

### Task 1: Version bump script

Create a tested ESM script that computes a semver bump and writes it to both `plugin.json` and `package.json`. The pure `bumpVersion` function is unit-tested; the file-writing `applyBump` is tested against a temp directory; running the file as a CLI prints the new version (for CI to capture).

**Files:**
- Create: `scripts/bump-version.mjs`
- Test: `tests/scripts/bump-version.test.ts`

**Interfaces:**
- Produces:
  - `bumpVersion(version: string, level: "patch" | "minor" | "major"): string` — pure semver bump; throws on malformed version or invalid level.
  - `applyBump(root: string, level: "patch" | "minor" | "major"): string` — reads `<root>/.claude-plugin/plugin.json`, bumps its `version` by `level`, writes the new version to both `<root>/.claude-plugin/plugin.json` and `<root>/package.json` (2-space indent, trailing newline), returns the new version.
  - CLI: `node scripts/bump-version.mjs <level>` prints the new version to stdout.

- [ ] **Step 1: Write the failing test**

Create `tests/scripts/bump-version.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpVersion, applyBump } from "../../scripts/bump-version.mjs";

describe("bumpVersion", () => {
  it("increments patch", () => {
    expect(bumpVersion("0.1.3", "patch")).toBe("0.1.4");
  });

  it("increments minor and resets patch", () => {
    expect(bumpVersion("0.1.3", "minor")).toBe("0.2.0");
  });

  it("increments major and resets minor and patch", () => {
    expect(bumpVersion("0.1.3", "major")).toBe("1.0.0");
  });

  it("throws on a malformed version", () => {
    expect(() => bumpVersion("1.2", "patch")).toThrow();
  });

  it("throws on an invalid level", () => {
    expect(() => bumpVersion("0.1.3", "sideways")).toThrow();
  });
});

describe("applyBump", () => {
  it("writes the bumped version to both plugin.json and package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "nessy-bump-"));
    try {
      mkdirSync(join(root, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "nessy", version: "0.1.3" }, null, 2) + "\n",
      );
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "nessy", version: "0.1.3" }, null, 2) + "\n",
      );

      const next = applyBump(root, "patch");

      expect(next).toBe("0.1.4");
      const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      expect(plugin.version).toBe("0.1.4");
      expect(pkg.version).toBe("0.1.4");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/scripts/bump-version.test.ts`
Expected: FAIL — cannot resolve `../../scripts/bump-version.mjs` (module does not exist).

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/bump-version.mjs`:

```js
// Bumps the plugin version and keeps package.json in sync.
// Usage: node scripts/bump-version.mjs <patch|minor|major>  (prints the new version)
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LEVELS = new Set(["patch", "minor", "major"]);

export function bumpVersion(version, level) {
  if (!LEVELS.has(level)) throw new Error(`Invalid bump level: ${level}`);
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Invalid version: ${version}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function writeVersion(path, version) {
  const obj = JSON.parse(readFileSync(path, "utf8"));
  obj.version = version;
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

export function applyBump(root, level) {
  const pluginPath = join(root, ".claude-plugin", "plugin.json");
  const pkgPath = join(root, "package.json");
  const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
  const next = bumpVersion(plugin.version, level);
  writeVersion(pluginPath, next);
  writeVersion(pkgPath, next);
  return next;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const level = process.argv[2] ?? "patch";
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  process.stdout.write(applyBump(root, level) + "\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/scripts/bump-version.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Verify the CLI entrypoint prints without mutating the repo**

Run: `node -e "import('./scripts/bump-version.mjs').then(m => console.log(m.bumpVersion('0.1.3','minor')))"`
Expected: prints `0.2.0`. (Importing does not trigger the CLI branch, so no files change. Confirm with `git status` — clean apart from the two new files.)

- [ ] **Step 6: Commit**

```bash
git add scripts/bump-version.mjs tests/scripts/bump-version.test.ts
git commit -m "feat: add version bump script syncing plugin.json and package.json"
```

---

### Task 2: Stop tracking `dist/` on `main` and align versions

Remove the compiled output from `main`'s git index (it becomes a release-only artifact), ignore it going forward, and fix the `plugin.json`/`package.json` version drift so both read `0.1.3`.

**Files:**
- Modify: `.gitignore`
- Modify: `package.json:3` (version `0.1.0` → `0.1.3`)
- Untrack: `dist/` (remove from index, keep on disk)

- [ ] **Step 1: Align `package.json` version with `plugin.json`**

Edit `package.json` line 3, changing `"version": "0.1.0"` to `"version": "0.1.3"`.

- [ ] **Step 2: Verify the two version fields now match**

Run: `node -e "const a=require('./package.json').version,b=require('./.claude-plugin/plugin.json').version;if(a!==b)throw new Error(a+'!='+b);console.log('aligned at '+a)"`
Expected: prints `aligned at 0.1.3`.

- [ ] **Step 3: Ignore `dist/` and drop the stale note**

Edit `.gitignore`, replacing the final line:

```
# dist/ is committed (see spec §2 Installation and Updates)
```

with:

```
# dist/ is a release-only artifact, built by CI onto the `release` branch
dist/
```

- [ ] **Step 4: Remove `dist/` from the git index (keep files on disk)**

Run: `git rm -r --cached dist/`
Expected: lists the `dist/**` files being removed from the index.

- [ ] **Step 5: Verify `dist/` is untracked but still present on disk**

Run: `git status --short dist | head` and `test -d dist && echo "dist present on disk"`
Expected: `git status` shows `dist/` as deleted-from-index (staged) and no longer tracked; `dist present on disk` prints (local build output remains for running integration tests).

- [ ] **Step 6: Commit**

```bash
git add .gitignore package.json
git commit -m "build: untrack dist/ on main and align version fields at 0.1.3"
```

---

### Task 3: Point the marketplace at the `release` branch

Change the plugin `source` so users fetch plugin content from the `release` branch instead of the marketplace repo's checked-out ref.

**Files:**
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Change the plugin source**

Replace the plugin entry's `"source": "./"` in `.claude-plugin/marketplace.json` so the `plugins` array reads:

```json
  "plugins": [
    {
      "name": "nessy",
      "source": {
        "source": "github",
        "repo": "noahzuch/nessy",
        "ref": "release"
      },
      "description": "Nessy, a development workflow harness"
    }
  ]
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8')).plugins[0].source.ref)"`
Expected: prints `release`.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/marketplace.json
git commit -m "build: pin plugin source to the release branch"
```

---

### Task 4: CI workflow (signal on every push)

Add a workflow that lint/build/tests every push to `main` and every PR. It publishes nothing — it is purely a signal, since `main` is unpublished.

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run build # integration tests spawn dist/*.js, so build first
      - run: npm test
```

- [ ] **Step 2: Verify the workflow file parses as YAML**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8');require('yaml').parse(y);console.log('ci.yml parses')"`
Expected: prints `ci.yml parses` (the `yaml` package is already a dependency).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add lint/build/test workflow for main and PRs"
```

---

### Task 5: Release workflow (manual button)

Add the manually-triggered workflow that gates on lint+build+test, bumps the version, builds `dist/`, and advances the `release` branch without a force-push, tagging each release for provenance.

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      bump:
        description: "Version bump level"
        type: choice
        options: [patch, minor, major]
        default: patch

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0 # full history so the release-branch merge has a merge base

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      # --- Gate part 1: lint on main ---
      - run: npm run lint

      # --- Move onto the release branch (source == main; no dist in tree yet) ---
      - name: Prepare release branch
        run: |
          set -euo pipefail
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          MAIN_SHA="$(git rev-parse HEAD)"
          if git ls-remote --exit-code --heads origin release >/dev/null 2>&1; then
            git fetch origin release
            git checkout -B release origin/release
            # main is authoritative for source; 'theirs' resolves any conflict toward main.
            # main no longer tracks dist/, so this drops the previous release's tracked dist/.
            git merge -X theirs --no-edit "$MAIN_SHA"
          else
            git checkout -B release "$MAIN_SHA"
          fi

      # --- Bump version on the release branch ---
      - name: Bump version
        id: bump
        run: |
          set -euo pipefail
          VERSION="$(node scripts/bump-version.mjs '${{ inputs.bump }}')"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"

      # --- Build the release artifact ---
      - run: npm run build

      # --- Gate part 2: tests (now that dist/ exists) ---
      - run: npm test

      # --- Commit artifact + version bump and advance release (no force-push) ---
      - name: Publish release commit
        run: |
          set -euo pipefail
          VERSION="${{ steps.bump.outputs.version }}"
          git add -A
          git add -f dist
          git commit -m "release: v${VERSION}"
          git tag "nessy--v${VERSION}"
          git push origin release
          git push origin "nessy--v${VERSION}"
```

- [ ] **Step 2: Verify the workflow file parses as YAML**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/release.yml','utf8');require('yaml').parse(y);console.log('release.yml parses')"`
Expected: prints `release.yml parses`.

- [ ] **Step 3: Sanity-check the git sequence against the invariant**

Re-read the `Prepare release branch` and `Publish release commit` steps and confirm: (a) there is no `git push --force` / `push -f` / `push +release` anywhere; (b) tests (`npm test`) run *before* the commit/push, so a failing gate aborts the job with `release` untouched. Fix inline if either is violated.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add manual release workflow that gates, bumps, builds, and advances the release branch"
```

---

### Task 6: Documentation — CLAUDE.md and ADR

Update the guide's now-wrong deployment guidance and record the release process as an ADR (following the `docs/adr/` convention; next number is `0003`).

**Files:**
- Modify: `CLAUDE.md:16-18`
- Create: `docs/adr/0003-release-automation.md`

- [ ] **Step 1: Update the CLAUDE.md build/deployment note**

In `CLAUDE.md`, replace this paragraph (lines 16–18):

```
Build = `tsc && tsc-alias && node scripts/merge-hooks.mjs`. `tsc-alias` post-processes the compiled output to rewrite `src/*` path aliases to relative paths; `merge-hooks.mjs` regenerates `hooks/hooks.json` from each feature's `hooks.fragment.json`. **Always rebuild before running hook integration tests** — they invoke `dist/` directly via `node`.

`dist/` is committed. Users install the plugin without a build step; the compiled output must be up-to-date before pushing.
```

with:

```
Build = `tsc && tsc-alias && node scripts/merge-hooks.mjs`. `tsc-alias` post-processes the compiled output to rewrite `src/*` path aliases to relative paths; `merge-hooks.mjs` regenerates `hooks/hooks.json` from each feature's `hooks.fragment.json`. **Always rebuild before running hook integration tests** — they invoke `dist/` directly via `node`.

**Deployment:** `dist/` is a release-only artifact and is **not tracked on `main`** — never commit it. To ship, push source to `main` (freely; `main` publishes nothing), then trigger the **Release** GitHub Actions workflow and pick a `patch`/`minor`/`major` bump. CI gates on lint + build + test, bumps the version in `plugin.json` and `package.json`, builds `dist/`, and advances the `release` branch that users install from. See `docs/adr/0003-release-automation.md`.
```

- [ ] **Step 2: Create the ADR**

Create `docs/adr/0003-release-automation.md`:

```markdown
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
```

- [ ] **Step 3: Verify the ADR renders and links resolve**

Run: `test -f docs/adr/0003-release-automation.md && grep -q "0003-release-automation.md" CLAUDE.md && echo "docs wired up"`
Expected: prints `docs wired up`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/adr/0003-release-automation.md
git commit -m "docs: document release automation in CLAUDE.md and ADR 0003"
```

---

### Task 7: Go live — first release (operational)

This task pushes the accumulated work and performs the first release. Parts run in the GitHub web UI, not the shell.

**Files:** none (operational).

- [ ] **Step 1: Push all committed work to `main`**

Run: `git push origin main`
Expected: push succeeds. The CI workflow starts on GitHub.

- [ ] **Step 2: Confirm CI is green**

Run: `gh run list --workflow=ci.yml --limit 1` (or check the Actions tab).
Expected: the latest `CI` run concludes `success`. If it fails, fix on `main` and re-push before releasing.

> Note: from this push until Step 3 completes, `main`'s `marketplace.json` points at a `release` branch that does not exist yet, so a marketplace refresh would fail to fetch the plugin. This only affects the maintainer's own install and is resolved by the first release below. Do Step 3 promptly.

- [ ] **Step 3: Trigger the first release**

Run: `gh workflow run release.yml -f bump=patch`
(or: Actions tab → **Release** → **Run workflow** → `bump: patch` → **Run workflow**.)
Expected: the run gates, then creates the `release` branch at version `0.1.4` with a built `dist/`, and pushes tag `nessy--v0.1.4`.

- [ ] **Step 4: Verify the release branch and tag exist and carry `dist/`**

Run:
```bash
gh run list --workflow=release.yml --limit 1
git ls-remote --heads origin release
git ls-remote --tags origin 'nessy--v*'
git fetch origin release && git ls-tree -r --name-only origin/release | grep -q '^dist/' && echo "release branch carries dist/"
git fetch origin release && test "$(git show origin/release:.claude-plugin/plugin.json | node -e 'process.stdin.on(\"data\",d=>console.log(JSON.parse(d).version))')" = "0.1.4" && echo "release version is 0.1.4"
```
Expected: the release run is `success`; `origin/release` and `nessy--v0.1.4` exist; `release branch carries dist/` and `release version is 0.1.4` both print.

- [ ] **Step 5: Verify a fresh install resolves the plugin from `release`**

In a Claude Code session: `/plugin marketplace update nessy-marketplace` (or re-add the marketplace), then confirm the `nessy` plugin loads at version `0.1.4`.
Expected: plugin updates to `0.1.4` from the `release` branch with no build step on the user's side.

---

## Self-Review

**Spec coverage:**
- Decouple published ref (spec §1) → Task 3 (marketplace source) + Task 7 (release branch created).
- Version source of truth + drift fix (§2) → Task 1 (script) + Task 2 (align to 0.1.3).
- `dist/` leaves `main` (§3) → Task 2.
- `ci.yml` + `release.yml`, loop/race safety (§4, loop analysis) → Tasks 4 & 5; `release.yml` is `workflow_dispatch`-only and writes only `release`, `ci.yml` watches only `main`/PRs → no loop, no race.
- Bump script + tests (§5) → Task 1.
- `release` branch construction, no force-push (spec "release branch construction") → Task 5 (merge `-X theirs`, tests-before-push, tag for provenance) + Task 5 Step 3 invariant check.
- One-time migration (§migration) → Tasks 2/3/6 (untrack, source flip, docs/ADR) + Task 7 (branch creation, first release, maintainer refresh note).
- Resulting workflow / out-of-scope (§resulting, §out-of-scope) → documented in Task 6 ADR; PR/branch-protection deliberately left out.

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N" — every code and doc step contains full content. The spec's one deferred item (exact git sequence) is now fully specified in Task 5.

**Type consistency:** `bumpVersion(version, level)` and `applyBump(root, level)` signatures match between Task 1's Interfaces block, its implementation, and its tests. The CLI contract (`node scripts/bump-version.mjs <level>` prints the version) matches Task 5's `Bump version` step consuming `$(node scripts/bump-version.mjs '${{ inputs.bump }}')`. The tag name `nessy--v<version>` is consistent across Task 5 and Task 7's verification.
