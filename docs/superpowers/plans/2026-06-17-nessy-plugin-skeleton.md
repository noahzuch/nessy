# Nessy Plugin Skeleton (Plan 1 of 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the minimum viable Nessy plugin structure with **noop** `nessy init` and `nessy remove` commands, sufficient to validate end-to-end that the plugin installs via Claude Code's marketplace mechanism and dispatches slash commands to the CLI.

**Architecture:** A Claude Code plugin laid out per the official convention (see spec §2). TypeScript source compiled to JS, both committed to the repo. The CLI separates its entry point (`main.ts`) from dispatch logic (`index.ts`) so dispatch is unit-testable. The noop behavior in Plan 1 is replaced with real init/remove behavior in Plan 2.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext ESM), Node 20+, vitest for tests, npm for package management.

**Reference:** Design spec at `docs/superpowers/specs/2026-06-17-nessy-read-before-write-design.md`. Read §1 (Goals/Non-goals), §2 (Architecture), §6 (CLI Commands), §7 (Slash Commands) before starting this plan.

**Out of scope for Plan 1** (deferred to Plan 2): real `nessy init` behavior, real `nessy remove` behavior, all hook scripts (`record-read`, `check-reads`, `wipe-agent`, `wipe-session`, `block-nessy-cli`), all `src/lib/` modules, integration tests for hooks, resolution of §9 Open Questions in the spec.

---

## Working directory

All work happens at `/Users/noah.zuch/nessy/` (the repo root).

The repo's git index has pre-existing staged deletions of `cli/*.py` files (a discarded Python prototype) and untracked `CLAUDE.md` / `.claude/`. This plan does not touch them. Cleanup of those is the user's call between Plan 1 and Plan 2.

---

### Task 1: Initialize npm + TypeScript + vitest scaffolding

**Files:**
- Create: `/Users/noah.zuch/nessy/package.json`
- Create: `/Users/noah.zuch/nessy/tsconfig.json`
- Create: `/Users/noah.zuch/nessy/.gitignore` (or modify if it already exists)

- [ ] **Step 1: Create `package.json`**

Write `/Users/noah.zuch/nessy/package.json`:

```json
{
  "name": "nessy",
  "version": "0.1.0",
  "description": "Claude Code plugin: read-before-write enforcement (Plan 1 skeleton)",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "engines": {
    "node": ">=20"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Write `/Users/noah.zuch/nessy/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "sourceMap": true,
    "declaration": false,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Update `.gitignore`**

Check whether `/Users/noah.zuch/nessy/.gitignore` exists. If yes, ensure it contains the lines below (append any missing). If no, create with:

```
node_modules/
*.log
.DS_Store
.idea/
.vscode/
.claude/settings.local.json

# dist/ is committed (see spec §2 Installation and Updates)
```

Do **not** add `dist/` to `.gitignore` — per the spec, the compiled output is committed. Do **not** gitignore all of `.claude/` (only the per-user `settings.local.json`) since the plugin may want to ship a shared `settings.json` later.

- [ ] **Step 4: Install dependencies**

From `/Users/noah.zuch/nessy/`, run:

```bash
npm install
```

Expected: `node_modules/` populated, `package-lock.json` created, no errors.

- [ ] **Step 5: Smoke-test the build pipeline**

Create `/Users/noah.zuch/nessy/src/_smoke.ts`:

```ts
export const NESSY_SKELETON_OK = true;
```

Run:

```bash
npm run build
```

Expected: `dist/_smoke.js` exists. Inspect it:

```bash
cat dist/_smoke.js
```

Expected output includes `export const NESSY_SKELETON_OK = true;`.

- [ ] **Step 6: Remove the smoke artifact**

```bash
rm src/_smoke.ts
rm -rf dist
```

- [ ] **Step 7: Smoke-test vitest**

Create `/Users/noah.zuch/nessy/tests/_smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("vitest smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run:

```bash
npm test
```

Expected: 1 test passes.

- [ ] **Step 8: Remove the vitest smoke test**

```bash
rm tests/_smoke.test.ts
rmdir tests
```

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore
git commit -m "build: initialize npm + typescript + vitest scaffolding"
```

---

### Task 2: Plugin metadata (`.claude-plugin/plugin.json`)

**Files:**
- Create: `/Users/noah.zuch/nessy/.claude-plugin/plugin.json`

- [ ] **Step 1: Create the directory and write the manifest**

Create the directory:

```bash
mkdir -p /Users/noah.zuch/nessy/.claude-plugin
```

Write `/Users/noah.zuch/nessy/.claude-plugin/plugin.json`:

```json
{
  "name": "nessy",
  "version": "0.1.0",
  "description": "Read-before-write enforcement for Claude Code (skeleton)"
}
```

(Per spec §2 and the docs lookup result: `plugin.json` holds metadata only. Hooks register in `hooks/hooks.json`. Slash commands register implicitly via the `commands/` directory.)

- [ ] **Step 2: Sanity-check the file**

```bash
cat .claude-plugin/plugin.json
```

Expected: the JSON object exactly as written above.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "feat: add .claude-plugin/plugin.json metadata"
```

---

### Task 3: Empty hook registry (`hooks/hooks.json`)

The Plan 1 skeleton registers no hooks. Plan 2 will populate this file. We still create it so the structure exists for inspection.

**Files:**
- Create: `/Users/noah.zuch/nessy/hooks/hooks.json`

- [ ] **Step 1: Create the directory and write the file**

```bash
mkdir -p /Users/noah.zuch/nessy/hooks
```

Write `/Users/noah.zuch/nessy/hooks/hooks.json`:

```json
{
  "hooks": {}
}
```

- [ ] **Step 2: Sanity-check the file**

```bash
cat hooks/hooks.json
```

Expected: `{"hooks": {}}` (or the same content with whitespace).

- [ ] **Step 3: Commit**

```bash
git add hooks/hooks.json
git commit -m "feat: add empty hooks/hooks.json (Plan 2 populates)"
```

---

### Task 4: Marketplace manifest (`marketplace.json`)

The marketplace manifest lists this plugin so users can install it via `/plugin marketplace add` + `/plugin install`. The exact schema is a §9 Open Question; this task uses the most-likely shape based on the Claude Code marketplace docs reference and is intended to be empirically validated in Task 13.

**Files:**
- Create: `/Users/noah.zuch/nessy/marketplace.json`

- [ ] **Step 1: Write the marketplace manifest**

Write `/Users/noah.zuch/nessy/marketplace.json`:

```json
{
  "name": "nessy-marketplace",
  "owner": {
    "name": "Noah Zuch"
  },
  "plugins": [
    {
      "name": "nessy",
      "source": ".",
      "description": "Read-before-write enforcement for Claude Code"
    }
  ]
}
```

(The `source: "."` means "the plugin lives at the root of this same repo." If empirical validation in Task 13 shows the marketplace expects a different field shape, this file gets corrected at that point and the spec's §9 Open Questions item 7 is resolved.)

- [ ] **Step 2: Sanity-check the file**

```bash
cat marketplace.json
```

Expected: the JSON object exactly as written above.

- [ ] **Step 3: Commit**

```bash
git add marketplace.json
git commit -m "feat: add marketplace.json (shape pending empirical validation)"
```

---

### Task 5: Noop `nessy init` — test first, then implement

The `init` subcommand is implemented as a pure function `nessyInit(print, cwd)` that returns an exit code. This shape is unit-testable without spawning subprocesses. The Plan 1 behavior is purely informational: it prints what it would do.

**Files:**
- Create: `/Users/noah.zuch/nessy/tests/cli/init.test.ts`
- Create: `/Users/noah.zuch/nessy/src/cli/init.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/noah.zuch/nessy/tests/cli/init.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nessyInit } from "../../src/cli/init.js";

describe("nessyInit (noop, Plan 1)", () => {
  it("prints a would-create message including cwd and returns exit code 0", () => {
    const output: string[] = [];
    const code = nessyInit((msg) => output.push(msg), "/tmp/example");
    expect(code).toBe(0);
    expect(output).toEqual([
      "[nessy init — noop] would create .nessy/ at /tmp/example",
    ]);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
npm test
```

Expected: vitest reports failure (`Cannot find module '../../src/cli/init.js'` or similar). Exit code non-zero.

- [ ] **Step 3: Implement `nessyInit`**

Create `/Users/noah.zuch/nessy/src/cli/init.ts`:

```ts
export function nessyInit(
  print: (msg: string) => void,
  cwd: string,
): number {
  print(`[nessy init — noop] would create .nessy/ at ${cwd}`);
  return 0;
}
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
npm test
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/cli/init.ts tests/cli/init.test.ts
git commit -m "feat: add noop nessy init (Plan 1 skeleton)"
```

---

### Task 6: Noop `nessy remove` — test first, then implement

Mirrors Task 5. Plan 1 ignores the `--yes` flag (no prompt logic at all in the noop). Plan 2 adds real removal + TTY prompt + `--yes` handling.

**Files:**
- Create: `/Users/noah.zuch/nessy/tests/cli/remove.test.ts`
- Create: `/Users/noah.zuch/nessy/src/cli/remove.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/noah.zuch/nessy/tests/cli/remove.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nessyRemove } from "../../src/cli/remove.js";

describe("nessyRemove (noop, Plan 1)", () => {
  it("prints a would-delete message including cwd and returns exit code 0", () => {
    const output: string[] = [];
    const code = nessyRemove((msg) => output.push(msg), "/tmp/example", []);
    expect(code).toBe(0);
    expect(output).toEqual([
      "[nessy remove — noop] would delete .nessy/ at /tmp/example",
    ]);
  });

  it("ignores any flags passed (e.g. --yes) in Plan 1", () => {
    const output: string[] = [];
    const code = nessyRemove((msg) => output.push(msg), "/tmp/example", [
      "--yes",
    ]);
    expect(code).toBe(0);
    expect(output).toEqual([
      "[nessy remove — noop] would delete .nessy/ at /tmp/example",
    ]);
  });
});
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
npm test
```

Expected: 2 tests fail.

- [ ] **Step 3: Implement `nessyRemove`**

Create `/Users/noah.zuch/nessy/src/cli/remove.ts`:

```ts
export function nessyRemove(
  print: (msg: string) => void,
  cwd: string,
  _flags: string[],
): number {
  print(`[nessy remove — noop] would delete .nessy/ at ${cwd}`);
  return 0;
}
```

(`_flags` is accepted and ignored in Plan 1. Plan 2 will parse `--yes` here.)

- [ ] **Step 4: Run tests, confirm pass**

```bash
npm test
```

Expected: 3 tests pass (init + 2× remove).

- [ ] **Step 5: Commit**

```bash
git add src/cli/remove.ts tests/cli/remove.test.ts
git commit -m "feat: add noop nessy remove (Plan 1 skeleton)"
```

---

### Task 7: CLI dispatch — test first, then implement

The dispatch function takes argv, a print callback, and cwd, and routes to the appropriate subcommand. Pure function, fully testable.

**Files:**
- Create: `/Users/noah.zuch/nessy/tests/cli/index.test.ts`
- Create: `/Users/noah.zuch/nessy/src/cli/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `/Users/noah.zuch/nessy/tests/cli/index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { dispatch } from "../../src/cli/index.js";

describe("dispatch", () => {
  it("routes 'init' to nessyInit", () => {
    const output: string[] = [];
    const code = dispatch(["init"], (m) => output.push(m), "/tmp/p");
    expect(code).toBe(0);
    expect(output).toEqual([
      "[nessy init — noop] would create .nessy/ at /tmp/p",
    ]);
  });

  it("routes 'remove' to nessyRemove and passes remaining args as flags", () => {
    const output: string[] = [];
    const code = dispatch(
      ["remove", "--yes"],
      (m) => output.push(m),
      "/tmp/p",
    );
    expect(code).toBe(0);
    expect(output).toEqual([
      "[nessy remove — noop] would delete .nessy/ at /tmp/p",
    ]);
  });

  it("prints usage and returns 0 for --help", () => {
    const output: string[] = [];
    const code = dispatch(["--help"], (m) => output.push(m), "/tmp/p");
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("Usage: nessy");
    expect(output.join("\n")).toContain("init");
    expect(output.join("\n")).toContain("remove");
  });

  it("prints usage and returns 0 when no args given", () => {
    const output: string[] = [];
    const code = dispatch([], (m) => output.push(m), "/tmp/p");
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("Usage: nessy");
  });

  it("prints an error and returns 1 for an unknown subcommand", () => {
    const output: string[] = [];
    const code = dispatch(["bogus"], (m) => output.push(m), "/tmp/p");
    expect(code).toBe(1);
    expect(output.join("\n")).toContain("Unknown subcommand: bogus");
  });
});
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
npm test
```

Expected: 5 dispatch tests fail.

- [ ] **Step 3: Implement `dispatch`**

Create `/Users/noah.zuch/nessy/src/cli/index.ts`:

```ts
import { nessyInit } from "./init.js";
import { nessyRemove } from "./remove.js";

const USAGE = [
  "Usage: nessy <subcommand>",
  "",
  "Subcommands:",
  "  init      Initialize .nessy/ in the current directory",
  "  remove    Remove .nessy/ from the current directory",
  "",
  "Flags:",
  "  --help, -h    Show this usage and exit",
].join("\n");

export function dispatch(
  args: string[],
  print: (msg: string) => void,
  cwd: string,
): number {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "--help" || sub === "-h") {
    print(USAGE);
    return 0;
  }

  switch (sub) {
    case "init":
      return nessyInit(print, cwd);
    case "remove":
      return nessyRemove(print, cwd, rest);
    default:
      print(`Unknown subcommand: ${sub}`);
      print("");
      print(USAGE);
      return 1;
  }
}
```

- [ ] **Step 4: Run tests, confirm all pass**

```bash
npm test
```

Expected: 8 tests pass (init + 2× remove + 5× dispatch).

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/cli/index.test.ts
git commit -m "feat: add CLI subcommand dispatch"
```

---

### Task 8: CLI entry point (`main.ts`)

The entry point is a tiny script that wires `process.argv`, `process.stdout`/`stderr`, and `process.cwd()` into the testable `dispatch` function, then exits with the returned code. It's intentionally not unit-tested — its job is just to glue Node's process APIs to pure logic.

**Files:**
- Create: `/Users/noah.zuch/nessy/src/cli/main.ts`

- [ ] **Step 1: Write `main.ts`**

Create `/Users/noah.zuch/nessy/src/cli/main.ts`:

```ts
import { dispatch } from "./index.js";

// All human-facing output goes to stderr (spec §6 — stdout is reserved).
const print = (msg: string) => process.stderr.write(msg + "\n");

const code = dispatch(process.argv.slice(2), print, process.cwd());
process.exit(code);
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: `dist/cli/main.js`, `dist/cli/index.js`, `dist/cli/init.js`, `dist/cli/remove.js` all exist.

- [ ] **Step 3: Smoke-test the compiled CLI directly**

Run from `/Users/noah.zuch/nessy/`:

```bash
node dist/cli/main.js init
```

Expected stderr (exit code 0):

```
[nessy init — noop] would create .nessy/ at /Users/noah.zuch/nessy
```

```bash
node dist/cli/main.js remove --yes
```

Expected stderr (exit code 0):

```
[nessy remove — noop] would delete .nessy/ at /Users/noah.zuch/nessy
```

```bash
node dist/cli/main.js
```

Expected: usage printed to stderr (exit code 0).

```bash
node dist/cli/main.js wat; echo "exit=$?"
```

Expected: `Unknown subcommand: wat` on stderr, then usage, then `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/main.ts dist/
git commit -m "feat: add CLI entry point and build dist/"
```

---

### Task 9: `bin/nessy` shim

`bin/nessy` is a small Bash script that locates the plugin root (regardless of how the binary is invoked) and execs Node on `dist/cli/main.js`. Claude Code adds the plugin's `bin/` to `PATH` when the plugin is enabled, so users can type `nessy init`.

**Files:**
- Create: `/Users/noah.zuch/nessy/bin/nessy`

- [ ] **Step 1: Create the directory and write the shim**

```bash
mkdir -p /Users/noah.zuch/nessy/bin
```

Write `/Users/noah.zuch/nessy/bin/nessy`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Find the directory of this script, resolving one level of symlinks.
SOURCE="${BASH_SOURCE[0]}"
if [ -L "$SOURCE" ]; then
  SOURCE="$(readlink "$SOURCE")"
fi
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

exec node "$PLUGIN_ROOT/dist/cli/main.js" "$@"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x /Users/noah.zuch/nessy/bin/nessy
```

- [ ] **Step 3: Verify it runs**

From `/Users/noah.zuch/nessy/`:

```bash
./bin/nessy init
```

Expected stderr:

```
[nessy init — noop] would create .nessy/ at /Users/noah.zuch/nessy
```

```bash
./bin/nessy --help
```

Expected: usage on stderr.

- [ ] **Step 4: Commit**

```bash
git add bin/nessy
git commit -m "feat: add bin/nessy shim for PATH invocation"
```

---

### Task 10: Slash command markdown files

The format of slash command markdown is a §9 Open Question (Plan 2 verification item 8). This task uses the simplest format that is likely to work: a brief frontmatter + a body instructing Claude Code to execute the shell command. Empirical validation in Task 13 confirms or corrects this.

**Files:**
- Create: `/Users/noah.zuch/nessy/commands/init.md`
- Create: `/Users/noah.zuch/nessy/commands/remove.md`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p /Users/noah.zuch/nessy/commands
```

- [ ] **Step 2: Write `commands/init.md`**

Write `/Users/noah.zuch/nessy/commands/init.md`:

```markdown
---
description: Initialize Nessy (.nessy/ directory) in the current working directory
---

Run `nessy init` and show the output to the user.
```

- [ ] **Step 3: Write `commands/remove.md`**

Write `/Users/noah.zuch/nessy/commands/remove.md`:

```markdown
---
description: Remove the .nessy/ directory from the current working directory
---

Confirm with the user, then run `nessy remove --yes` and show the output.
```

- [ ] **Step 4: Commit**

```bash
git add commands/init.md commands/remove.md
git commit -m "feat: add /nessy:init and /nessy:remove slash command markdown"
```

---

### Task 11: README with install + usage

**Files:**
- Create: `/Users/noah.zuch/nessy/README.md`

- [ ] **Step 1: Write the README**

Write `/Users/noah.zuch/nessy/README.md` with the following content. The outer fence here uses `~~~~~` (five tildes) so the inner triple-backtick fences are taken literally — when you write the file, the content between the `~~~~~` markers is the actual README body, with normal triple backticks for code blocks.

~~~~~markdown
# Nessy

Claude Code plugin: read-before-write enforcement.

**Status:** Plan 1 skeleton — CLI is a noop. Hooks not yet implemented.

## Installation

One-time setup on a fresh machine:

```
/plugin marketplace add <git-url-of-this-repo>
/plugin install nessy@nessy-marketplace
```

Updates:

```
/plugin marketplace update
```

## Usage (Plan 1 skeleton)

```
/nessy:init       # noop — prints what it would do
/nessy:remove     # noop — prints what it would do
```

Real behavior arrives in Plan 2.

## Development

```
npm install
npm test
npm run build
```

`dist/` is committed — see the design spec at `docs/superpowers/specs/2026-06-17-nessy-read-before-write-design.md` §2 for rationale.

## Spec and plans

- Spec: `docs/superpowers/specs/2026-06-17-nessy-read-before-write-design.md`
- Plan 1 (this): `docs/superpowers/plans/2026-06-17-nessy-plugin-skeleton.md`
- Plan 2 (forthcoming): real init/remove + hooks
~~~~~

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with install + usage instructions"
```

---

### Task 12: Final rebuild and consolidation commit

Make sure `dist/` reflects the final source state and nothing is missing from git.

- [ ] **Step 1: Clean and rebuild**

From `/Users/noah.zuch/nessy/`:

```bash
rm -rf dist
npm run build
```

Expected: `dist/cli/index.js`, `dist/cli/init.js`, `dist/cli/main.js`, `dist/cli/remove.js` exist.

- [ ] **Step 2: Run tests one more time**

```bash
npm test
```

Expected: 8 tests pass (1 init + 2 remove + 5 dispatch).

- [ ] **Step 3: Check `git status`**

```bash
git status
```

Expected: any updated `dist/*.js` files showing as modified. Stage and commit them:

```bash
git add dist/
git commit -m "build: refresh dist/ for Plan 1 skeleton" || echo "(nothing to commit, dist/ already matches)"
```

---

### Task 13: Manual end-to-end validation

This is the gate between Plan 1 and Plan 2. Plan 1 cannot be marked complete until each item here either succeeds or is documented as a known issue with a corresponding new task in Plan 2.

The agent executing this plan should perform these steps interactively and record outcomes inline (replace each `- [ ]` with `- [x]` when verified, or with `- [BLOCKED — <reason>]` if a step fails).

**Pre-flight:**

- [ ] **Step 1: Push the repo to the remote** (so it has a URL to install from)

```bash
git push
```

Expected: clean push, no errors.

**Install path:**

- [ ] **Step 2: Add the marketplace**

In a Claude Code session, run:

```
/plugin marketplace add <git-url-of-this-repo>
```

Expected: Claude Code reports the marketplace was added. If it errors with a schema complaint, copy the error verbatim into a new "Plan 1 issues" section at the bottom of this plan and proceed to Step 3 to see whether the install path complains too.

- [ ] **Step 3: Install the plugin**

```
/plugin install nessy@nessy-marketplace
```

Expected: the plugin installs without error. If it errors, capture the error and document it.

- [ ] **Step 4: Confirm `bin/nessy` is on PATH**

Open a new terminal or invoke a shell inside Claude Code (Bash tool) and run:

```bash
which nessy
nessy --help
```

Expected: `which nessy` prints a path under the Claude Code plugin install directory; `nessy --help` prints usage. If `which nessy` returns nothing, `bin/` is not being added to PATH — record this and stop.

**Slash command dispatch:**

- [ ] **Step 5: Invoke `/nessy:init`**

In a Claude Code session, type `/nessy:init`.

Expected: the noop init message is shown to you (likely surfaced as Claude calling Bash with `nessy init` and showing the output). The exact UX depends on how slash commands dispatch — see §9 verification item 8 in the spec.

- [ ] **Step 6: Invoke `/nessy:remove`**

In a Claude Code session, type `/nessy:remove`.

Expected: the noop remove message is shown to you.

**If slash commands work as expected:** Plan 1 is validated. Proceed to Plan 2.

**If slash command dispatch doesn't work the way the markdown above assumes:**
- Capture the actual behavior (what Claude Code did when you typed the slash command).
- Add a "Plan 1 issues" section at the bottom of this plan documenting what didn't work.
- Either iterate on `commands/*.md` (different frontmatter, different body shape) or open as a verification item to resolve at the start of Plan 2.

**Update path (for completeness, can be deferred):**

- [ ] **Step 7: Bump version and update**

Make a trivial source change (e.g., add a `.` to a noop message), `npm run build`, commit, push, then in Claude Code:

```
/plugin marketplace update
```

Expected: the updated plugin is picked up. Run `/nessy:init` again to confirm the change is visible.

---

## Plan 1 acceptance criteria (summary)

Plan 1 is **complete** when all of the following are true:

1. Repo contains the directory structure described in spec §2, with `dist/` committed.
2. `npm test` passes (8 tests).
3. `npm run build` produces working JS in `dist/`.
4. The plugin installs cleanly via `/plugin marketplace add` + `/plugin install`.
5. `nessy --help`, `nessy init`, `nessy remove` work from a shell once the plugin is installed.
6. `/nessy:init` and `/nessy:remove` slash commands dispatch and show output to the user.

If any of these fail, the failure mode is documented and either fixed (looping on this plan) or scheduled as an explicit early task in Plan 2 (if the failure points at one of the spec's §9 Open Questions).

## Out-of-scope reminders

Nothing about reading hooks, blocking writes, cache files, config validation, `block-nessy-cli`, real `init`/`remove` logic, or `src/lib/` modules is part of Plan 1. Resist the urge to start any of that here — Plan 2 is for that, and starting it now would block Plan 1's validation step on unrelated changes.
