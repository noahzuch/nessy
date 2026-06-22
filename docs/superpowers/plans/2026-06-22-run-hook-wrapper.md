# `runHook` Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract shared hook setup (payload parsing, project root resolution, config load, logger configure) into a `runHook` helper so each hook contains only its business logic.

**Architecture:** New `src/lib/run-hook.ts` holds the wrapper with three typed overloads driven by a `RunHookOpts` discriminated union. `readAndParsePayload` is updated to throw on failure. `normalize` moves to `src/lib/paths.ts`.

**Tech Stack:** TypeScript, Zod, Vitest, Node.js

## Global Constraints

- All tests pass: `npm test`
- Build succeeds: `npm run build`
- `dist/` must be rebuilt before running integration tests (they invoke compiled output)
- `agent_id` is `string | undefined` in `BasePayloadSchema` — do not coerce to null in `ctx`; `configure()` calls still use `?? null`

---

### Task 1: `readAndParsePayload` throws + `normalize` extracted

**Files:**
- Modify: `src/lib/payload.ts`
- Modify: `src/lib/paths.ts`
- Modify: `tests/lib/payload.test.ts`
- Modify: `tests/lib/paths.test.ts`

**Interfaces:**
- Produces: `readAndParsePayload<T>(schema): T` — throws `Error` on bad stdin or schema mismatch
- Produces: `normalize(p: string): string` exported from `src/lib/paths.ts`

- [ ] **Step 1: Update `readAndParsePayload` tests to expect throws**

In `tests/lib/payload.test.ts`, replace the `tryParsePayload` null tests with throw tests for `readAndParsePayload`. `tryParsePayload` (returns `T | null`) is kept unchanged — only `readAndParsePayload` changes.

```ts
// add after existing describe blocks
import { readAndParsePayload, BasePayloadSchema } from "src/lib/payload.js";
import { Readable } from "node:stream";

describe("readAndParsePayload", () => {
  it("throws on invalid JSON stdin", () => {
    // stub readFileSync(0) — see note below; test via direct unit or integration
    // simplest: verify the function signature change compiles and the old null
    // path no longer type-checks (TypeScript catches callers at build time)
  });
});
```

> **Note:** `readAndParsePayload` reads from fd 0 (stdin), making pure unit testing awkward. The existing integration tests in `tests/hooks/` cover this end-to-end. For this task, update the test file to remove the old null-return assertions and add a comment explaining throw behaviour; the integration suite is the safety net.

- [ ] **Step 2: Update `readAndParsePayload` in `src/lib/payload.ts`**

```ts
export function readAndParsePayload<T>(schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(0, "utf8"));
  } catch (e) {
    throw new Error(`Nessy: failed to read stdin: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error(`Nessy: invalid payload: ${r.error.message}`);
  return r.data;
}
```

- [ ] **Step 3: Add `normalize` to `src/lib/paths.ts`**

```ts
export const normalize = (p: string): string => p.split("\\").join("/");
```

- [ ] **Step 4: Add `normalize` test in `tests/lib/paths.test.ts`**

```ts
import { normalize } from "src/lib/paths.js";

describe("normalize", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalize("src\\lib\\foo.ts")).toBe("src/lib/foo.ts");
  });
  it("leaves forward slashes unchanged", () => {
    expect(normalize("src/lib/foo.ts")).toBe("src/lib/foo.ts");
  });
});
```

- [ ] **Step 5: Run tests**

```
npm test
```

Expected: all tests pass. TypeScript will flag any call site that assigns `readAndParsePayload` result to a nullable type — fix those now (they'll be cleaned up fully in Task 3).

- [ ] **Step 6: Commit**

```bash
git add src/lib/payload.ts src/lib/paths.ts tests/lib/payload.test.ts tests/lib/paths.test.ts
git commit -m "refactor: readAndParsePayload throws, normalize moved to paths"
```

---

### Task 2: Create `src/lib/run-hook.ts`

**Files:**
- Create: `src/lib/run-hook.ts`
- Create: `tests/lib/run-hook.test.ts`

**Interfaces:**
- Consumes: `readAndParsePayload` (throws, returns `T`), `findProjectRoot`, `parseConfig`, `configure`
- Produces: `runHook` — three overloads, exported

- [ ] **Step 1: Write failing tests for `runHook`**

```ts
// tests/lib/run-hook.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// runHook reads stdin — mock readAndParsePayload and the lib dependencies
vi.mock("src/lib/payload.js", () => ({
  readAndParsePayload: vi.fn(),
}));
vi.mock("src/lib/paths.js", () => ({
  findProjectRoot: vi.fn(),
  normalize: (p: string) => p,
}));
vi.mock("src/lib/config.js", () => ({
  parseConfig: vi.fn(),
}));
vi.mock("src/lib/log.js", () => ({
  configure: vi.fn(),
  log: vi.fn(),
}));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import { runHook } from "src/lib/run-hook.js";
import { readAndParsePayload } from "src/lib/payload.js";
import { findProjectRoot } from "src/lib/paths.js";
import { parseConfig } from "src/lib/config.js";

const basePayload = { session_id: "s1", agent_id: "a1", cwd: "/proj", hook_event_name: "PreToolUse" };

beforeEach(() => vi.clearAllMocks());

describe("runHook — requiresProject: false", () => {
  it("calls fn with projectRoot null when root not found", () => {
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue(null);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: false }, fn);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: null, cfg: null }));
  });
});

describe("runHook — requiresProject: true", () => {
  it("does not call fn when root is null", () => {
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue(null);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: true, requiresConfig: false }, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls fn with projectRoot and cfg null when config fails", () => {
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue("/proj");
    vi.mocked(parseConfig).mockImplementation(() => { throw new Error("bad"); });
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: true, requiresConfig: false }, fn);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/proj", cfg: null }));
  });
});

describe("runHook — requiresConfig: true", () => {
  it("emits generic block and does not call fn when config fails", () => {
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue("/proj");
    vi.mocked(parseConfig).mockImplementation(() => { throw new Error("bad"); });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: true, requiresConfig: true }, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("configuration error"));
    writeSpy.mockRestore();
  });

  it("calls fn with cfg when config loads", () => {
    const cfg = { log_level: "debug", hints: true, rules: [] } as any;
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue("/proj");
    vi.mocked(parseConfig).mockReturnValue(cfg);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: true, requiresConfig: true }, fn);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/proj", cfg }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npm test tests/lib/run-hook.test.ts
```

Expected: FAIL — `run-hook` module not found.

- [ ] **Step 3: Implement `src/lib/run-hook.ts`**

```ts
import { readFileSync } from "node:fs";
import { z } from "zod";
import { findProjectRoot } from "src/lib/paths.js";
import { parseConfig, type Config } from "src/lib/config.js";
import { configure } from "src/lib/log.js";
import { readAndParsePayload, type BasePayload } from "src/lib/payload.js";

export type RunHookOpts =
  | { requiresProject: false }
  | { requiresProject: true; requiresConfig: false }
  | { requiresProject: true; requiresConfig: true };

type BaseCtx<T> = { payload: T; sessionId: string; agentId: string | undefined };
type NoProjectCtx<T> = BaseCtx<T> & { projectRoot: string | null; cfg: Config | null };
type ProjectCtx<T>   = BaseCtx<T> & { projectRoot: string;        cfg: Config | null };
type ConfigCtx<T>    = BaseCtx<T> & { projectRoot: string;        cfg: Config        };

export function runHook<T extends BasePayload>(name: string, schema: z.ZodType<T>, opts: { requiresProject: false },                       fn: (ctx: NoProjectCtx<T>) => void): void;
export function runHook<T extends BasePayload>(name: string, schema: z.ZodType<T>, opts: { requiresProject: true; requiresConfig: false }, fn: (ctx: ProjectCtx<T>)   => void): void;
export function runHook<T extends BasePayload>(name: string, schema: z.ZodType<T>, opts: { requiresProject: true; requiresConfig: true  }, fn: (ctx: ConfigCtx<T>)    => void): void;
export function runHook<T extends BasePayload>(name: string, schema: z.ZodType<T>, opts: RunHookOpts, fn: (ctx: any) => void): void {
  const payload = readAndParsePayload(schema);
  const sessionId = payload.session_id;
  const agentId = payload.agent_id;

  let projectRoot: string | null = findProjectRoot(payload.cwd);
  if (opts.requiresProject === true && projectRoot === null) return;

  let cfg: Config | null = null;
  if (projectRoot !== null) {
    try {
      cfg = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8"));
    } catch {}
  }
  configure({ level: cfg?.log_level ?? "info", hookName: name, sessionId, agentId: agentId ?? null });

  if (opts.requiresProject === true && "requiresConfig" in opts && opts.requiresConfig === true && cfg === null) {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: "Nessy: configuration error in .nessy/config.yml — ask the user to fix the config before continuing.",
    }));
    return;
  }

  fn({ payload, sessionId, agentId, projectRoot, cfg });
}
```

- [ ] **Step 4: Run tests**

```
npm test tests/lib/run-hook.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/run-hook.ts tests/lib/run-hook.test.ts
git commit -m "feat: add runHook wrapper"
```

---

### Task 3: Refactor all hooks

**Files:**
- Modify: `src/hooks/block-nessy-cli.ts`
- Modify: `src/hooks/wipe-agent.ts`
- Modify: `src/hooks/wipe-session.ts`
- Modify: `src/hooks/record-read.ts`
- Modify: `src/hooks/record-at-mention.ts`
- Modify: `src/hooks/check-reads.ts`

**Interfaces:**
- Consumes: `runHook` from `src/lib/run-hook.js`, `normalize` from `src/lib/paths.js`

- [ ] **Step 1: Refactor `block-nessy-cli.ts`**

```ts
import { log } from "src/lib/log.js";
import { BashHookPayloadSchema } from "src/lib/payload.js";
import { runHook } from "src/lib/run-hook.js";

const PATTERN = /\bnessy\s+\w/;
const BLOCK_MSG =
  "Nessy: nessy CLI commands are user-only; Claude cannot run them. " +
  "If the user wants this, they should invoke the matching plugin skill themselves.";

runHook("block-nessy-cli", BashHookPayloadSchema, { requiresProject: false }, ({ payload }) => {
  const cmd = payload.tool_input.command;
  if (!PATTERN.test(cmd)) return;
  log("info", `block: ${cmd}`);
  process.stdout.write(JSON.stringify({ decision: "block", reason: BLOCK_MSG }));
});
```

- [ ] **Step 2: Refactor `wipe-agent.ts`**

```ts
import { rmSync } from "node:fs";
import { BasePayloadSchema } from "src/lib/payload.js";
import { cachePathFor } from "src/lib/cache.js";
import { log } from "src/lib/log.js";
import { runHook } from "src/lib/run-hook.js";

runHook("wipe-agent", BasePayloadSchema, { requiresProject: true, requiresConfig: false }, ({ payload, projectRoot }) => {
  const file = cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null);
  try {
    rmSync(file, { force: true });
    log("info", `wiped agent file: ${file}`);
  } catch (e) {
    log("warn", `wipe-agent failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});
```

- [ ] **Step 3: Refactor `wipe-session.ts`**

```ts
import { rmSync } from "node:fs";
import { join } from "node:path";
import { BasePayloadSchema } from "src/lib/payload.js";
import { log } from "src/lib/log.js";
import { runHook } from "src/lib/run-hook.js";

runHook("wipe-session", BasePayloadSchema, { requiresProject: true, requiresConfig: false }, ({ payload, projectRoot }) => {
  const dir = join(projectRoot, ".nessy", "cache", payload.session_id);
  try {
    rmSync(dir, { recursive: true, force: true });
    log("info", `wiped session dir: ${dir}`);
  } catch (e) {
    log("warn", `wipe-session failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});
```

- [ ] **Step 4: Refactor `record-read.ts`**

```ts
import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ReadHookPayloadSchema } from "src/lib/payload.js";
import { cachePathFor, loadCache, upsertRead, saveCache } from "src/lib/cache.js";
import { matchRules } from "src/lib/matching.js";
import { log } from "src/lib/log.js";
import { normalize } from "src/lib/paths.js";
import { runHook } from "src/lib/run-hook.js";

runHook("record-read", ReadHookPayloadSchema, { requiresProject: true, requiresConfig: false }, ({ payload, projectRoot, cfg }) => {
  const absTarget = resolve(payload.tool_input.file_path);
  const relTarget = normalize(relative(projectRoot, absTarget));
  if (relTarget.startsWith("..") || relTarget.startsWith(".nessy/")) return;

  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(absTarget);
  } catch {
    log("warn", `stat failed for ${relTarget}`);
    return;
  }

  const cachePath = cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null);
  const cache = loadCache(cachePath);
  cache.reads = upsertRead(cache.reads, { path: relTarget, mtime_ms: st.mtimeMs, size: st.size });
  cache.session_id = payload.session_id;
  cache.agent_id = payload.agent_id;
  saveCache(cachePath, cache);
  log("debug", `recorded read: ${relTarget}`);

  try {
    if (!cfg?.hints) return;
    const matched = matchRules(relTarget, cfg.rules);
    if (matched.length === 0) return;
    const known = new Set(cache.reads.map((r) => r.path));
    const unread: string[] = [];
    for (const r of matched)
      for (const req of r.require) if (!known.has(req) && !unread.includes(req)) unread.push(req);
    if (unread.length === 0) return;
    const message = [
      `Nessy: You just read \`${relTarget}\`.`,
      `Before you Write or Edit this file (or any other file matching the same rule), read the following:`,
      ...unread.map((p) => `  - ${p}`),
      ``,
      `Reading them now means no interrupted writes later.`,
    ].join("\n");
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: message, hookEventName: "PostToolUse" } }));
    log("info", `hint: ${matched.map((r) => r.name).join(",")}`);
  } catch (e) {
    log("warn", `hint emission skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
});
```

- [ ] **Step 5: Refactor `record-at-mention.ts`**

```ts
import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { UserPromptSubmitPayloadSchema } from "src/lib/payload.js";
import { cachePathFor, loadCache, upsertRead, saveCache } from "src/lib/cache.js";
import { matchRules } from "src/lib/matching.js";
import { log } from "src/lib/log.js";
import { normalize } from "src/lib/paths.js";
import { runHook } from "src/lib/run-hook.js";

function extractMentions(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of prompt.matchAll(/@([\w./\\-]+)/g)) {
    const p = m[1];
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

runHook("record-at-mention", UserPromptSubmitPayloadSchema, { requiresProject: true, requiresConfig: false }, ({ payload, projectRoot, cfg }) => {
  const mentions = extractMentions(payload.prompt);
  if (mentions.length === 0) return;

  const cachePath = cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null);
  const cache = loadCache(cachePath);
  const allUnread: string[] = [];
  let recorded = 0;

  for (const mention of mentions) {
    const absTarget = resolve(payload.cwd, mention);
    const relTarget = normalize(relative(projectRoot, absTarget));
    if (relTarget.startsWith("..") || relTarget.startsWith(".nessy/")) continue;

    let st: { mtimeMs: number; size: number };
    try { st = statSync(absTarget); } catch { continue; }

    cache.reads = upsertRead(cache.reads, { path: relTarget, mtime_ms: st.mtimeMs, size: st.size });
    recorded++;
    log("debug", `recorded @mention read: ${relTarget}`);

    try {
      if (!cfg?.hints) continue;
      const matched = matchRules(relTarget, cfg.rules);
      if (matched.length === 0) continue;
      const known = new Set(cache.reads.map((r) => r.path));
      for (const r of matched)
        for (const req of r.require)
          if (!known.has(req) && !allUnread.includes(req)) allUnread.push(req);
    } catch (e) {
      log("warn", `hint collection skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (recorded === 0) return;
  cache.session_id = payload.session_id;
  cache.agent_id = payload.agent_id;
  saveCache(cachePath, cache);

  if (allUnread.length === 0) return;
  const message = [
    `Nessy: The @-mentioned file(s) above match rules that require additional context.`,
    `Before you Write or Edit any matched file, read the following:`,
    ...allUnread.map((p) => `  - ${p}`),
    ``,
    `Reading them now means no interrupted writes later.`,
  ].join("\n");
  process.stdout.write(JSON.stringify({ additionalContext: message }));
  log("info", `hint: ${allUnread.join(",")}`);
});
```

- [ ] **Step 6: Refactor `check-reads.ts`**

```ts
import { relative, resolve } from "node:path";
import { WriteEditHookPayloadSchema } from "src/lib/payload.js";
import { matchRules, unionRequires } from "src/lib/matching.js";
import { isUnderNessyDir } from "src/lib/guards.js";
import { cachePathFor, loadCache } from "src/lib/cache.js";
import { checkStaleness } from "src/lib/staleness.js";
import { log } from "src/lib/log.js";
import { normalize } from "src/lib/paths.js";
import { runHook } from "src/lib/run-hook.js";

const block = (reason: string): void => {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
};

const SELF_MOD_MSG =
  "Nessy: `.nessy/` is plugin-managed state and should not be edited by Claude. " +
  "Read-only access is fine. To change rules, ask the user to edit `.nessy/config.yml` directly. " +
  "To clear cache, run the matching plugin command (or delete the file yourself if you're the user).";

runHook("check-reads", WriteEditHookPayloadSchema, { requiresProject: true, requiresConfig: true }, ({ payload, projectRoot, cfg }) => {
  const absTarget = resolve(payload.tool_input.file_path);

  if (isUnderNessyDir(absTarget, projectRoot)) {
    log("info", `block: self-mod ${absTarget}`);
    return block(SELF_MOD_MSG);
  }

  const relTarget = normalize(relative(projectRoot, absTarget));
  if (relTarget.startsWith("..")) return;

  const matched = matchRules(relTarget, cfg.rules);
  if (matched.length === 0) return;
  const required = unionRequires(matched);

  const cache = loadCache(cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null));
  const byPath = new Map(cache.reads.map((r) => [r.path, r]));

  type Issue = { path: string; status: "missing" | "stale" | "config-error" };
  const issues: Issue[] = [];
  for (const req of required) {
    const entry = byPath.get(req);
    if (!entry) { issues.push({ path: req, status: "missing" }); continue; }
    const s = checkStaleness(resolve(projectRoot, req), entry.mtime_ms, entry.size);
    if (s === "missing") issues.push({ path: req, status: "config-error" });
    else if (s === "stale") issues.push({ path: req, status: "stale" });
  }
  if (issues.length === 0) return;

  const configErrs = issues.filter((i) => i.status === "config-error");
  if (configErrs.length > 0) {
    const lines = configErrs
      .map((c) => `  - rule '${matched.find((r) => r.require.includes(c.path))?.name}' requires \`${c.path}\`, which does not exist on disk`)
      .join("\n");
    log("error", `block: config-error (missing files)`);
    return block(`Nessy: configuration error in .nessy/config.yml\n\n${lines}\n\nAsk the user to either create those files or remove them from .nessy/config.yml. Do not retry the write.`);
  }

  const names = matched.map((r) => r.name).join(", ");
  const lines = issues.map((i) => {
    const tag = i.status === "missing" ? "[not yet read this session]" : "[changed on disk since you last read it]";
    return `  - ${i.path}      ${tag}`;
  });
  log("info", `block: missing-reads ${issues.map((i) => i.path).join(",")}`);
  return block([
    `Nessy: Cannot Write/Edit \`${relTarget}\` yet — required context is not loaded.`,
    ``,
    `Triggered rule(s): ${names}`,
    `You must have these files in your current context before writing:`,
    ...lines,
    ``,
    `Use the Read tool on each of the files above, then retry the same Write/Edit.`,
    ``,
    `Note: even if a prior summary mentions these files, recent compaction may`,
    `have removed their actual content from your context. Re-read them.`,
  ].join("\n"));
});
```

- [ ] **Step 7: Build and run full test suite**

```
npm run build && npm test
```

Expected: all unit and integration tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/ src/lib/run-hook.ts
git commit -m "refactor: all hooks use runHook wrapper"
```
