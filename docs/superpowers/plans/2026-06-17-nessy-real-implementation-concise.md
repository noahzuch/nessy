# Nessy Real Implementation (Plan 2 of 2, concise) — Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. This is the concise variant of `2026-06-17-nessy-real-implementation.md` — same 21 tasks, same outcomes, shorter content. First instances of each pattern are written in full; subsequent instances reference back. The fully-verbose version is the cross-reference for anything ambiguous.

**Goal:** Replace Plan 1's noop CLI with real init/remove, implement all five hooks and the supporting `src/lib/` modules. After Plan 2, Nessy enforces read-before-write standards-drift end-to-end per the design spec.

**Architecture:** Pure functions in `src/lib/` (no I/O at module load); thin hook scripts in `src/hooks/` wire stdin/stdout/exit-code to the lib; CLI subcommands in `src/cli/` consume `templates/default-config.yml` and are exposed via [Citty](https://github.com/unjs/citty). Config validation and hook payload validation both use [Zod](https://github.com/colinhacks/zod) — the schema is the single source of truth for runtime checks and the inferred TypeScript types. All TDD per module/hook.

**Tech Stack:** TypeScript strict, Node 22 via mise, vitest, NodeNext ESM, npm.

**Reference:** Spec at `docs/superpowers/specs/2026-06-17-nessy-read-before-write-design.md`. Read §3–§7 before starting.

## Toolchain note

`npm` and `node` invocations below assume mise activation (Plan 1's note still applies). The `bin/nessy` shim invokes `node` bare — that's end-user runtime, not dev.

## Working directory

`/Users/noah.zuch/nessy/`. Start state: clean tree at the latest commit on `main`. Plan 1 has been validated end-to-end via the marketplace install path.

---

## Phase 1 — Verification (resolve assumptions before code)

### Task 1: Verify `PreCompact` carries `agent_id` in subagents

Confirm spec §3's assumption that `PreCompact` inside a subagent includes `agent_id`. If false, fall back to wiping on `SessionStart`.

**Files (temporary):** `dist/hooks/_probe-precompact.js`, modified `hooks/hooks.json`. **Final artifact:** `docs/superpowers/verifications/2026-06-17-precompact-agent-id.md` capturing findings.

Steps:
1. Write a stdin-logging probe to `dist/hooks/_probe-precompact.js`:
   ```js
   #!/usr/bin/env node
   import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
   import { dirname } from "node:path";
   const raw = readFileSync(0, "utf8");
   const logPath = "/tmp/nessy-probe-precompact.log";
   mkdirSync(dirname(logPath), { recursive: true });
   appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), payload: JSON.parse(raw) }) + "\n");
   process.exit(0);
   ```
2. Register it in `hooks/hooks.json` under `PreCompact` (single command entry, `node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/_probe-precompact.js`).
3. `/plugin marketplace update` in Claude Code, then trigger compaction inside a `Task`-spawned subagent.
4. `cat /tmp/nessy-probe-precompact.log` — record whether `agent_id` / `agent_type` appear on subagent firings.
5. Document findings (Claude Code version, sample payloads, verdict) in the verification file. If verdict ❌, document the SessionStart fallback approach for Phase 3.
6. Remove probe (`rm dist/hooks/_probe-precompact.js`), restore `hooks/hooks.json` to `{"hooks": {}}`, commit: `verify: confirm PreCompact agent_id behavior (Plan 2 Phase 1)`.

### Task 2: Verify `PostToolUse` non-blocking hint mechanism

Confirm spec §3's assumption about `hookSpecificOutput.additionalContext`. If false, document the working alternative or accept stderr-only fallback.

Same shape as Task 1 — probe script writes a known-marker hint via the assumed mechanism, you ask Claude on the next turn whether it saw it. Record findings in `docs/superpowers/verifications/2026-06-17-posttool-hint.md`. Probe snippet:

```js
#!/usr/bin/env node
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(0, "utf8"));
if (p.tool_name === "Read") {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { additionalContext: "[nessy probe] PostToolUse hint via additionalContext WORKS." }
  }));
}
process.exit(0);
```

If the assumed field doesn't surface, try plausible alternatives (top-level `additionalContext`, `decision: "approve"` + `reason`) until one works or all fail. Commit verification: `verify: confirm PostToolUse hint mechanism (Plan 2 Phase 1)`.

---

## Phase 2 — `src/lib/` modules

Built in dependency order. First module (`log`) shows the full TDD shape; later modules abbreviate.

### Task 3: Logger (`src/lib/log.ts`)

Implements spec §5's minimal logger: `configure({ level, hookName, sessionId, agentId })` once per process; `log(level, message)` writes one JSON line per call to stderr. Filtering by level.

**Files:** create `src/lib/log.ts` and `tests/lib/log.test.ts`. Steps:

1. Write `tests/lib/log.test.ts`. Six tests — capture stderr via monkey-patching `process.stderr.write`, then assert on emitted JSON shape:

   ```ts
   import { describe, it, expect, beforeEach } from "vitest";
   import { configure, log, type Level } from "../../src/lib/log.js";

   function capture() {
     const orig = process.stderr.write.bind(process.stderr);
     const lines: string[] = [];
     // @ts-expect-error narrowing process.stderr.write for the test
     process.stderr.write = (chunk: string) => { lines.push(String(chunk)); return true; };
     return { lines, restore: () => (process.stderr.write = orig) };
   }

   describe("logger", () => {
     beforeEach(() => configure({ level: "info", hookName: "h", sessionId: "s", agentId: null }));

     it("emits one JSON line per call with required fields", () => {
       const c = capture(); try { log("info", "hello"); } finally { c.restore(); }
       const o = JSON.parse(c.lines[0]);
       expect(o).toMatchObject({ message: "hello", hook: "h", session_id: "s", agent_id: null, level: "info" });
       expect(typeof o.ts).toBe("string");
       expect(c.lines[0].endsWith("\n")).toBe(true);
     });

     it("filters messages below configured level", () => {
       const c = capture(); try { log("debug", "x"); log("info", "y"); } finally { c.restore(); }
       expect(c.lines).toHaveLength(1);
       expect(JSON.parse(c.lines[0]).message).toBe("y");
     });

     it("emits error regardless of configured level", () => {
       configure({ level: "error", hookName: "h", sessionId: "s", agentId: null });
       const c = capture(); try { log("info", "filtered"); log("error", "kept"); } finally { c.restore(); }
       expect(JSON.parse(c.lines[0]).message).toBe("kept");
     });

     it("renders agent_id as null (not omitted)", () => {
       const c = capture(); try { log("info", "x"); } finally { c.restore(); }
       const o = JSON.parse(c.lines[0]);
       expect("agent_id" in o).toBe(true);
       expect(o.agent_id).toBe(null);
     });

     it("renders agent_id as string when set", () => {
       configure({ level: "info", hookName: "h", sessionId: "s", agentId: "a1" });
       const c = capture(); try { log("info", "x"); } finally { c.restore(); }
       expect(JSON.parse(c.lines[0]).agent_id).toBe("a1");
     });

     it("configure is idempotent — last call wins", () => {
       configure({ level: "info", hookName: "h1", sessionId: "s1", agentId: null });
       configure({ level: "info", hookName: "h2", sessionId: "s2", agentId: "a" });
       const c = capture(); try { log("info", "x"); } finally { c.restore(); }
       expect(JSON.parse(c.lines[0])).toMatchObject({ hook: "h2", session_id: "s2", agent_id: "a" });
     });
   });
   ```

2. Implement `src/lib/log.ts`:

   ```ts
   export type Level = "debug" | "info" | "warn" | "error";
   const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
   let state = { level: "info" as Level, hookName: "uninitialized", sessionId: "", agentId: null as string | null };

   export function configure(opts: { level: Level; hookName: string; sessionId: string; agentId: string | null }): void {
     state = { ...opts };
   }
   export function log(level: Level, message: string): void {
     if (RANK[level] < RANK[state.level]) return;
     process.stderr.write(JSON.stringify({
       ts: new Date().toISOString(), level,
       hook: state.hookName, session_id: state.sessionId, agent_id: state.agentId, message,
     }) + "\n");
   }
   ```

3. `mise exec -- npm test -- tests/lib/log.test.ts` → 6 pass. Commit: `feat: add structured logger (src/lib/log.ts)`.

### Task 4: Project root discovery (`src/lib/paths.ts`)

Walks up from a starting directory looking for `.nessy/config.yml`. Returns project root or `null`.

**TDD shape as Task 3.** Four tests:
- returns dir containing `.nessy/config.yml`
- walks up to find it in a parent
- returns `null` at filesystem root if not found
- does NOT match `.nessy/` without `config.yml`

Use `mkdtempSync` + cleanup pattern from `node:os.tmpdir()`. Impl:

```ts
import { existsSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";

export function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);
  const { root } = parse(current);
  while (true) {
    if (existsSync(join(current, ".nessy", "config.yml"))) return current;
    if (current === root) return null;
    current = dirname(current);
  }
}
```

Commit: `feat: add project root discovery (src/lib/paths.ts)`.

### Task 5: Config loader (`src/lib/config.ts`)

Loads and validates `.nessy/config.yml` via Zod. Implements every rule in spec §3.

Add deps: `mise exec -- npm install yaml@^2.4.0 zod@^3.23.0`.

**TDD shape as Task 3.** 13 tests covering: minimal valid (empty rules), defaults applied (hints=true, log_level=info), scalar match → array transform, array match accepted, malformed YAML rejected, missing/unknown version rejected, non-boolean hints rejected, invalid log_level rejected, missing/duplicate rule name rejected, empty require rejected, file path included in error.

Impl — Zod schema is the source of truth, types inferred via `z.infer`:

```ts
import { z } from "zod";
import { parse } from "yaml";

const LevelSchema = z.enum(["debug", "info", "warn", "error"]);
const RuleSchema = z.object({
  name: z.string().min(1),
  match: z.union([z.string(), z.array(z.string())]).transform(v => typeof v === "string" ? [v] : v),
  require: z.array(z.string()).min(1),
});
const ConfigSchema = z.object({
  version: z.literal(1),
  hints: z.boolean().default(true),
  log_level: LevelSchema.default("info"),
  rules: z.array(RuleSchema).superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < rules.length; i++) {
      if (seen.has(rules[i].name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "name"], message: `duplicate rule name: ${JSON.stringify(rules[i].name)}` });
      }
      seen.add(rules[i].name);
    }
  }),
});
export type Level = z.infer<typeof LevelSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string, public filePath?: string) {
    super(filePath ? `${message} (in ${filePath})` : message);
    this.name = "ConfigError";
  }
}

export function parseConfig(yaml: string, filePath?: string): Config {
  let raw: unknown;
  try { raw = parse(yaml); } catch (e) {
    throw new ConfigError(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`, filePath);
  }
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map(i => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "), filePath);
  }
  return r.data;
}
```

Tests' regex matchers (`/version/`, `/hints/`, `/log_level/`, `/name/`, `/require/`, `/duplicate.*r1/i`) all hit field names that Zod preserves via the issue `path`. If wording diverges, loosen the regex rather than tighten the schema. Commit: `feat: add YAML config loader + Zod schema validation`.

### Task 6: Pattern matching (`src/lib/matching.ts`)

Wraps `ignore` for gitignore-syntax matching. Add dep: `mise exec -- npm install ignore@^5.3.0`.

**TDD shape as Task 3.** Seven tests: single glob hits, no-match misses, negation honored, scalar-as-1-array, multi-rule union, `*.md` matches root files, backslash-to-slash normalization on Windows-style input. Impl:

```ts
import ignore from "ignore";
import type { Rule } from "./config.js";

function normalize(path: string): string { return path.split("\\").join("/"); }

export function matchRules(targetPath: string, rules: Rule[]): Rule[] {
  const norm = normalize(targetPath);
  return rules.filter(r => ignore().add(r.match).ignores(norm));
}
export function unionRequires(matched: Rule[]): string[] {
  const set = new Set<string>();
  for (const r of matched) for (const req of r.require) set.add(req);
  return [...set];
}
```

Commit: `feat: add gitignore-syntax pattern matching (src/lib/matching.ts)`.

### Task 7: Cache I/O (`src/lib/cache.ts`)

Per-agent cache file (nested layout from spec §4): `cachePathFor`, `loadCache`, `upsertRead`, `saveCache`.

**TDD shape as Task 3.** Eight tests: path computation for root vs subagent, load missing returns empty cache, load corrupted returns empty, save-then-load round-trips, upsert adds new, upsert replaces by path, upsert preserves siblings, save creates parent dirs, save leaves no `.tmp.*` orphans. Use `mkdtempSync` per test.

Impl outline (~50 lines):

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ReadEntry = { path: string; mtime_ms: number; size: number };
export type CacheFile = { version: 1; session_id: string; agent_id: string | null; agent_type?: string | null; reads: ReadEntry[] };

export function cachePathFor(root: string, sid: string, aid: string | null): string {
  return join(root, ".nessy", "cache", sid, aid === null ? "__root__.json" : `${aid}.json`);
}
export function loadCache(p: string): CacheFile {
  if (!existsSync(p)) return emptyFor(p);
  try { const o = JSON.parse(readFileSync(p, "utf8")); return Array.isArray(o?.reads) ? o : emptyFor(p); } catch { return emptyFor(p); }
}
function emptyFor(p: string): CacheFile {
  const parts = p.split("/"); const fn = parts.at(-1) ?? ""; const sid = parts.at(-2) ?? "";
  return { version: 1, session_id: sid, agent_id: fn === "__root__.json" ? null : fn.replace(/\.json$/, ""), reads: [] };
}
export function upsertRead(reads: ReadEntry[], next: ReadEntry): ReadEntry[] {
  return [...reads.filter(r => r.path !== next.path), next];
}
export function saveCache(p: string, c: CacheFile): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  renameSync(tmp, p);
}
```

Commit: `feat: add per-agent cache file I/O (src/lib/cache.ts)`.

### Task 8: Self-mod guard (`src/lib/guards.ts`)

Detects targets under `.nessy/`.

**TDD shape as Task 3.** Seven tests: direct child, deep descendant, `.nessy` itself, sibling `.nessy-old` not flagged, normal src/foo.ts not flagged, target outside project root not flagged, relative-with-`.` inputs normalized. Impl is one function:

```ts
import { relative, resolve } from "node:path";
export function isUnderNessyDir(target: string, root: string): boolean {
  const nessy = resolve(root, ".nessy");
  const t = resolve(target);
  if (t === nessy) return true;
  const rel = relative(nessy, t);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}
```

Commit: `feat: add .nessy/ self-mod guard (src/lib/guards.ts)`.

### Task 9: Staleness check (`src/lib/staleness.ts`)

Compares cached `(mtime, size)` to current disk; returns `"fresh" | "stale" | "missing"`.

**TDD shape as Task 3.** Four tests: missing file → "missing"; matching mtime+size → "fresh"; size differs → "stale"; mtime differs → "stale". Impl:

```ts
import { statSync } from "node:fs";
export type StalenessResult = "fresh" | "stale" | "missing";
export function checkStaleness(p: string, cachedMtime: number, cachedSize: number): StalenessResult {
  try {
    const s = statSync(p);
    return s.mtimeMs === cachedMtime && s.size === cachedSize ? "fresh" : "stale";
  } catch { return "missing"; }
}
```

`mise exec -- npm test` for full-suite sanity check after this task. Commit: `feat: add staleness check (src/lib/staleness.ts)`.

### Task 10: Hook payload schemas (`src/lib/payload.ts`)

Zod schemas every Phase 3 hook uses to parse stdin. Lenient: schema failure → `null` → hook no-ops.

**TDD shape as Task 3.** 14 tests covering each schema's positive case + the 1–2 fields that distinguish it from siblings, plus `tryParsePayload` with success/failure/non-object inputs. Impl:

```ts
import { z } from "zod";
import { readFileSync } from "node:fs";

export const BasePayloadSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  cwd: z.string().min(1),
  hook_event_name: z.string().optional(),
});

export const ReadHookPayloadSchema = BasePayloadSchema.extend({
  tool_name: z.literal("Read"),
  tool_input: z.object({ file_path: z.string().min(1) }),
});
export const WriteEditHookPayloadSchema = BasePayloadSchema.extend({
  tool_name: z.union([z.literal("Write"), z.literal("Edit")]),
  tool_input: z.object({ file_path: z.string().min(1) }),
});
export const BashHookPayloadSchema = BasePayloadSchema.extend({
  tool_name: z.literal("Bash"),
  tool_input: z.object({ command: z.string() }),
});

export type BasePayload = z.infer<typeof BasePayloadSchema>;
export type ReadHookPayload = z.infer<typeof ReadHookPayloadSchema>;
export type WriteEditHookPayload = z.infer<typeof WriteEditHookPayloadSchema>;
export type BashHookPayload = z.infer<typeof BashHookPayloadSchema>;

export function tryParsePayload<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  const r = schema.safeParse(raw); return r.success ? r.data : null;
}
export function readAndParsePayload<T>(schema: z.ZodType<T>): T | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(0, "utf8")); } catch { return null; }
  return tryParsePayload(schema, raw);
}
```

Commit: `feat: add Zod schemas + reader for hook payloads (src/lib/payload.ts)`.

---

## Phase 3 — Hooks

Each hook follows the same shape: read+parse payload via `readAndParsePayload(Schema)` (returns null → exit 0); find project root (null → exit 0); configure logger; do the job. First hook (`record-read`) shows the full impl; subsequent hooks show only the distinctive body.

Phase 3 introduces two test-harness helpers — written once in Task 11 and reused everywhere.

### Task 11: `record-read.ts` — PostToolUse(Read)

Records reads into the cache; emits hint via the §3-verified mechanism when a covered file is read with unsatisfied requires.

**Test harness helpers** (used by every Phase 3 hook):

`tests/_support/buildFakeProject.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export type FakeProject = { projectRoot: string; cleanup: () => void };
export function buildFakeProject(opts: { config?: string; files?: Record<string, string> }): FakeProject {
  const projectRoot = mkdtempSync(join(tmpdir(), "nessy-fake-"));
  if (opts.config !== undefined) {
    mkdirSync(join(projectRoot, ".nessy"), { recursive: true });
    writeFileSync(join(projectRoot, ".nessy/config.yml"), opts.config);
  }
  for (const [rel, c] of Object.entries(opts.files ?? {})) {
    const full = join(projectRoot, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, c);
  }
  return { projectRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}
```

`tests/_support/runHook.ts`:

```ts
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type HookResult = { exitCode: number; stdout: string; stderr: string; stdoutJson: unknown };

export function runHook(scriptName: string, payload: unknown, opts: { cwd?: string } = {}): HookResult {
  const repo = join(__dirname, "..", "..");
  const scriptPath = join(repo, "dist", "hooks", `${scriptName}.js`);
  const res = spawnSync("node", [scriptPath], { input: JSON.stringify(payload), cwd: opts.cwd, encoding: "utf8" });
  let stdoutJson: unknown = null;
  if (res.stdout.trim().length > 0) {
    try { stdoutJson = JSON.parse(res.stdout); } catch {}
  }
  return { exitCode: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, stdoutJson };
}
```

**Hook tests** (`tests/hooks/record-read.test.ts`) — five cases:
- no config → no-op (no cache file created)
- happy path → cache file at `.nessy/cache/{sid}/__root__.json` with `(path, mtime_ms, size)` entry
- `agent_id` present → cache file at `{aid}.json` instead
- target under `.nessy/` → skipped (no cache touch)
- repeated read of same file → deduped (single entry)

**Hook impl** (`src/hooks/record-read.ts`):

```ts
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findProjectRoot } from "../lib/paths.js";
import { cachePathFor, loadCache, upsertRead, saveCache } from "../lib/cache.js";
import { parseConfig } from "../lib/config.js";
import { matchRules } from "../lib/matching.js";
import { configure, log, type Level } from "../lib/log.js";
import { ReadHookPayloadSchema, readAndParsePayload } from "../lib/payload.js";

const normalize = (p: string) => p.split("\\").join("/");

function main(): void {
  const payload = readAndParsePayload(ReadHookPayloadSchema);
  if (payload === null) return;
  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  const sessionId = payload.session_id;
  const agentId = payload.agent_id ?? null;

  // Best-effort log_level peek
  let level: Level = "info";
  try { level = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8")).log_level; } catch {}
  configure({ level, hookName: "record-read", sessionId, agentId });

  const absTarget = resolve(payload.tool_input.file_path);
  const relTarget = normalize(relative(projectRoot, absTarget));
  if (relTarget.startsWith("..") || relTarget.startsWith(".nessy/")) return;

  let st: { mtimeMs: number; size: number };
  try { st = statSync(absTarget); } catch { log("warn", `stat failed for ${relTarget}`); return; }

  const path = cachePathFor(projectRoot, sessionId, agentId);
  const cache = loadCache(path);
  cache.reads = upsertRead(cache.reads, { path: relTarget, mtime_ms: st.mtimeMs, size: st.size });
  cache.session_id = sessionId;
  cache.agent_id = agentId;
  saveCache(path, cache);
  log("debug", `recorded read: ${relTarget}`);

  // Proactive hint (best-effort)
  try {
    const cfg = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8"));
    if (!cfg.hints) return;
    const matched = matchRules(relTarget, cfg.rules);
    if (matched.length === 0) return;
    const known = new Set(cache.reads.map(r => r.path));
    const unread: string[] = [];
    for (const r of matched) for (const req of r.require)
      if (!known.has(req) && !unread.includes(req)) unread.push(req);
    if (unread.length === 0) return;

    const names = matched.map(r => r.name).join(", ");
    const message = [
      `Nessy: You just read \`${relTarget}\`, which is covered by rule(s): ${names}.`,
      `Before you Write or Edit this file (or any other file matching the same rule), read the following:`,
      ...unread.map(p => `  - ${p}`),
      ``,
      `Reading them now means no interrupted writes later.`,
    ].join("\n");
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: message } }));
    log("info", `hint: ${matched.map(r => r.name).join(",")}`);
  } catch (e) {
    log("warn", `hint emission skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main();
```

Build (`mise exec -- npm run build`) before running tests since `runHook` spawns the compiled JS. Commit: `feat: add record-read hook (PostToolUse Read)`.

### Task 12: `check-reads.ts` — PreToolUse(Write|Edit)

Enforcement hook. Order: self-mod guard → config load → rule match → cache check → block or allow.

**Hook tests** (`tests/hooks/check-reads.test.ts`) — eight cases:
- no config → allow
- target under `.nessy/` → block with self-mod message (before config load)
- malformed YAML → block with parse-error
- no rule matches → allow
- missing required read → block (`reason` contains required path + "not yet read")
- all requires satisfied + fresh → allow
- stale (mtime/size diff) → block (reason contains "changed on disk")
- required file deleted from disk → block (config-error)

Use a `seedCacheFile(projectRoot, sid, aid, reads)` helper inline in the test file to pre-populate the cache.

**Hook impl** (`src/hooks/check-reads.ts`):

```ts
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findProjectRoot } from "../lib/paths.js";
import { parseConfig, ConfigError } from "../lib/config.js";
import { matchRules, unionRequires } from "../lib/matching.js";
import { isUnderNessyDir } from "../lib/guards.js";
import { cachePathFor, loadCache } from "../lib/cache.js";
import { checkStaleness } from "../lib/staleness.js";
import { configure, log, type Level } from "../lib/log.js";
import { WriteEditHookPayloadSchema, readAndParsePayload } from "../lib/payload.js";

const block = (reason: string) => process.stdout.write(JSON.stringify({ decision: "block", reason }));
const normalize = (p: string) => p.split("\\").join("/");

const SELF_MOD_MSG = "Nessy: `.nessy/` is plugin-managed state and should not be edited by Claude. "
  + "Read-only access is fine. To change rules, ask the user to edit `.nessy/config.yml` directly. "
  + "To clear cache, run the matching plugin command (or delete the file yourself if you're the user).";

function main(): void {
  const payload = readAndParsePayload(WriteEditHookPayloadSchema);
  if (payload === null) return;
  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  const absTarget = resolve(payload.tool_input.file_path);
  configure({ level: "info", hookName: "check-reads", sessionId: payload.session_id, agentId: payload.agent_id ?? null });

  if (isUnderNessyDir(absTarget, projectRoot)) { log("info", `block: self-mod ${absTarget}`); return block(SELF_MOD_MSG); }

  let cfg;
  try {
    cfg = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8"), `${projectRoot}/.nessy/config.yml`);
  } catch (e) {
    const detail = e instanceof ConfigError ? e.message : (e as Error)?.message ?? String(e);
    log("error", `block: config-error ${detail}`);
    return block(`Nessy: configuration error in .nessy/config.yml\n\n${detail}\n\nAsk the user to fix the config before continuing. Do not retry the write.`);
  }
  configure({ level: cfg.log_level as Level, hookName: "check-reads", sessionId: payload.session_id, agentId: payload.agent_id ?? null });

  const relTarget = normalize(relative(projectRoot, absTarget));
  if (relTarget.startsWith("..")) return;

  const matched = matchRules(relTarget, cfg.rules);
  if (matched.length === 0) return;
  const required = unionRequires(matched);

  const cache = loadCache(cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null));
  const byPath = new Map(cache.reads.map(r => [r.path, r]));

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

  const configErrs = issues.filter(i => i.status === "config-error");
  if (configErrs.length > 0) {
    const lines = configErrs.map(c => `  - rule '${matched.find(r => r.require.includes(c.path))?.name}' requires \`${c.path}\`, which does not exist on disk`).join("\n");
    log("error", `block: config-error (missing files)`);
    return block(`Nessy: configuration error in .nessy/config.yml\n\n${lines}\n\nAsk the user to either create those files or remove them from .nessy/config.yml. Do not retry the write.`);
  }

  const names = matched.map(r => r.name).join(", ");
  const lines = issues.map(i => {
    const tag = i.status === "missing" ? "[not yet read this session]" : "[changed on disk since you last read it]";
    return `  - ${i.path}      ${tag}`;
  });
  log("info", `block: missing-reads ${issues.map(i => i.path).join(",")}`);
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
}

main();
```

Build before running tests. Commit: `feat: add check-reads hook (PreToolUse Write|Edit)`.

### Task 13: `wipe-agent.ts` — PreCompact + SubagentStop

Same hook script for both events. Deletes the current agent's cache file.

**Hook tests** — four cases: root file deleted on `PreCompact` (no `agent_id`); subagent file deleted on `SubagentStop` (with `agent_id`), root untouched; ENOENT-tolerant on missing file; no-op when no `.nessy/config.yml`.

**Hook impl** distinctive body — single `rmSync` of `cachePathFor(...)`:

```ts
import { readFileSync, rmSync } from "node:fs";
import { findProjectRoot } from "../lib/paths.js";
import { cachePathFor } from "../lib/cache.js";
import { parseConfig } from "../lib/config.js";
import { configure, log, type Level } from "../lib/log.js";
import { BasePayloadSchema, readAndParsePayload } from "../lib/payload.js";

function main(): void {
  const payload = readAndParsePayload(BasePayloadSchema);
  if (payload === null) return;
  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  let level: Level = "info";
  try { level = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8")).log_level; } catch {}
  configure({ level, hookName: "wipe-agent", sessionId: payload.session_id, agentId: payload.agent_id ?? null });

  const file = cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null);
  try { rmSync(file, { force: true }); log("info", `wipe: ${file}`); }
  catch (e) { log("warn", `wipe failed: ${e instanceof Error ? e.message : String(e)}`); }
}
main();
```

Commit: `feat: add wipe-agent hook (PreCompact + SubagentStop)`.

### Task 14: `wipe-session.ts` — Stop

Removes the entire `{session_id}/` cache directory.

**Hook tests** — three cases: removes session dir + all files inside; leaves other session dirs untouched; tolerates missing dir.

**Hook impl** — `rmSync` with `recursive: true, force: true` on `{root}/.nessy/cache/{session_id}`. Same logger-setup boilerplate as Task 13. Commit: `feat: add wipe-session hook (Stop)`.

### Task 15: `block-nessy-cli.ts` — PreToolUse(Bash)

Blocks Claude from invoking `nessy init` / `nessy remove` via Bash. The only Bash interception in the plugin.

**Hook tests** — seven cases: blocks `nessy init`, `nessy remove`, `./bin/nessy init`, `node dist/cli/main.js init`, `bin/nessy remove --yes`; allows ordinary commands (`ls`, `git status`, `npm test`); allows `nessy --help` / `nessy --version`.

**Hook impl**:

```ts
import { configure, log } from "../lib/log.js";
import { BashHookPayloadSchema, readAndParsePayload } from "../lib/payload.js";

const PATTERNS: RegExp[] = [
  /\bnessy\s+(init|remove)\b/,
  /\b(?:\.\/)?(?:bin\/)?nessy\s+(init|remove)\b/,
  /\bnode\s+\S*cli(?:\.js)?\s+(init|remove)\b/,
];
const BLOCK_MSG = "Nessy: `nessy init` and `nessy remove` are user-only commands; Claude cannot run them. "
  + "If the user wants this, they should invoke `/nessy:init` or `/nessy:remove` themselves.";

function main(): void {
  const payload = readAndParsePayload(BashHookPayloadSchema);
  if (payload === null) return;
  configure({ level: "info", hookName: "block-nessy-cli", sessionId: payload.session_id, agentId: payload.agent_id ?? null });
  const cmd = payload.tool_input.command;
  let matched = false;
  try { matched = PATTERNS.some(re => re.test(cmd)); }
  catch (e) { log("error", `regex failure: ${e instanceof Error ? e.message : String(e)}`); return; }
  if (!matched) return;
  log("info", `block: ${cmd}`);
  process.stdout.write(JSON.stringify({ decision: "block", reason: BLOCK_MSG }));
}
main();
```

Commit: `feat: add block-nessy-cli hook (PreToolUse Bash)`.

---

## Phase 4 — Real CLI

### Task 16: Default config template

Create `templates/default-config.yml`:

```yaml
version: 1
hints: true
log_level: info
rules: []

# Example rules — uncomment and adapt to your project:
#
# - name: source
#   match: ["src/**", "!src/generated/**"]
#   require:
#     - docs/standards/coding.md
#
# - name: tests
#   match: "tests/**"
#   require:
#     - docs/standards/testing.md
#     - docs/standards/coding.md
```

Commit: `feat: add default .nessy/config.yml template`.

### Task 17: Citty integration + real `nessy init`

Install Citty: `mise exec -- npm install citty@^0.1.6`. Three things happen together:
1. `nessy init` becomes real (creates `.nessy/config.yml` from template).
2. The hand-rolled `dispatch` from Plan 1 gets replaced by Citty's `mainCommand`.
3. Plan 1's `tests/cli/index.test.ts` (5 dispatch tests) is deleted — Citty owns routing.

**Tests** (`tests/cli/init.test.ts`, rewritten) — two cases:
- creates `.nessy/config.yml` with template content (asserts presence + `version: 1`/`hints: true`/`rules: []` substrings)
- refuses non-zero when `.nessy/` exists

**Impl** — `src/cli/init.ts`:

```ts
import { defineCommand } from "citty";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadTemplate = () => readFileSync(join(__dirname, "..", "..", "templates", "default-config.yml"), "utf8");

export function nessyInit(print: (m: string) => void, cwd: string): number {
  const nessy = join(cwd, ".nessy");
  if (existsSync(nessy)) {
    print(`.nessy/ already exists at ${cwd}; remove it first or edit the existing config.`);
    return 1;
  }
  mkdirSync(nessy);
  writeFileSync(join(nessy, "config.yml"), loadTemplate());
  print(`Initialized .nessy/ at ${cwd}. Edit .nessy/config.yml to define rules.`);
  return 0;
}

export const initCommand = defineCommand({
  meta: { name: "init", description: "Initialize .nessy/ in the current working directory" },
  run() {
    const code = nessyInit(m => process.stderr.write(m + "\n"), process.cwd());
    process.exit(code);
  },
});
```

Replace `src/cli/index.ts` with the Citty root:

```ts
import { defineCommand } from "citty";
import { initCommand } from "./init.js";
// removeCommand added in Task 18.

export const mainCommand = defineCommand({
  meta: { name: "nessy", description: "Read-before-write enforcement for Claude Code" },
  subCommands: { init: initCommand },
});
```

Replace `src/cli/main.ts`:

```ts
import { runMain } from "citty";
import { mainCommand } from "./index.js";
runMain(mainCommand);
```

Delete obsolete dispatch tests: `git rm tests/cli/index.test.ts`.

Build, run tests, smoke-test compiled CLI (`mise exec -- node dist/cli/main.js --help` and via `mktemp -d` + `node dist/cli/main.js init`). Commit: `feat: integrate Citty and add real nessy init`.

### Task 18: Real `nessy remove`

Pure function takes `opts: { yes?: boolean }` (not `flags: string[]`) so Citty's typed `args.yes` flows through cleanly.

**Tests** (`tests/cli/remove.test.ts`, rewritten) — three cases:
- no-op + exit 0 + "Nothing to remove" message when `.nessy/` doesn't exist
- removes `.nessy/` recursively when called with `{ yes: true }`
- refuses (non-zero) without `--yes` in non-TTY (vitest is non-TTY by default), `.nessy/` preserved, error mentions `--yes`

**Impl** — `src/cli/remove.ts`:

```ts
import { defineCommand } from "citty";
import { existsSync, rmSync, readSync } from "node:fs";
import { join } from "node:path";

export function nessyRemove(print: (m: string) => void, cwd: string, opts: { yes?: boolean }): number {
  const nessy = join(cwd, ".nessy");
  if (!existsSync(nessy)) { print(`Nothing to remove. (.nessy/ does not exist at ${cwd}.)`); return 0; }
  const isTTY = Boolean(process.stdin.isTTY);
  if (!opts.yes && !isTTY) {
    print(`Refusing to remove .nessy/ non-interactively. Pass --yes to confirm, or run in an interactive shell.`);
    return 1;
  }
  if (!opts.yes && isTTY) {
    process.stderr.write(`Remove .nessy/ and all its contents? [y/N] `);
    const buf = Buffer.alloc(64);
    let n = 0;
    try { n = readSync(0, buf, 0, buf.length, null); }
    catch { print("Failed to read confirmation; aborting."); return 1; }
    const ans = buf.subarray(0, n).toString("utf8").trim().toLowerCase();
    if (ans !== "y" && ans !== "yes") { print("Aborted."); return 1; }
  }
  rmSync(nessy, { recursive: true, force: true });
  print(`Removed .nessy/ at ${cwd}.`);
  return 0;
}

export const removeCommand = defineCommand({
  meta: { name: "remove", description: "Remove the .nessy/ directory from the current working directory" },
  args: { yes: { type: "boolean", description: "Skip the interactive confirmation prompt" } },
  run({ args }) {
    const code = nessyRemove(m => process.stderr.write(m + "\n"), process.cwd(), { yes: args.yes });
    process.exit(code);
  },
});
```

Register in `src/cli/index.ts`:

```ts
import { removeCommand } from "./remove.js";
// ...
subCommands: { init: initCommand, remove: removeCommand },
```

Build, smoke-test init+remove round-trip in a `mktemp -d`. Commit: `feat: real nessy remove with --yes flag and TTY confirmation`.

---

## Phase 5 — Wiring + finalization

### Task 19: Populate `hooks/hooks.json`

Replace empty `{"hooks": {}}` with the full registry — five events, all referencing `${CLAUDE_PLUGIN_ROOT}/dist/hooks/<name>.js` via `type: "command"`:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Read", "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/record-read.js" }] }
    ],
    "PreToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/check-reads.js" }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/block-nessy-cli.js" }] }
    ],
    "PreCompact": [
      { "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/wipe-agent.js" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/wipe-agent.js" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/wipe-session.js" }] }
    ]
  }
}
```

Commit: `feat: register all five hook events in hooks/hooks.json`.

### Task 20: README + CLAUDE.md cleanup

In `README.md`, add a prerequisites line above the `npm install` block:

> **Prerequisites:** Node 22 via [mise](https://mise.jdx.dev/). Once mise is installed, run `mise install` from the repo root. If your shell has mise activation hooks loaded, `npm`/`node` work directly; otherwise prefix with `mise exec --`.

Delete stale `CLAUDE.md` if present (`git rm CLAUDE.md` — it describes a discarded Python design). Commit: `docs: mention mise prerequisite in README; remove stale CLAUDE.md`.

### Task 21: Final rebuild, full test run, manual verification handoff

Final automated state:
1. `rm -rf dist && mise exec -- npm run build`.
2. `mise exec -- npm test` — expect ~95 tests pass.
3. If `dist/` changed, commit: `build: refresh dist/ for Plan 2 final`.
4. `git push`.

**User-driven verification** (surface back, not subagent):
- `/plugin marketplace update`
- In a project with `.nessy/config.yml` and rules: have Claude read a covered file → confirm hint fires; have Claude attempt to Write/Edit a covered file without prior reads → expect block; Claude reads the requires and retries → expect success.
- Have Claude attempt `Write` into `.nessy/` → expect self-mod block.
- Have Claude attempt `Bash("nessy init")` or `Bash("nessy remove")` → expect block-nessy-cli block.
- In a project without `.nessy/config.yml` → confirm no hooks fire.
- `/nessy:init` in a fresh dir → confirm `.nessy/config.yml` appears.
- `/nessy:remove` → confirm `.nessy/` disappears.

Any unexpected behavior: iterate inside this plan or open a follow-up; resolve before declaring Plan 2 done.

---

## Plan 2 acceptance criteria

1. Phase 1 verification items have documented findings.
2. All Phase 2–4 tasks committed; `mise exec -- npm test` green.
3. `hooks/hooks.json` registers all five events.
4. README mentions the mise prerequisite.
5. User-driven verification in Task 21 confirms standards-drift enforcement works in a real Claude Code session.

## What's deferred to v3

Per spec §9 Open Questions: per-rule `hint: false` override; globs in `require:`; `allow_self_edits` to relax self-mod; Bash file-write interception. All non-breaking to add later.

## Out-of-scope reminders

No new lib modules beyond the eight listed in Phase 2. No plugin restructure into `./plugins/nessy/` (current `"./"` source works). No additional hooks beyond the five in Phase 3.
