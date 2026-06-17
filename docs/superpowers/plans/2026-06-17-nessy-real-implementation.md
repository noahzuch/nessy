# Nessy Real Implementation (Plan 2 of 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Plan 1's noop CLI with real `nessy init` / `nessy remove`, implement all five hooks (`record-read`, `check-reads`, `wipe-agent`, `wipe-session`, `block-nessy-cli`), and the supporting `src/lib/` modules they depend on. After Plan 2, Nessy enforces the read-before-write standards-drift rule end-to-end per the design spec.

**Architecture:** Pure functions in `src/lib/` (no I/O at module load, no Claude-Code-specific shapes); hook scripts in `src/hooks/` that wire stdin/stdout/exit-code to the lib; CLI subcommands in `src/cli/` that consume `templates/default-config.yml` for `init` defaults. All TDD per module/hook.

**Tech Stack:** Same as Plan 1 (TypeScript strict, Node 22 via mise, vitest, NodeNext ESM, npm).

**Reference:** Design spec at `/Users/noah.zuch/nessy/docs/superpowers/specs/2026-06-17-nessy-read-before-write-design.md`. Read §3 (Configuration), §4 (Data Flow), §5 (Error Handling), §6 (CLI Commands), §7 (Slash Commands) before starting.

## Toolchain note

All `npm` and `node` invocations below use `mise exec --` prefix unless the shell has mise activation in effect (see Plan 1's toolchain note). The `bin/nessy` shim in production still invokes `node` bare — this is for end-user runtime, not dev-time.

## Working directory

`/Users/noah.zuch/nessy/`. State at start of Plan 2: 15 commits on `main`, last commit `051c3ea` (marketplace.json fix). Plan 1 has been validated end-to-end via the Claude Code marketplace install path — `/nessy:init` and `/nessy:remove` slash commands dispatch correctly to the noop CLI.

## Phase 1 — Verification items (resolve before writing hook code)

These resolve spec §9 Open Questions #1 and #2. They are gating because the hook implementations in Phase 3 depend on the answers.

---

### Task 1: Verify `PreCompact` carries `agent_id` inside a subagent

**Goal:** Confirm the assumption in spec §3 that when `PreCompact` fires inside a subagent, the hook payload includes `agent_id`. If not, the spec's fallback applies (wipe on SessionStart instead of PreCompact).

This task is exploratory — it modifies no production code. It instruments a temporary hook, triggers compaction inside a subagent, captures the payload, then removes the instrumentation.

**Files:**
- Create temporarily: `/Users/noah.zuch/nessy/dist/hooks/_probe-precompact.js`
- Modify temporarily: `/Users/noah.zuch/nessy/hooks/hooks.json`
- Create at end: `/Users/noah.zuch/nessy/docs/superpowers/verifications/2026-06-17-precompact-agent-id.md`

- [ ] **Step 1: Write a temporary probe hook**

Create `/Users/noah.zuch/nessy/dist/hooks/_probe-precompact.js`:

```js
#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const raw = readFileSync(0, "utf8");
const logPath = "/tmp/nessy-probe-precompact.log";
mkdirSync(dirname(logPath), { recursive: true });
appendFileSync(
  logPath,
  JSON.stringify({ ts: new Date().toISOString(), payload: JSON.parse(raw) }) +
    "\n",
);
process.exit(0);
```

- [ ] **Step 2: Register it temporarily in `hooks/hooks.json`**

Edit `/Users/noah.zuch/nessy/hooks/hooks.json` to:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/_probe-precompact.js"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Reload the plugin in Claude Code**

In Claude Code:

```
/plugin marketplace update
```

(Confirms the hook registration is picked up.)

- [ ] **Step 4: Trigger compaction inside a subagent**

In a Claude Code session: use the Task tool to launch a subagent (e.g., the Explore agent) with a prompt that produces a lot of output ("read every file under src/ and summarize each"). Continue working in the parent until the subagent's context approaches its limit, then explicitly ask the subagent to summarize/compact. Alternatively, use `/compact` inside the subagent if Claude Code exposes that.

If you can't reliably trigger subagent compaction interactively, also enable PreCompact for the root session and observe what happens there as a fallback signal.

- [ ] **Step 5: Inspect the log**

```bash
cat /tmp/nessy-probe-precompact.log
```

Look for entries with `agent_id` and `agent_type` fields. Record:
- Does the root session's PreCompact include these fields? Expected: no.
- Does a subagent's PreCompact include them? Expected (per spec): yes.

- [ ] **Step 6: Document findings**

Create `/Users/noah.zuch/nessy/docs/superpowers/verifications/2026-06-17-precompact-agent-id.md` with:

- The Claude Code version used (`claude --version`).
- The captured payloads (paste at least one root and one subagent example).
- The verdict: ✅ assumption holds (spec proceeds as written), or ❌ assumption fails (Phase 3 uses the SessionStart fallback from spec §3).
- If ❌: explicit plan for the fallback — add a `SessionStart` hook that wipes the agent's cache file.

- [ ] **Step 7: Remove the probe**

```bash
rm /Users/noah.zuch/nessy/dist/hooks/_probe-precompact.js
```

Restore `/Users/noah.zuch/nessy/hooks/hooks.json` to its empty state:

```json
{
  "hooks": {}
}
```

- [ ] **Step 8: Commit verification**

```bash
git add docs/superpowers/verifications/2026-06-17-precompact-agent-id.md hooks/hooks.json
git commit -m "verify: confirm PreCompact agent_id behavior (Plan 2 Phase 1)"
```

(Note: `dist/hooks/_probe-precompact.js` was removed and was never committed — the commit only captures the verification doc and the restored empty `hooks.json`.)

---

### Task 2: Verify `PostToolUse` non-blocking hint mechanism

**Goal:** Confirm spec §3's assumption about how a PostToolUse hook surfaces a message to Claude on its next turn (likely `hookSpecificOutput.additionalContext`, but the field name is unverified). The hint emission from `record-read` in Phase 3 depends on this.

**Files:**
- Create temporarily: `/Users/noah.zuch/nessy/dist/hooks/_probe-posttool.js`
- Modify temporarily: `/Users/noah.zuch/nessy/hooks/hooks.json`
- Create at end: `/Users/noah.zuch/nessy/docs/superpowers/verifications/2026-06-17-posttool-hint.md`

- [ ] **Step 1: Write a probe hook that tries the assumed mechanism**

Create `/Users/noah.zuch/nessy/dist/hooks/_probe-posttool.js`:

```js
#!/usr/bin/env node
import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8");
const payload = JSON.parse(raw);

if (payload.tool_name === "Read") {
  // Try the documented (or assumed) hint mechanism. Adjust the JSON shape
  // here if the docs say otherwise. The exact field name is what we are
  // verifying empirically.
  const response = {
    hookSpecificOutput: {
      additionalContext:
        "[nessy probe] If you can see this line in your context, the PostToolUse hint mechanism via hookSpecificOutput.additionalContext WORKS.",
    },
  };
  process.stdout.write(JSON.stringify(response));
}

process.exit(0);
```

- [ ] **Step 2: Register it temporarily in `hooks/hooks.json`**

Edit `/Users/noah.zuch/nessy/hooks/hooks.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/_probe-posttool.js"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Reload the plugin**

```
/plugin marketplace update
```

- [ ] **Step 4: Trigger a Read in a Claude Code session, then ask Claude what it sees**

Have Claude read any file (e.g. `README.md`), then on the next turn ask Claude: "What was the most recent thing you saw in your tool result context — was there a nessy probe message?" If Claude reports the probe message text, the mechanism works. If not, it doesn't.

- [ ] **Step 5: Document findings**

Create `/Users/noah.zuch/nessy/docs/superpowers/verifications/2026-06-17-posttool-hint.md`:

- The field name(s) tried.
- Whether the mechanism worked.
- If `hookSpecificOutput.additionalContext` doesn't work: try other plausible shapes (`additionalContext` at the top level, `decision: "approve"` with `reason`, etc.) until one works or all fail. Record what was tried.
- If nothing surfaces a non-blocking message to Claude: the `record-read` hint in Phase 3 degrades to stderr-only logging (Claude still sees stderr in the tool result, but as standard hook output, not as a separate hint). Document this as the fallback.

- [ ] **Step 6: Remove the probe**

```bash
rm /Users/noah.zuch/nessy/dist/hooks/_probe-posttool.js
```

Restore `/Users/noah.zuch/nessy/hooks/hooks.json` to empty:

```json
{
  "hooks": {}
}
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/verifications/2026-06-17-posttool-hint.md hooks/hooks.json
git commit -m "verify: confirm PostToolUse hint mechanism (Plan 2 Phase 1)"
```

---

## Phase 2 — `src/lib/` modules (TDD per module)

Each module is a small, focused unit with one clear responsibility. Built in dependency order: `log` first (everyone uses it), then `paths`, then the rest.

---

### Task 3: Logger (`src/lib/log.ts`)

Implements the minimal logger from spec §5 — `configure()` + `log()`, four required structured fields (`ts`, `hook`, `session_id`, `agent_id`), free-form message.

**Files:**
- Create: `/Users/noah.zuch/nessy/tests/lib/log.test.ts`
- Create: `/Users/noah.zuch/nessy/src/lib/log.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/lib/log.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { configure, log, type Level } from "../../src/lib/log.js";

function capture(): {
  lines: string[];
  restore: () => void;
} {
  const orig = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  // @ts-expect-error narrowing process.stderr.write for the test
  process.stderr.write = (chunk: string) => {
    lines.push(String(chunk));
    return true;
  };
  return { lines, restore: () => (process.stderr.write = orig) };
}

describe("logger", () => {
  beforeEach(() => {
    configure({
      level: "info",
      hookName: "test-hook",
      sessionId: "s1",
      agentId: null,
    });
  });

  it("emits a single JSON line per call to stderr", () => {
    const cap = capture();
    try {
      log("info", "hello world");
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    const obj = JSON.parse(cap.lines[0]);
    expect(obj.message).toBe("hello world");
    expect(obj.hook).toBe("test-hook");
    expect(obj.session_id).toBe("s1");
    expect(obj.agent_id).toBe(null);
    expect(obj.level).toBe("info");
    expect(typeof obj.ts).toBe("string");
    expect(cap.lines[0].endsWith("\n")).toBe(true);
  });

  it("filters out messages below the configured level", () => {
    const cap = capture();
    try {
      log("debug", "should be filtered");
      log("info", "should appear");
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    expect(JSON.parse(cap.lines[0]).message).toBe("should appear");
  });

  it("always emits error regardless of configured level", () => {
    configure({
      level: "error",
      hookName: "h",
      sessionId: "s",
      agentId: null,
    });
    const cap = capture();
    try {
      log("info", "filtered");
      log("error", "kept");
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(1);
    expect(JSON.parse(cap.lines[0]).message).toBe("kept");
  });

  it("renders agent_id as null (not omitted) when null", () => {
    const cap = capture();
    try {
      log("info", "x");
    } finally {
      cap.restore();
    }
    const obj = JSON.parse(cap.lines[0]);
    expect("agent_id" in obj).toBe(true);
    expect(obj.agent_id).toBe(null);
  });

  it("renders agent_id as the string when present", () => {
    configure({
      level: "info",
      hookName: "h",
      sessionId: "s",
      agentId: "a1",
    });
    const cap = capture();
    try {
      log("info", "x");
    } finally {
      cap.restore();
    }
    expect(JSON.parse(cap.lines[0]).agent_id).toBe("a1");
  });

  it("configure is idempotent — last call wins", () => {
    configure({ level: "info", hookName: "h1", sessionId: "s1", agentId: null });
    configure({ level: "info", hookName: "h2", sessionId: "s2", agentId: "a" });
    const cap = capture();
    try {
      log("info", "x");
    } finally {
      cap.restore();
    }
    const obj = JSON.parse(cap.lines[0]);
    expect(obj.hook).toBe("h2");
    expect(obj.session_id).toBe("s2");
    expect(obj.agent_id).toBe("a");
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm test -- tests/lib/log.test.ts
```

Expected: tests fail because `src/lib/log.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `/Users/noah.zuch/nessy/src/lib/log.ts`:

```ts
export type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

type LoggerState = {
  level: Level;
  hookName: string;
  sessionId: string;
  agentId: string | null;
};

let state: LoggerState = {
  level: "info",
  hookName: "uninitialized",
  sessionId: "",
  agentId: null,
};

export function configure(opts: {
  level: Level;
  hookName: string;
  sessionId: string;
  agentId: string | null;
}): void {
  state = { ...opts };
}

export function log(level: Level, message: string): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[state.level]) {
    return;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    hook: state.hookName,
    session_id: state.sessionId,
    agent_id: state.agentId,
    message,
  });
  process.stderr.write(line + "\n");
}
```

- [ ] **Step 4: Run, confirm pass**

```bash
mise exec -- npm test -- tests/lib/log.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Run the full test suite**

```bash
mise exec -- npm test
```

Expected: 14 tests pass (8 from Plan 1 + 6 new log tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/log.ts tests/lib/log.test.ts
git commit -m "feat: add structured logger (src/lib/log.ts)"
```

---

### Task 4: Project root discovery (`src/lib/paths.ts`)

Walks up from a starting directory looking for `.nessy/config.yml`. Returns the project root or `null`.

**Files:**
- Create: `/Users/noah.zuch/nessy/tests/lib/paths.test.ts`
- Create: `/Users/noah.zuch/nessy/src/lib/paths.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/lib/paths.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findProjectRoot } from "../../src/lib/paths.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "nessy-paths-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("findProjectRoot", () => {
  it("returns the directory containing .nessy/config.yml", () => {
    mkdirSync(join(tmpRoot, ".nessy"));
    writeFileSync(join(tmpRoot, ".nessy/config.yml"), "");
    expect(findProjectRoot(tmpRoot)).toBe(tmpRoot);
  });

  it("walks up to find .nessy/config.yml in a parent", () => {
    mkdirSync(join(tmpRoot, ".nessy"));
    writeFileSync(join(tmpRoot, ".nessy/config.yml"), "");
    mkdirSync(join(tmpRoot, "src", "lib"), { recursive: true });
    expect(findProjectRoot(join(tmpRoot, "src", "lib"))).toBe(tmpRoot);
  });

  it("returns null when no .nessy/config.yml is found anywhere up to fs root", () => {
    expect(findProjectRoot(tmpRoot)).toBe(null);
  });

  it("does not match .nessy/ without config.yml", () => {
    mkdirSync(join(tmpRoot, ".nessy"));
    // intentionally no config.yml
    expect(findProjectRoot(tmpRoot)).toBe(null);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm test -- tests/lib/paths.test.ts
```

- [ ] **Step 3: Implement**

Create `/Users/noah.zuch/nessy/src/lib/paths.ts`:

```ts
import { existsSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";

export function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);
  const { root } = parse(current);
  while (true) {
    if (existsSync(join(current, ".nessy", "config.yml"))) {
      return current;
    }
    if (current === root) {
      return null;
    }
    current = dirname(current);
  }
}
```

- [ ] **Step 4: Run, confirm pass**

```bash
mise exec -- npm test -- tests/lib/paths.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/paths.ts tests/lib/paths.test.ts
git commit -m "feat: add project root discovery (src/lib/paths.ts)"
```

---

### Task 5: Config loader + validation (`src/lib/config.ts`)

Loads `.nessy/config.yml`, validates the schema, returns a typed `Config` object or throws a typed error. Implements every rule in spec §3 (Configuration).

**Files:**
- Create: `/Users/noah.zuch/nessy/tests/lib/config.test.ts`
- Create: `/Users/noah.zuch/nessy/src/lib/config.ts`

- [ ] **Step 1: Add the `yaml` package**

```bash
mise exec -- npm install yaml@^2.4.0
```

- [ ] **Step 2: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/lib/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/lib/config.js";

describe("parseConfig", () => {
  it("parses a minimal valid config with empty rules", () => {
    const cfg = parseConfig(`
version: 1
rules: []
`);
    expect(cfg.version).toBe(1);
    expect(cfg.hints).toBe(true);
    expect(cfg.log_level).toBe("info");
    expect(cfg.rules).toEqual([]);
  });

  it("applies defaults for hints and log_level when omitted", () => {
    const cfg = parseConfig(`
version: 1
rules:
  - name: r1
    match: ["src/**"]
    require: ["docs/x.md"]
`);
    expect(cfg.hints).toBe(true);
    expect(cfg.log_level).toBe("info");
  });

  it("accepts scalar match converted to array", () => {
    const cfg = parseConfig(`
version: 1
rules:
  - name: r1
    match: "tests/**"
    require: ["docs/x.md"]
`);
    expect(cfg.rules[0].match).toEqual(["tests/**"]);
  });

  it("accepts array match", () => {
    const cfg = parseConfig(`
version: 1
rules:
  - name: r1
    match: ["src/**", "!src/gen/**"]
    require: ["docs/x.md"]
`);
    expect(cfg.rules[0].match).toEqual(["src/**", "!src/gen/**"]);
  });

  it("rejects malformed YAML", () => {
    expect(() => parseConfig("version: 1\nrules: [")).toThrow(ConfigError);
  });

  it("rejects missing version", () => {
    expect(() =>
      parseConfig(`
rules: []
`),
    ).toThrow(/version/);
  });

  it("rejects unknown version", () => {
    expect(() =>
      parseConfig(`
version: 2
rules: []
`),
    ).toThrow(/version/);
  });

  it("rejects non-boolean hints", () => {
    expect(() =>
      parseConfig(`
version: 1
hints: "yes"
rules: []
`),
    ).toThrow(/hints/);
  });

  it("rejects invalid log_level", () => {
    expect(() =>
      parseConfig(`
version: 1
log_level: trace
rules: []
`),
    ).toThrow(/log_level/);
  });

  it("rejects rules without a name", () => {
    expect(() =>
      parseConfig(`
version: 1
rules:
  - match: ["src/**"]
    require: ["docs/x.md"]
`),
    ).toThrow(/name/);
  });

  it("rejects duplicate rule names", () => {
    expect(() =>
      parseConfig(`
version: 1
rules:
  - name: r1
    match: ["src/**"]
    require: ["docs/x.md"]
  - name: r1
    match: ["tests/**"]
    require: ["docs/y.md"]
`),
    ).toThrow(/duplicate.*r1/i);
  });

  it("rejects empty require", () => {
    expect(() =>
      parseConfig(`
version: 1
rules:
  - name: r1
    match: ["src/**"]
    require: []
`),
    ).toThrow(/require/);
  });

  it("includes file path in error when provided", () => {
    try {
      parseConfig("not yaml at all: : :", "/proj/.nessy/config.yml");
      throw new Error("should have thrown");
    } catch (e) {
      if (e instanceof ConfigError) {
        expect(e.message).toMatch(/\/proj\/\.nessy\/config\.yml/);
      } else {
        throw e;
      }
    }
  });
});
```

- [ ] **Step 3: Run, confirm fail**

```bash
mise exec -- npm test -- tests/lib/config.test.ts
```

- [ ] **Step 4: Implement**

Create `/Users/noah.zuch/nessy/src/lib/config.ts`:

```ts
import { parse } from "yaml";

export type Level = "debug" | "info" | "warn" | "error";

export type Rule = {
  name: string;
  match: string[];
  require: string[];
};

export type Config = {
  version: 1;
  hints: boolean;
  log_level: Level;
  rules: Rule[];
};

export class ConfigError extends Error {
  constructor(message: string, public filePath?: string) {
    super(filePath ? `${message} (in ${filePath})` : message);
    this.name = "ConfigError";
  }
}

const VALID_LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);

function asArray(v: unknown, field: string): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  throw new ConfigError(`${field} must be a string or array of strings`);
}

export function parseConfig(yaml: string, filePath?: string): Config {
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch (e) {
    throw new ConfigError(
      `YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
      filePath,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config must be a YAML mapping", filePath);
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new ConfigError(
      `version must be exactly 1 (got ${JSON.stringify(obj.version)})`,
      filePath,
    );
  }

  const hints = obj.hints === undefined ? true : obj.hints;
  if (typeof hints !== "boolean") {
    throw new ConfigError("hints must be a boolean", filePath);
  }

  const log_level = obj.log_level === undefined ? "info" : obj.log_level;
  if (typeof log_level !== "string" || !VALID_LEVELS.has(log_level)) {
    throw new ConfigError(
      `log_level must be one of debug|info|warn|error (got ${JSON.stringify(log_level)})`,
      filePath,
    );
  }

  if (!Array.isArray(obj.rules)) {
    throw new ConfigError("rules must be an array", filePath);
  }

  const names = new Set<string>();
  const rules: Rule[] = obj.rules.map((entry, idx) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      throw new ConfigError(`rules[${idx}] must be a mapping`, filePath);
    }
    const r = entry as Record<string, unknown>;
    if (typeof r.name !== "string" || r.name.length === 0) {
      throw new ConfigError(
        `rules[${idx}].name must be a non-empty string`,
        filePath,
      );
    }
    if (names.has(r.name)) {
      throw new ConfigError(
        `duplicate rule name: ${JSON.stringify(r.name)}`,
        filePath,
      );
    }
    names.add(r.name);
    const match = asArray(r.match, `rules[${idx}].match`);
    if (!Array.isArray(r.require)) {
      throw new ConfigError(
        `rules[${idx}].require must be an array`,
        filePath,
      );
    }
    if (r.require.length === 0) {
      throw new ConfigError(
        `rules[${idx}].require must be non-empty`,
        filePath,
      );
    }
    if (!r.require.every((x: unknown) => typeof x === "string")) {
      throw new ConfigError(
        `rules[${idx}].require entries must be strings`,
        filePath,
      );
    }
    return { name: r.name, match, require: r.require as string[] };
  });

  return { version: 1, hints, log_level: log_level as Level, rules };
}
```

- [ ] **Step 5: Run, confirm pass**

```bash
mise exec -- npm test -- tests/lib/config.test.ts
```

Expected: 13 tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/config.ts tests/lib/config.test.ts
git commit -m "feat: add YAML config loader + schema validation (src/lib/config.ts)"
```

---

### Task 6: Pattern matching (`src/lib/matching.ts`)

Wraps the `ignore` package for gitignore-syntax matching of target paths against rule patterns.

**Files:**
- Create: `/Users/noah.zuch/nessy/tests/lib/matching.test.ts`
- Create: `/Users/noah.zuch/nessy/src/lib/matching.ts`

- [ ] **Step 1: Add the `ignore` package**

```bash
mise exec -- npm install ignore@^5.3.0
```

- [ ] **Step 2: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/lib/matching.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchRules } from "../../src/lib/matching.js";
import type { Rule } from "../../src/lib/config.js";

const r = (name: string, match: string[], require: string[]): Rule => ({
  name,
  match,
  require,
});

describe("matchRules", () => {
  it("matches a single glob", () => {
    const rules = [r("source", ["src/**"], ["docs/x.md"])];
    expect(matchRules("src/foo.ts", rules).map((m) => m.name)).toEqual(["source"]);
  });

  it("does not match non-matching path", () => {
    const rules = [r("source", ["src/**"], ["docs/x.md"])];
    expect(matchRules("README.md", rules)).toEqual([]);
  });

  it("honors negation patterns", () => {
    const rules = [r("source", ["src/**", "!src/gen/**"], ["docs/x.md"])];
    expect(matchRules("src/foo.ts", rules).map((m) => m.name)).toEqual(["source"]);
    expect(matchRules("src/gen/auto.ts", rules)).toEqual([]);
  });

  it("returns multiple matching rules (union by caller)", () => {
    const rules = [
      r("source", ["src/**"], ["docs/coding.md"]),
      r("tests", ["**/*.test.ts"], ["docs/testing.md"]),
    ];
    const matched = matchRules("src/foo.test.ts", rules).map((m) => m.name).sort();
    expect(matched).toEqual(["source", "tests"]);
  });

  it("matches scalar match expressed as single-element array", () => {
    const rules = [r("md", ["*.md"], ["docs/x.md"])];
    expect(matchRules("README.md", rules).map((m) => m.name)).toEqual(["md"]);
  });

  it("rejects empty-after-negation patterns gracefully", () => {
    const rules = [r("docs", ["docs/**", "!CHANGELOG.md"], ["docs/x.md"])];
    expect(matchRules("docs/coding.md", rules).map((m) => m.name)).toEqual([
      "docs",
    ]);
    expect(matchRules("CHANGELOG.md", rules)).toEqual([]);
  });

  it("treats target paths as POSIX (forward slash) regardless of input style", () => {
    const rules = [r("source", ["src/**"], ["docs/x.md"])];
    expect(matchRules("src\\foo.ts", rules).map((m) => m.name)).toEqual([
      "source",
    ]);
  });
});
```

- [ ] **Step 3: Run, confirm fail**

```bash
mise exec -- npm test -- tests/lib/matching.test.ts
```

- [ ] **Step 4: Implement**

Create `/Users/noah.zuch/nessy/src/lib/matching.ts`:

```ts
import ignore from "ignore";
import type { Rule } from "./config.js";

function normalize(path: string): string {
  return path.split("\\").join("/");
}

export function matchRules(targetPath: string, rules: Rule[]): Rule[] {
  const normalized = normalize(targetPath);
  return rules.filter((rule) => {
    const ig = ignore().add(rule.match);
    return ig.ignores(normalized);
  });
}

export function unionRequires(matchedRules: Rule[]): string[] {
  const set = new Set<string>();
  for (const r of matchedRules) for (const req of r.require) set.add(req);
  return [...set];
}
```

- [ ] **Step 5: Run, confirm pass**

```bash
mise exec -- npm test -- tests/lib/matching.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/matching.ts tests/lib/matching.test.ts
git commit -m "feat: add gitignore-syntax pattern matching (src/lib/matching.ts)"
```

---

### Task 7: Cache I/O (`src/lib/cache.ts`)

Read, dedup-update, and write the per-agent cache file. Implements the nested cache layout from spec §4.

**Files:**
- Create: `/Users/noah.zuch/nessy/tests/lib/cache.test.ts`
- Create: `/Users/noah.zuch/nessy/src/lib/cache.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/lib/cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cachePathFor,
  loadCache,
  upsertRead,
  saveCache,
  type ReadEntry,
} from "../../src/lib/cache.js";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "nessy-cache-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("cachePathFor", () => {
  it("returns __root__.json for the root session (no agent_id)", () => {
    const p = cachePathFor(projectRoot, "sess1", null);
    expect(p).toBe(join(projectRoot, ".nessy", "cache", "sess1", "__root__.json"));
  });

  it("returns {agent_id}.json for subagents", () => {
    const p = cachePathFor(projectRoot, "sess1", "agentA");
    expect(p).toBe(join(projectRoot, ".nessy", "cache", "sess1", "agentA.json"));
  });
});

describe("loadCache", () => {
  it("returns empty cache when file doesn't exist", () => {
    const c = loadCache(cachePathFor(projectRoot, "sess1", null));
    expect(c.reads).toEqual([]);
  });

  it("returns empty cache on corrupted JSON", () => {
    const path = cachePathFor(projectRoot, "sess1", null);
    saveCache(path, { version: 1, session_id: "sess1", agent_id: null, reads: [] });
    // Corrupt the file
    require("node:fs").writeFileSync(path, "{not json");
    const c = loadCache(path);
    expect(c.reads).toEqual([]);
  });

  it("round-trips reads through saveCache + loadCache", () => {
    const path = cachePathFor(projectRoot, "sess1", null);
    const reads: ReadEntry[] = [
      { path: "docs/x.md", mtime_ms: 1000, size: 100 },
      { path: "docs/y.md", mtime_ms: 2000, size: 200 },
    ];
    saveCache(path, {
      version: 1,
      session_id: "sess1",
      agent_id: null,
      reads,
    });
    expect(loadCache(path).reads).toEqual(reads);
  });
});

describe("upsertRead", () => {
  it("adds a new read", () => {
    const next = upsertRead([], { path: "a.md", mtime_ms: 1, size: 1 });
    expect(next).toEqual([{ path: "a.md", mtime_ms: 1, size: 1 }]);
  });

  it("replaces an existing read by path with fresh mtime/size", () => {
    const initial: ReadEntry[] = [{ path: "a.md", mtime_ms: 1, size: 1 }];
    const next = upsertRead(initial, { path: "a.md", mtime_ms: 2, size: 2 });
    expect(next).toEqual([{ path: "a.md", mtime_ms: 2, size: 2 }]);
  });

  it("preserves other entries", () => {
    const initial: ReadEntry[] = [
      { path: "a.md", mtime_ms: 1, size: 1 },
      { path: "b.md", mtime_ms: 1, size: 1 },
    ];
    const next = upsertRead(initial, { path: "a.md", mtime_ms: 99, size: 99 });
    expect(next.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "a.md", mtime_ms: 99, size: 99 },
      { path: "b.md", mtime_ms: 1, size: 1 },
    ]);
  });
});

describe("saveCache", () => {
  it("creates parent directories if missing", () => {
    const path = cachePathFor(projectRoot, "sess1", null);
    saveCache(path, { version: 1, session_id: "sess1", agent_id: null, reads: [] });
    expect(existsSync(path)).toBe(true);
  });

  it("does not leave .tmp orphans on a successful write", () => {
    const path = cachePathFor(projectRoot, "sess1", null);
    saveCache(path, { version: 1, session_id: "sess1", agent_id: null, reads: [] });
    const parent = join(projectRoot, ".nessy", "cache", "sess1");
    const entries = readdirSync(parent);
    expect(entries.filter((e) => e.includes(".tmp."))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm test -- tests/lib/cache.test.ts
```

- [ ] **Step 3: Implement**

Create `/Users/noah.zuch/nessy/src/lib/cache.ts`:

```ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type ReadEntry = {
  path: string;
  mtime_ms: number;
  size: number;
};

export type CacheFile = {
  version: 1;
  session_id: string;
  agent_id: string | null;
  agent_type?: string | null;
  reads: ReadEntry[];
};

export function cachePathFor(
  projectRoot: string,
  sessionId: string,
  agentId: string | null,
): string {
  const filename = agentId === null ? "__root__.json" : `${agentId}.json`;
  return join(projectRoot, ".nessy", "cache", sessionId, filename);
}

export function loadCache(cachePath: string): CacheFile {
  if (!existsSync(cachePath)) {
    return emptyCache(cachePath);
  }
  try {
    const raw = readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.reads)) {
      return emptyCache(cachePath);
    }
    return parsed as CacheFile;
  } catch {
    return emptyCache(cachePath);
  }
}

function emptyCache(cachePath: string): CacheFile {
  const segments = cachePath.split("/");
  const filename = segments[segments.length - 1] ?? "";
  const sessionId = segments[segments.length - 2] ?? "";
  const agentId = filename === "__root__.json" ? null : filename.replace(/\.json$/, "");
  return {
    version: 1,
    session_id: sessionId,
    agent_id: agentId,
    reads: [],
  };
}

export function upsertRead(
  reads: ReadEntry[],
  next: ReadEntry,
): ReadEntry[] {
  const filtered = reads.filter((r) => r.path !== next.path);
  return [...filtered, next];
}

export function saveCache(cachePath: string, cache: CacheFile): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, cachePath);
}
```

- [ ] **Step 4: Run, confirm pass**

```bash
mise exec -- npm test -- tests/lib/cache.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cache.ts tests/lib/cache.test.ts
git commit -m "feat: add per-agent cache file I/O (src/lib/cache.ts)"
```

---

### Task 8: Self-mod guard (`src/lib/guards.ts`)

Tests whether a given target path is inside the project's `.nessy/` directory.

**Files:**
- Create: `/Users/noah.zuch/nessy/tests/lib/guards.test.ts`
- Create: `/Users/noah.zuch/nessy/src/lib/guards.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/lib/guards.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isUnderNessyDir } from "../../src/lib/guards.js";

describe("isUnderNessyDir", () => {
  it("returns true for direct child of .nessy", () => {
    expect(isUnderNessyDir("/proj/.nessy/config.yml", "/proj")).toBe(true);
  });

  it("returns true for deep descendant", () => {
    expect(
      isUnderNessyDir("/proj/.nessy/cache/sess/agent.json", "/proj"),
    ).toBe(true);
  });

  it("returns true for .nessy itself", () => {
    expect(isUnderNessyDir("/proj/.nessy", "/proj")).toBe(true);
  });

  it("returns false for sibling .nessy-old", () => {
    expect(isUnderNessyDir("/proj/.nessy-old/x", "/proj")).toBe(false);
  });

  it("returns false for sibling files", () => {
    expect(isUnderNessyDir("/proj/src/foo.ts", "/proj")).toBe(false);
  });

  it("returns false for paths outside project root", () => {
    expect(isUnderNessyDir("/other/.nessy/config.yml", "/proj")).toBe(false);
  });

  it("normalizes relative and absolute inputs to the same answer", () => {
    expect(isUnderNessyDir("/proj/./.nessy/config.yml", "/proj")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm test -- tests/lib/guards.test.ts
```

- [ ] **Step 3: Implement**

Create `/Users/noah.zuch/nessy/src/lib/guards.ts`:

```ts
import { relative, resolve } from "node:path";

export function isUnderNessyDir(targetPath: string, projectRoot: string): boolean {
  const nessyDir = resolve(projectRoot, ".nessy");
  const target = resolve(targetPath);
  if (target === nessyDir) return true;
  const rel = relative(nessyDir, target);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}
```

- [ ] **Step 4: Run, confirm pass**

```bash
mise exec -- npm test -- tests/lib/guards.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/guards.ts tests/lib/guards.test.ts
git commit -m "feat: add .nessy/ self-mod guard (src/lib/guards.ts)"
```

---

### Task 9: Staleness check (`src/lib/staleness.ts`)

Compares a cached `(mtime, size)` against a freshly-stat'd file, returning `fresh | stale | missing`.

**Files:**
- Create: `/Users/noah.zuch/nessy/tests/lib/staleness.test.ts`
- Create: `/Users/noah.zuch/nessy/src/lib/staleness.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/lib/staleness.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkStaleness } from "../../src/lib/staleness.js";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nessy-staleness-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkStaleness", () => {
  it("returns 'missing' when file does not exist", () => {
    expect(checkStaleness(join(dir, "nope.md"), 0, 0)).toBe("missing");
  });

  it("returns 'fresh' when mtime and size match", () => {
    const file = join(dir, "x.md");
    writeFileSync(file, "hello");
    const st = statSync(file);
    expect(checkStaleness(file, st.mtimeMs, st.size)).toBe("fresh");
  });

  it("returns 'stale' when size differs", () => {
    const file = join(dir, "x.md");
    writeFileSync(file, "hello");
    const st = statSync(file);
    expect(checkStaleness(file, st.mtimeMs, st.size + 1)).toBe("stale");
  });

  it("returns 'stale' when mtime differs", () => {
    const file = join(dir, "x.md");
    writeFileSync(file, "hello");
    const st = statSync(file);
    expect(checkStaleness(file, st.mtimeMs + 1000, st.size)).toBe("stale");
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm test -- tests/lib/staleness.test.ts
```

- [ ] **Step 3: Implement**

Create `/Users/noah.zuch/nessy/src/lib/staleness.ts`:

```ts
import { statSync } from "node:fs";

export type StalenessResult = "fresh" | "stale" | "missing";

export function checkStaleness(
  filePath: string,
  cachedMtimeMs: number,
  cachedSize: number,
): StalenessResult {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(filePath);
  } catch {
    return "missing";
  }
  if (st.mtimeMs === cachedMtimeMs && st.size === cachedSize) return "fresh";
  return "stale";
}
```

- [ ] **Step 4: Run, confirm pass**

```bash
mise exec -- npm test -- tests/lib/staleness.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Run the full suite — sanity check**

```bash
mise exec -- npm test
```

Expected: all tests still pass (Plan 1's 8 + log 6 + paths 4 + config 13 + matching 7 + cache 8 + guards 7 + staleness 4 = 57 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/staleness.ts tests/lib/staleness.test.ts
git commit -m "feat: add staleness check (src/lib/staleness.ts)"
```

---

## Phase 3 — Hook scripts (TDD per hook)

Each hook is a TypeScript script that reads a JSON payload from stdin, performs its job, and exits. Integration tests spawn the compiled hook as a child process to verify end-to-end behavior.

---

### Task 10: `record-read.ts` — PostToolUse(Read)

Records reads into the agent's cache; optionally emits a hint when the read path matches a rule with unsatisfied requires.

**Files:**
- Create: `/Users/noah.zuch/nessy/src/hooks/record-read.ts`
- Create: `/Users/noah.zuch/nessy/tests/hooks/record-read.test.ts`
- Create: `/Users/noah.zuch/nessy/tests/_support/runHook.ts`
- Create: `/Users/noah.zuch/nessy/tests/_support/buildFakeProject.ts`

- [ ] **Step 1: Write the test harness helpers**

Create `/Users/noah.zuch/nessy/tests/_support/buildFakeProject.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export type FakeProject = {
  projectRoot: string;
  cleanup: () => void;
};

export function buildFakeProject(opts: {
  config?: string;
  files?: Record<string, string>;
}): FakeProject {
  const projectRoot = mkdtempSync(join(tmpdir(), "nessy-fake-"));
  if (opts.config !== undefined) {
    mkdirSync(join(projectRoot, ".nessy"), { recursive: true });
    writeFileSync(join(projectRoot, ".nessy/config.yml"), opts.config);
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const full = join(projectRoot, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return {
    projectRoot,
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}
```

Create `/Users/noah.zuch/nessy/tests/_support/runHook.ts`:

```ts
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type HookResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutJson: unknown;
};

export function runHook(
  scriptName: string,
  payload: unknown,
  opts: { cwd?: string } = {},
): HookResult {
  const repo = join(__dirname, "..", "..");
  const scriptPath = join(repo, "dist", "hooks", `${scriptName}.js`);
  const res = spawnSync("node", [scriptPath], {
    input: JSON.stringify(payload),
    cwd: opts.cwd,
    encoding: "utf8",
  });
  let stdoutJson: unknown = null;
  if (res.stdout.trim().length > 0) {
    try {
      stdoutJson = JSON.parse(res.stdout);
    } catch {
      // leave null
    }
  }
  return {
    exitCode: res.status ?? -1,
    stdout: res.stdout,
    stderr: res.stderr,
    stdoutJson,
  };
}
```

Note: `__dirname` requires CommonJS. Since the project is ESM, use the equivalent:

```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

— include this at the top of `runHook.ts` instead of relying on global `__dirname`.

- [ ] **Step 2: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/hooks/record-read.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { buildFakeProject, type FakeProject } from "../_support/buildFakeProject.js";
import { runHook } from "../_support/runHook.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let project: FakeProject | null = null;

afterEach(() => {
  project?.cleanup();
  project = null;
});

describe("record-read hook", () => {
  it("no-ops silently when .nessy/config.yml is missing", () => {
    project = buildFakeProject({});
    const result = runHook("record-read", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(project.projectRoot, "README.md") },
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project.projectRoot, ".nessy/cache"))).toBe(false);
  });

  it("records a read into the agent's cache file", () => {
    project = buildFakeProject({
      config: "version: 1\nrules: []\n",
      files: { "docs/coding.md": "# coding standards" },
    });
    const result = runHook("record-read", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(project.projectRoot, "docs/coding.md") },
    });
    expect(result.exitCode).toBe(0);
    const cachePath = join(
      project.projectRoot,
      ".nessy/cache/s1/__root__.json",
    );
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cache.reads).toHaveLength(1);
    expect(cache.reads[0].path).toBe("docs/coding.md");
    expect(typeof cache.reads[0].mtime_ms).toBe("number");
    expect(typeof cache.reads[0].size).toBe("number");
  });

  it("writes to {agent_id}.json when agent_id is in the payload", () => {
    project = buildFakeProject({
      config: "version: 1\nrules: []\n",
      files: { "docs/x.md": "x" },
    });
    runHook("record-read", {
      session_id: "s1",
      agent_id: "agentA",
      agent_type: "Explore",
      cwd: project.projectRoot,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(project.projectRoot, "docs/x.md") },
    });
    expect(
      existsSync(join(project.projectRoot, ".nessy/cache/s1/agentA.json")),
    ).toBe(true);
  });

  it("skips reads under .nessy/", () => {
    project = buildFakeProject({
      config: "version: 1\nrules: []\n",
      files: { ".nessy/standards.md": "x" },
    });
    runHook("record-read", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(project.projectRoot, ".nessy/standards.md") },
    });
    expect(
      existsSync(join(project.projectRoot, ".nessy/cache/s1/__root__.json")),
    ).toBe(false);
  });

  it("dedupes by path on repeated reads of the same file", () => {
    project = buildFakeProject({
      config: "version: 1\nrules: []\n",
      files: { "docs/x.md": "x" },
    });
    runHook("record-read", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(project.projectRoot, "docs/x.md") },
    });
    runHook("record-read", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(project.projectRoot, "docs/x.md") },
    });
    const cache = JSON.parse(
      readFileSync(
        join(project.projectRoot, ".nessy/cache/s1/__root__.json"),
        "utf8",
      ),
    );
    expect(cache.reads).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run, confirm fail (file not built yet)**

```bash
mise exec -- npm run build && mise exec -- npm test -- tests/hooks/record-read.test.ts
```

- [ ] **Step 4: Implement**

Create `/Users/noah.zuch/nessy/src/hooks/record-read.ts`:

```ts
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findProjectRoot } from "../lib/paths.js";
import {
  cachePathFor,
  loadCache,
  upsertRead,
  saveCache,
} from "../lib/cache.js";
import { parseConfig } from "../lib/config.js";
import { matchRules } from "../lib/matching.js";
import { configure, log, type Level } from "../lib/log.js";

type Payload = {
  session_id: string;
  agent_id?: string;
  agent_type?: string;
  cwd: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
};

function readPayload(): Payload | null {
  try {
    const raw = readFileSync(0, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalize(p: string): string {
  return p.split("\\").join("/");
}

function main(): void {
  const payload = readPayload();
  if (!payload || typeof payload.session_id !== "string") return;

  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  const sessionId = payload.session_id;
  const agentId = payload.agent_id ?? null;

  // Best-effort log_level peek
  let level: Level = "info";
  try {
    const yaml = readFileSync(
      `${projectRoot}/.nessy/config.yml`,
      "utf8",
    );
    const cfg = parseConfig(yaml);
    level = cfg.log_level;
  } catch {
    // keep default
  }
  configure({ level, hookName: "record-read", sessionId, agentId });

  const file = payload.tool_input?.file_path;
  if (!file) return;

  const absTarget = resolve(file);
  const relTarget = normalize(relative(projectRoot, absTarget));
  if (relTarget.startsWith("..") || relTarget.startsWith(".nessy/")) return;

  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(absTarget);
  } catch {
    log("warn", `stat failed for ${relTarget}; skipping record`);
    return;
  }

  const path = cachePathFor(projectRoot, sessionId, agentId);
  const cache = loadCache(path);
  cache.reads = upsertRead(cache.reads, {
    path: relTarget,
    mtime_ms: st.mtimeMs,
    size: st.size,
  });
  cache.session_id = sessionId;
  cache.agent_id = agentId;
  saveCache(path, cache);
  log("debug", `recorded read: ${relTarget}`);

  // Proactive hint (best-effort)
  try {
    const yaml = readFileSync(
      `${projectRoot}/.nessy/config.yml`,
      "utf8",
    );
    const cfg = parseConfig(yaml);
    if (!cfg.hints) return;
    const matched = matchRules(relTarget, cfg.rules);
    if (matched.length === 0) return;
    const known = new Set(cache.reads.map((r) => r.path));
    const unread: string[] = [];
    for (const r of matched) {
      for (const req of r.require) {
        if (!known.has(req) && !unread.includes(req)) unread.push(req);
      }
    }
    if (unread.length === 0) return;

    const names = matched.map((r) => r.name).join(", ");
    const message = [
      `Nessy: You just read \`${relTarget}\`, which is covered by rule(s): ${names}.`,
      `Before you Write or Edit this file (or any other file matching the same rule), read the following:`,
      ...unread.map((p) => `  - ${p}`),
      ``,
      `Reading them now means no interrupted writes later.`,
    ].join("\n");

    // Emit via the verified mechanism from Phase 1 Task 2.
    // If that field name turned out to be different, replace this line.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { additionalContext: message },
      }),
    );
    log("info", `hint: emitted for ${matched.map((r) => r.name).join(",")}`);
  } catch (e) {
    log(
      "warn",
      `hint emission skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

main();
```

- [ ] **Step 5: Build and run tests**

```bash
mise exec -- npm run build && mise exec -- npm test -- tests/hooks/record-read.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/record-read.ts tests/_support/buildFakeProject.ts tests/_support/runHook.ts tests/hooks/record-read.test.ts dist/
git commit -m "feat: add record-read hook (PostToolUse Read)"
```

---

### Task 11: `check-reads.ts` — PreToolUse(Write|Edit)

The enforcement hook. Order: self-mod guard → config load → rule match → cache check → block or allow.

**Files:**
- Create: `/Users/noah.zuch/nessy/src/hooks/check-reads.ts`
- Create: `/Users/noah.zuch/nessy/tests/hooks/check-reads.test.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/hooks/check-reads.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { buildFakeProject, type FakeProject } from "../_support/buildFakeProject.js";
import { runHook } from "../_support/runHook.js";
import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

let project: FakeProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function seedCacheFile(
  projectRoot: string,
  sessionId: string,
  agentId: string | null,
  reads: { path: string; mtime_ms: number; size: number }[],
): void {
  const filename = agentId === null ? "__root__.json" : `${agentId}.json`;
  const dir = join(projectRoot, ".nessy/cache", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    JSON.stringify({ version: 1, session_id: sessionId, agent_id: agentId, reads }),
  );
}

describe("check-reads hook", () => {
  it("allows when .nessy/config.yml is missing", () => {
    project = buildFakeProject({});
    const result = runHook("check-reads", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(project.projectRoot, "src/foo.ts") },
    });
    expect(result.exitCode).toBe(0);
  });

  it("blocks self-mod (write into .nessy/) before considering config", () => {
    project = buildFakeProject({ config: "version: 1\nrules: []\n" });
    const result = runHook("check-reads", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: join(project.projectRoot, ".nessy/config.yml"),
      },
    });
    // Block decision is communicated via stdout JSON in the Claude Code hook contract.
    expect(result.stdoutJson).toBeTruthy();
    const out = result.stdoutJson as { decision?: string; reason?: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/\.nessy\//);
  });

  it("blocks when config is malformed YAML", () => {
    project = buildFakeProject({ config: "version: 1\nrules: [" });
    const result = runHook("check-reads", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(project.projectRoot, "src/foo.ts") },
    });
    const out = result.stdoutJson as { decision?: string; reason?: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/YAML|configuration/);
  });

  it("allows when no rule matches", () => {
    project = buildFakeProject({
      config: `version: 1
rules:
  - name: source
    match: ["src/**"]
    require: ["docs/coding.md"]
`,
    });
    const result = runHook("check-reads", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(project.projectRoot, "README.md") },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutJson).toBe(null);
  });

  it("blocks when a required file has not been read", () => {
    project = buildFakeProject({
      config: `version: 1
rules:
  - name: source
    match: ["src/**"]
    require: ["docs/coding.md"]
`,
      files: {
        "docs/coding.md": "# standards",
        "src/foo.ts": "// stub",
      },
    });
    const result = runHook("check-reads", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(project.projectRoot, "src/foo.ts") },
    });
    const out = result.stdoutJson as { decision?: string; reason?: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("docs/coding.md");
    expect(out.reason).toContain("not yet read");
  });

  it("allows when all requires are in cache and fresh", () => {
    project = buildFakeProject({
      config: `version: 1
rules:
  - name: source
    match: ["src/**"]
    require: ["docs/coding.md"]
`,
      files: {
        "docs/coding.md": "# standards",
        "src/foo.ts": "// stub",
      },
    });
    const st = statSync(join(project.projectRoot, "docs/coding.md"));
    seedCacheFile(project.projectRoot, "s1", null, [
      { path: "docs/coding.md", mtime_ms: st.mtimeMs, size: st.size },
    ]);
    const result = runHook("check-reads", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(project.projectRoot, "src/foo.ts") },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutJson).toBe(null);
  });

  it("blocks with stale status when mtime/size differs", () => {
    project = buildFakeProject({
      config: `version: 1
rules:
  - name: source
    match: ["src/**"]
    require: ["docs/coding.md"]
`,
      files: {
        "docs/coding.md": "# standards",
        "src/foo.ts": "// stub",
      },
    });
    const st = statSync(join(project.projectRoot, "docs/coding.md"));
    seedCacheFile(project.projectRoot, "s1", null, [
      { path: "docs/coding.md", mtime_ms: st.mtimeMs - 1000, size: st.size },
    ]);
    const result = runHook("check-reads", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(project.projectRoot, "src/foo.ts") },
    });
    const out = result.stdoutJson as { decision?: string; reason?: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("changed on disk");
  });

  it("blocks with config-error when a required file is missing on disk", () => {
    project = buildFakeProject({
      config: `version: 1
rules:
  - name: source
    match: ["src/**"]
    require: ["docs/coding.md"]
`,
      files: { "src/foo.ts": "// stub" },
      // intentionally no docs/coding.md
    });
    const result = runHook("check-reads", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(project.projectRoot, "src/foo.ts") },
    });
    const out = result.stdoutJson as { decision?: string; reason?: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/configuration error|config error/i);
    expect(out.reason).toContain("docs/coding.md");
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm run build && mise exec -- npm test -- tests/hooks/check-reads.test.ts
```

- [ ] **Step 3: Implement**

Create `/Users/noah.zuch/nessy/src/hooks/check-reads.ts`:

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

type Payload = {
  session_id: string;
  agent_id?: string;
  cwd: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
};

function readPayload(): Payload | null {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

function block(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

function normalize(p: string): string {
  return p.split("\\").join("/");
}

const SELF_MOD_MSG =
  "Nessy: `.nessy/` is plugin-managed state and should not be edited by Claude. " +
  "Read-only access is fine. To change rules, ask the user to edit `.nessy/config.yml` directly. " +
  "To clear cache, run the matching plugin command (or delete the file yourself if you're the user).";

function main(): void {
  const payload = readPayload();
  if (!payload || typeof payload.session_id !== "string") return;

  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  const file = payload.tool_input?.file_path;
  if (!file) return;
  const absTarget = resolve(file);

  // Configure log with default level until config is loaded; we still want
  // self-mod/config-error logs even before config is parsed.
  configure({
    level: "info",
    hookName: "check-reads",
    sessionId: payload.session_id,
    agentId: payload.agent_id ?? null,
  });

  if (isUnderNessyDir(absTarget, projectRoot)) {
    log("info", `block: self-mod ${file}`);
    return block(SELF_MOD_MSG);
  }

  let cfg;
  try {
    const yaml = readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8");
    cfg = parseConfig(yaml, `${projectRoot}/.nessy/config.yml`);
  } catch (e) {
    const detail =
      e instanceof ConfigError ? e.message : (e as Error)?.message ?? String(e);
    log("error", `block: config-error ${detail}`);
    return block(
      `Nessy: configuration error in .nessy/config.yml\n\n${detail}\n\nAsk the user to fix the config before continuing. Do not retry the write.`,
    );
  }

  configure({
    level: cfg.log_level as Level,
    hookName: "check-reads",
    sessionId: payload.session_id,
    agentId: payload.agent_id ?? null,
  });

  const relTarget = normalize(relative(projectRoot, absTarget));
  if (relTarget.startsWith("..")) {
    log("debug", `allow: target outside project (${relTarget})`);
    return;
  }

  const matched = matchRules(relTarget, cfg.rules);
  if (matched.length === 0) {
    log("debug", `allow: no rule matches ${relTarget}`);
    return;
  }
  const required = unionRequires(matched);

  const cachePath = cachePathFor(
    projectRoot,
    payload.session_id,
    payload.agent_id ?? null,
  );
  const cache = loadCache(cachePath);
  const byPath = new Map(cache.reads.map((r) => [r.path, r]));

  type Status = { path: string; status: "missing" | "stale" | "config-error" };
  const issues: Status[] = [];
  for (const req of required) {
    const entry = byPath.get(req);
    if (!entry) {
      issues.push({ path: req, status: "missing" });
      continue;
    }
    const full = resolve(projectRoot, req);
    const s = checkStaleness(full, entry.mtime_ms, entry.size);
    if (s === "missing") issues.push({ path: req, status: "config-error" });
    else if (s === "stale") issues.push({ path: req, status: "stale" });
  }

  if (issues.length === 0) {
    log("info", `allow: requires satisfied for ${matched.map((r) => r.name).join(",")}`);
    return;
  }

  const configErrors = issues.filter((i) => i.status === "config-error");
  if (configErrors.length > 0) {
    const lines = configErrors
      .map((c) => `  - rule '${matched.find((r) => r.require.includes(c.path))?.name}' requires \`${c.path}\`, which does not exist on disk`)
      .join("\n");
    log("error", `block: config-error (missing files)`);
    return block(
      `Nessy: configuration error in .nessy/config.yml\n\n${lines}\n\nAsk the user to either create those files or remove them from .nessy/config.yml. Do not retry the write.`,
    );
  }

  const names = matched.map((r) => r.name).join(", ");
  const lines = issues.map((i) => {
    const tag =
      i.status === "missing"
        ? "[not yet read this session]"
        : "[changed on disk since you last read it]";
    return `  - ${i.path}      ${tag}`;
  });
  log("info", `block: missing-reads ${issues.map((i) => i.path).join(",")}`);
  return block(
    [
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
    ].join("\n"),
  );
}

main();
```

- [ ] **Step 4: Build and run tests**

```bash
mise exec -- npm run build && mise exec -- npm test -- tests/hooks/check-reads.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/check-reads.ts tests/hooks/check-reads.test.ts dist/
git commit -m "feat: add check-reads hook (PreToolUse Write|Edit)"
```

---

### Task 12: `wipe-agent.ts` — PreCompact + SubagentStop

Deletes the current agent's cache file. Same script for both events.

**Files:**
- Create: `/Users/noah.zuch/nessy/src/hooks/wipe-agent.ts`
- Create: `/Users/noah.zuch/nessy/tests/hooks/wipe-agent.test.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/hooks/wipe-agent.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { buildFakeProject, type FakeProject } from "../_support/buildFakeProject.js";
import { runHook } from "../_support/runHook.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let project: FakeProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function seed(
  projectRoot: string,
  sessionId: string,
  agentId: string | null,
): string {
  const filename = agentId === null ? "__root__.json" : `${agentId}.json`;
  const dir = join(projectRoot, ".nessy/cache", sessionId);
  mkdirSync(dir, { recursive: true });
  const full = join(dir, filename);
  writeFileSync(
    full,
    JSON.stringify({
      version: 1,
      session_id: sessionId,
      agent_id: agentId,
      reads: [],
    }),
  );
  return full;
}

describe("wipe-agent hook", () => {
  it("deletes the root cache file when no agent_id", () => {
    project = buildFakeProject({ config: "version: 1\nrules: []\n" });
    const file = seed(project.projectRoot, "s1", null);
    const result = runHook("wipe-agent", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreCompact",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it("deletes only the subagent's file on SubagentStop", () => {
    project = buildFakeProject({ config: "version: 1\nrules: []\n" });
    const rootFile = seed(project.projectRoot, "s1", null);
    const agentFile = seed(project.projectRoot, "s1", "agentA");
    const result = runHook("wipe-agent", {
      session_id: "s1",
      agent_id: "agentA",
      cwd: project.projectRoot,
      hook_event_name: "SubagentStop",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(agentFile)).toBe(false);
    expect(existsSync(rootFile)).toBe(true);
  });

  it("tolerates a missing cache file (ENOENT)", () => {
    project = buildFakeProject({ config: "version: 1\nrules: []\n" });
    const result = runHook("wipe-agent", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreCompact",
    });
    expect(result.exitCode).toBe(0);
  });

  it("no-ops when .nessy/config.yml missing", () => {
    project = buildFakeProject({});
    const result = runHook("wipe-agent", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "PreCompact",
    });
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm run build && mise exec -- npm test -- tests/hooks/wipe-agent.test.ts
```

- [ ] **Step 3: Implement**

Create `/Users/noah.zuch/nessy/src/hooks/wipe-agent.ts`:

```ts
import { readFileSync, rmSync } from "node:fs";
import { findProjectRoot } from "../lib/paths.js";
import { cachePathFor } from "../lib/cache.js";
import { parseConfig } from "../lib/config.js";
import { configure, log, type Level } from "../lib/log.js";

type Payload = {
  session_id: string;
  agent_id?: string;
  cwd: string;
  hook_event_name?: string;
};

function readPayload(): Payload | null {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

function main(): void {
  const payload = readPayload();
  if (!payload || typeof payload.session_id !== "string") return;
  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  let level: Level = "info";
  try {
    const yaml = readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8");
    level = parseConfig(yaml).log_level;
  } catch {
    // keep default
  }
  configure({
    level,
    hookName: "wipe-agent",
    sessionId: payload.session_id,
    agentId: payload.agent_id ?? null,
  });

  const file = cachePathFor(
    projectRoot,
    payload.session_id,
    payload.agent_id ?? null,
  );
  try {
    rmSync(file, { force: true });
    log("info", `wipe: ${file} (event=${payload.hook_event_name ?? "?"})`);
  } catch (e) {
    log("warn", `wipe failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main();
```

- [ ] **Step 4: Build and run tests**

```bash
mise exec -- npm run build && mise exec -- npm test -- tests/hooks/wipe-agent.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/wipe-agent.ts tests/hooks/wipe-agent.test.ts dist/
git commit -m "feat: add wipe-agent hook (PreCompact + SubagentStop)"
```

---

### Task 13: `wipe-session.ts` — Stop

Removes the entire `{session_id}/` cache directory.

**Files:**
- Create: `/Users/noah.zuch/nessy/src/hooks/wipe-session.ts`
- Create: `/Users/noah.zuch/nessy/tests/hooks/wipe-session.test.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/hooks/wipe-session.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { buildFakeProject, type FakeProject } from "../_support/buildFakeProject.js";
import { runHook } from "../_support/runHook.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let project: FakeProject | null = null;
afterEach(() => {
  project?.cleanup();
  project = null;
});

function seedSessionDir(projectRoot: string, sessionId: string): string {
  const dir = join(projectRoot, ".nessy/cache", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "__root__.json"),
    JSON.stringify({ version: 1, session_id: sessionId, agent_id: null, reads: [] }),
  );
  writeFileSync(
    join(dir, "agentA.json"),
    JSON.stringify({ version: 1, session_id: sessionId, agent_id: "agentA", reads: [] }),
  );
  return dir;
}

describe("wipe-session hook", () => {
  it("removes the session directory and all files in it", () => {
    project = buildFakeProject({ config: "version: 1\nrules: []\n" });
    const dir = seedSessionDir(project.projectRoot, "s1");
    const result = runHook("wipe-session", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "Stop",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves other session directories untouched", () => {
    project = buildFakeProject({ config: "version: 1\nrules: []\n" });
    const dirA = seedSessionDir(project.projectRoot, "s1");
    const dirB = seedSessionDir(project.projectRoot, "s2");
    runHook("wipe-session", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "Stop",
    });
    expect(existsSync(dirA)).toBe(false);
    expect(existsSync(dirB)).toBe(true);
  });

  it("tolerates missing session directory", () => {
    project = buildFakeProject({ config: "version: 1\nrules: []\n" });
    const result = runHook("wipe-session", {
      session_id: "s1",
      cwd: project.projectRoot,
      hook_event_name: "Stop",
    });
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm run build && mise exec -- npm test -- tests/hooks/wipe-session.test.ts
```

- [ ] **Step 3: Implement**

Create `/Users/noah.zuch/nessy/src/hooks/wipe-session.ts`:

```ts
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "../lib/paths.js";
import { parseConfig } from "../lib/config.js";
import { configure, log, type Level } from "../lib/log.js";

type Payload = { session_id: string; cwd: string; hook_event_name?: string };

function readPayload(): Payload | null {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

function main(): void {
  const payload = readPayload();
  if (!payload || typeof payload.session_id !== "string") return;
  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  let level: Level = "info";
  try {
    level = parseConfig(
      readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8"),
    ).log_level;
  } catch {
    // keep default
  }
  configure({
    level,
    hookName: "wipe-session",
    sessionId: payload.session_id,
    agentId: null,
  });

  const dir = join(projectRoot, ".nessy", "cache", payload.session_id);
  try {
    rmSync(dir, { recursive: true, force: true });
    log("info", `wipe-session: ${dir}`);
  } catch (e) {
    log(
      "warn",
      `wipe-session failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

main();
```

- [ ] **Step 4: Build and run tests**

```bash
mise exec -- npm run build && mise exec -- npm test -- tests/hooks/wipe-session.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/wipe-session.ts tests/hooks/wipe-session.test.ts dist/
git commit -m "feat: add wipe-session hook (Stop)"
```

---

### Task 14: `block-nessy-cli.ts` — PreToolUse(Bash)

Blocks Claude from invoking `nessy init` / `nessy remove` via Bash.

**Files:**
- Create: `/Users/noah.zuch/nessy/src/hooks/block-nessy-cli.ts`
- Create: `/Users/noah.zuch/nessy/tests/hooks/block-nessy-cli.test.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/noah.zuch/nessy/tests/hooks/block-nessy-cli.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runHook } from "../_support/runHook.js";

function call(command: string) {
  return runHook("block-nessy-cli", {
    session_id: "s1",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
}

describe("block-nessy-cli hook", () => {
  it("blocks `nessy init`", () => {
    const r = call("nessy init");
    const out = r.stdoutJson as { decision?: string; reason?: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/user-only/);
  });

  it("blocks `nessy remove`", () => {
    const r = call("nessy remove");
    const out = r.stdoutJson as { decision?: string };
    expect(out.decision).toBe("block");
  });

  it("blocks `./bin/nessy init`", () => {
    const r = call("./bin/nessy init");
    const out = r.stdoutJson as { decision?: string };
    expect(out.decision).toBe("block");
  });

  it("blocks `node dist/cli/main.js init`", () => {
    const r = call("node dist/cli/main.js init");
    const out = r.stdoutJson as { decision?: string };
    expect(out.decision).toBe("block");
  });

  it("blocks `bin/nessy remove --yes`", () => {
    const r = call("bin/nessy remove --yes");
    const out = r.stdoutJson as { decision?: string };
    expect(out.decision).toBe("block");
  });

  it("allows ordinary commands", () => {
    expect(call("ls -la").exitCode).toBe(0);
    expect(call("ls -la").stdoutJson).toBe(null);
    expect(call("git status").stdoutJson).toBe(null);
    expect(call("npm test").stdoutJson).toBe(null);
  });

  it("allows `nessy --help` and `nessy --version`", () => {
    expect(call("nessy --help").stdoutJson).toBe(null);
    expect(call("nessy --version").stdoutJson).toBe(null);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm run build && mise exec -- npm test -- tests/hooks/block-nessy-cli.test.ts
```

- [ ] **Step 3: Implement**

Create `/Users/noah.zuch/nessy/src/hooks/block-nessy-cli.ts`:

```ts
import { readFileSync } from "node:fs";
import { configure, log } from "../lib/log.js";

type Payload = {
  session_id: string;
  agent_id?: string;
  cwd: string;
  tool_name?: string;
  tool_input?: { command?: string };
};

function readPayload(): Payload | null {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

const PATTERNS: RegExp[] = [
  /\bnessy\s+(init|remove)\b/,
  /\b(?:\.\/)?(?:bin\/)?nessy\s+(init|remove)\b/,
  /\bnode\s+\S*cli(?:\.js)?\s+(init|remove)\b/,
];

const BLOCK_MSG =
  "Nessy: `nessy init` and `nessy remove` are user-only commands; Claude cannot run them. " +
  "If the user wants this, they should invoke `/nessy:init` or `/nessy:remove` themselves.";

function main(): void {
  const payload = readPayload();
  if (!payload) return;
  configure({
    level: "info",
    hookName: "block-nessy-cli",
    sessionId: payload.session_id ?? "",
    agentId: payload.agent_id ?? null,
  });

  const cmd = payload.tool_input?.command ?? "";
  let matched = false;
  try {
    matched = PATTERNS.some((re) => re.test(cmd));
  } catch (e) {
    log("error", `regex failure: ${e instanceof Error ? e.message : String(e)}`);
    return; // fail open
  }
  if (!matched) return;
  log("info", `block: ${cmd}`);
  process.stdout.write(
    JSON.stringify({ decision: "block", reason: BLOCK_MSG }),
  );
}

main();
```

- [ ] **Step 4: Build and run tests**

```bash
mise exec -- npm run build && mise exec -- npm test -- tests/hooks/block-nessy-cli.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/block-nessy-cli.ts tests/hooks/block-nessy-cli.test.ts dist/
git commit -m "feat: add block-nessy-cli hook (PreToolUse Bash)"
```

---

## Phase 4 — Real CLI

Replaces the Plan 1 noop functions with real behavior.

---

### Task 15: Default config template

**Files:**
- Create: `/Users/noah.zuch/nessy/templates/default-config.yml`

- [ ] **Step 1: Write the template**

Create `/Users/noah.zuch/nessy/templates/default-config.yml`:

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

- [ ] **Step 2: Commit**

```bash
git add templates/default-config.yml
git commit -m "feat: add default .nessy/config.yml template"
```

---

### Task 16: Real `nessy init`

Replaces the noop in `src/cli/init.ts` with real `.nessy/` creation.

**Files:**
- Modify: `/Users/noah.zuch/nessy/src/cli/init.ts`
- Modify: `/Users/noah.zuch/nessy/tests/cli/init.test.ts`
- Modify: `/Users/noah.zuch/nessy/tests/cli/index.test.ts` (dispatch test for `init` route — Plan 1's exact-string output assertion no longer holds)

- [ ] **Step 1: Update tests to assert real behavior**

Replace `/Users/noah.zuch/nessy/tests/cli/init.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nessyInit } from "../../src/cli/init.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "nessy-init-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("nessyInit (real)", () => {
  it("creates .nessy/ with a config.yml derived from the template", () => {
    const output: string[] = [];
    const code = nessyInit((m) => output.push(m), cwd);
    expect(code).toBe(0);
    const cfgPath = join(cwd, ".nessy/config.yml");
    expect(existsSync(cfgPath)).toBe(true);
    const text = readFileSync(cfgPath, "utf8");
    expect(text).toContain("version: 1");
    expect(text).toContain("hints: true");
    expect(text).toContain("rules: []");
    expect(output.join("\n")).toMatch(/Initialized \.nessy\//);
  });

  it("refuses (non-zero) when .nessy/ already exists", () => {
    mkdirSync(join(cwd, ".nessy"));
    const output: string[] = [];
    const code = nessyInit((m) => output.push(m), cwd);
    expect(code).not.toBe(0);
    expect(output.join("\n")).toContain("already exists");
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm test -- tests/cli/init.test.ts
```

- [ ] **Step 3: Implement**

Replace `/Users/noah.zuch/nessy/src/cli/init.ts` with:

```ts
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTemplate(): string {
  // dist/cli/init.js → ../templates/default-config.yml lives at plugin root
  // dist layout: <pluginRoot>/dist/cli/init.js
  // template:    <pluginRoot>/templates/default-config.yml
  const pluginRoot = join(__dirname, "..", "..");
  return readFileSync(join(pluginRoot, "templates", "default-config.yml"), "utf8");
}

export function nessyInit(
  print: (msg: string) => void,
  cwd: string,
): number {
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
```

- [ ] **Step 4: Update the dispatch test for `init`**

Plan 1's `tests/cli/index.test.ts` asserted that `dispatch(["init"], ..., "/tmp/p")` produces a specific noop output string. Now that `nessyInit` does real filesystem work, that test would attempt to create `.nessy/` inside a hardcoded path that doesn't exist. Update the dispatch test to use a real tempdir and assert on filesystem effects instead.

Open `/Users/noah.zuch/nessy/tests/cli/index.test.ts`. Find this test:

```ts
it("routes 'init' to nessyInit", () => {
  const output: string[] = [];
  const code = dispatch(["init"], (m) => output.push(m), "/tmp/p");
  expect(code).toBe(0);
  expect(output).toEqual([
    "[nessy init — noop] would create .nessy/ at /tmp/p",
  ]);
});
```

Replace with:

```ts
it("routes 'init' to nessyInit (creates .nessy/ at the given cwd)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nessy-dispatch-init-"));
  try {
    const output: string[] = [];
    const code = dispatch(["init"], (m) => output.push(m), tmp);
    expect(code).toBe(0);
    expect(existsSync(join(tmp, ".nessy/config.yml"))).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

Add the required imports at the top of the file (next to the existing vitest imports):

```ts
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 5: Run, confirm pass**

```bash
mise exec -- npm test -- tests/cli/init.test.ts tests/cli/index.test.ts
```

Expected: 2 tests pass in `init.test.ts`, all 5 dispatch tests still pass in `index.test.ts`.

- [ ] **Step 6: Build dist/ to keep it current**

```bash
mise exec -- npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/init.ts tests/cli/init.test.ts tests/cli/index.test.ts dist/
git commit -m "feat: real nessy init creates .nessy/ from template"
```

---

### Task 17: Real `nessy remove`

Replaces the noop in `src/cli/remove.ts` with real removal + TTY confirmation + `--yes` flag.

**Files:**
- Modify: `/Users/noah.zuch/nessy/src/cli/remove.ts`
- Modify: `/Users/noah.zuch/nessy/tests/cli/remove.test.ts`
- Modify: `/Users/noah.zuch/nessy/tests/cli/index.test.ts` (dispatch test for `remove` route)

- [ ] **Step 1: Update tests**

Replace `/Users/noah.zuch/nessy/tests/cli/remove.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nessyRemove } from "../../src/cli/remove.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "nessy-remove-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("nessyRemove (real)", () => {
  it("no-ops with exit 0 when .nessy/ doesn't exist", () => {
    const output: string[] = [];
    const code = nessyRemove((m) => output.push(m), cwd, ["--yes"]);
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("Nothing to remove");
  });

  it("removes .nessy/ recursively with --yes", () => {
    mkdirSync(join(cwd, ".nessy"));
    writeFileSync(join(cwd, ".nessy/config.yml"), "version: 1\nrules: []\n");
    mkdirSync(join(cwd, ".nessy/cache"));
    const output: string[] = [];
    const code = nessyRemove((m) => output.push(m), cwd, ["--yes"]);
    expect(code).toBe(0);
    expect(existsSync(join(cwd, ".nessy"))).toBe(false);
  });

  it("refuses non-interactive removal without --yes (non-TTY stdin)", () => {
    mkdirSync(join(cwd, ".nessy"));
    // In vitest, process.stdin is not a TTY, simulating slash-command/script invocation.
    const output: string[] = [];
    const code = nessyRemove((m) => output.push(m), cwd, []);
    expect(code).not.toBe(0);
    expect(existsSync(join(cwd, ".nessy"))).toBe(true);
    expect(output.join("\n")).toMatch(/--yes/);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
mise exec -- npm test -- tests/cli/remove.test.ts
```

- [ ] **Step 3: Implement**

Replace `/Users/noah.zuch/nessy/src/cli/remove.ts` with:

```ts
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

function hasFlag(flags: string[], name: string): boolean {
  return flags.includes(name);
}

export function nessyRemove(
  print: (msg: string) => void,
  cwd: string,
  flags: string[],
): number {
  const nessy = join(cwd, ".nessy");
  if (!existsSync(nessy)) {
    print(`Nothing to remove. (.nessy/ does not exist at ${cwd}.)`);
    return 0;
  }
  const yes = hasFlag(flags, "--yes");
  const isInteractive = Boolean(process.stdin.isTTY);
  if (!yes && !isInteractive) {
    print(
      `Refusing to remove .nessy/ non-interactively. Pass --yes to confirm, or run in an interactive shell.`,
    );
    return 1;
  }
  if (!yes && isInteractive) {
    // Synchronous prompt: ask once via a single-line stdin read.
    process.stderr.write(`Remove .nessy/ and all its contents? [y/N] `);
    const buf = Buffer.alloc(64);
    let nread = 0;
    try {
      nread = require("node:fs").readSync(0, buf, 0, buf.length, null);
    } catch {
      print("Failed to read confirmation; aborting.");
      return 1;
    }
    const answer = buf.subarray(0, nread).toString("utf8").trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      print("Aborted.");
      return 1;
    }
  }
  rmSync(nessy, { recursive: true, force: true });
  print(`Removed .nessy/ at ${cwd}.`);
  return 0;
}
```

Note: the `require("node:fs").readSync(0, ...)` pattern is intentional for a synchronous TTY read inside an exported function. Using `process.stdin` directly returns a Stream in ESM, which would require async refactoring of the function signature — the synchronous approach keeps the test shape simple. If TypeScript's strict mode complains about `require` in ESM, add `// @ts-expect-error CJS require for sync stdin read` directly above the line.

- [ ] **Step 4: Update the dispatch test for `remove`**

Plan 1's `tests/cli/index.test.ts` asserted that `dispatch(["remove", "--yes"], ..., "/tmp/p")` produces a specific noop output. Now `nessyRemove` no-ops with "Nothing to remove" when `.nessy/` doesn't exist. Update the dispatch test to use a real tempdir and assert on the new behavior.

Find this test:

```ts
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
```

Replace with:

```ts
it("routes 'remove' to nessyRemove and passes remaining args as flags", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nessy-dispatch-remove-"));
  try {
    // .nessy/ doesn't exist yet — `nessy remove` is a no-op that prints "Nothing to remove" and returns 0.
    const output: string[] = [];
    const code = dispatch(
      ["remove", "--yes"],
      (m) => output.push(m),
      tmp,
    );
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("Nothing to remove");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

(The `mkdtempSync`, `rmSync`, `tmpdir`, `join` imports were already added during Task 16 Step 4.)

- [ ] **Step 5: Run, confirm pass**

```bash
mise exec -- npm test -- tests/cli/remove.test.ts tests/cli/index.test.ts
```

Expected: 3 tests pass in `remove.test.ts`, all 5 dispatch tests still pass in `index.test.ts`.

- [ ] **Step 6: Build dist/**

```bash
mise exec -- npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/remove.ts tests/cli/remove.test.ts tests/cli/index.test.ts dist/
git commit -m "feat: real nessy remove with --yes flag and TTY confirmation"
```

---

## Phase 5 — Wiring + finalization

---

### Task 18: Register all hooks in `hooks/hooks.json`

Populates the previously-empty hooks registry with the five hook events.

**Files:**
- Modify: `/Users/noah.zuch/nessy/hooks/hooks.json`

- [ ] **Step 1: Write the full hook registry**

Replace `/Users/noah.zuch/nessy/hooks/hooks.json` with:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/record-read.js"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/check-reads.js"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/block-nessy-cli.js"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/wipe-agent.js"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/wipe-agent.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/hooks/wipe-session.js"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Sanity-check**

```bash
cat hooks/hooks.json
```

Confirm the file is valid JSON and references all five hook scripts.

- [ ] **Step 3: Commit**

```bash
git add hooks/hooks.json
git commit -m "feat: register all five hook events in hooks/hooks.json"
```

---

### Task 19: README + CLAUDE.md cleanup

Addresses the Important issue from Plan 1's final review (README silent about mise) and removes the stale CLAUDE.md.

**Files:**
- Modify: `/Users/noah.zuch/nessy/README.md`
- Delete: `/Users/noah.zuch/nessy/CLAUDE.md` (if present)

- [ ] **Step 1: Update README to mention mise**

Edit `/Users/noah.zuch/nessy/README.md`. Add this paragraph above the existing `npm install` section:

```
**Prerequisites:** Node 22 via [mise](https://mise.jdx.dev/). Once mise is installed, run `mise install` from the repo root to provision the Node version pinned in `.mise.toml`. If your shell has mise activation hooks loaded, `npm` and `node` work directly; otherwise, prefix with `mise exec --`.
```

The README now reflects what Plan 1 + Plan 2 actually require for development.

- [ ] **Step 2: Remove stale CLAUDE.md**

```bash
[ -f CLAUDE.md ] && git rm CLAUDE.md || true
```

(The old CLAUDE.md described the discarded Python CLI architecture. Any future CLAUDE.md should be regenerated from the current source.)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: mention mise prerequisite in README; remove stale CLAUDE.md"
```

If `CLAUDE.md` was indeed deleted, the commit captures that too. If it wasn't present, the commit only updates `README.md`.

---

### Task 20: Final rebuild, full test run, and manual verification handoff

Make sure `dist/` is current, every test passes, and Plan 2 is ready for end-to-end manual validation.

- [ ] **Step 1: Clean rebuild**

```bash
rm -rf dist
mise exec -- npm run build
```

Expected: `dist/cli/`, `dist/hooks/` populated with all built files.

- [ ] **Step 2: Run the full test suite**

```bash
mise exec -- npm test
```

Expected: all tests pass. Count = Plan 1's 8 + Phase 2's 49 (6 + 4 + 13 + 7 + 8 + 7 + 4) + Phase 3's 27 (5 + 8 + 4 + 3 + 7) + Phase 4's 5 (2 init + 3 remove) = roughly 89 tests. Adjust to whatever the actual run reports.

- [ ] **Step 3: Verify `git status` is clean**

```bash
git status
```

If `dist/` shows modified files, stage and commit:

```bash
git add dist/
git commit -m "build: refresh dist/ for Plan 2 final" || echo "(dist already current)"
```

- [ ] **Step 4: Push**

```bash
git push
```

- [ ] **Step 5: Manual end-to-end verification — surface back to the user**

This step is **user-driven**. The agent executing this plan should pause and hand off to the user with the following checklist. Do **not** attempt to execute these in a subagent.

User checklist:

- [ ] In Claude Code: `/plugin marketplace update` — pulls the latest from the marketplace.
- [ ] In a project that already has a `.nessy/config.yml`: trigger Claude to read a file matching one of the rules and confirm the hint fires (per Phase 1 Task 2's verified mechanism).
- [ ] Have Claude attempt to `Write` or `Edit` a file matching a rule **without** having read the required file first — expect the block message.
- [ ] Have Claude read the required file, then retry the write — expect success.
- [ ] Have Claude attempt to write into `.nessy/` directly — expect the self-mod block.
- [ ] Have Claude attempt to run `nessy init` or `nessy remove` via Bash — expect the block-nessy-cli message.
- [ ] In a project without a `.nessy/config.yml`: confirm no hooks fire, no blocks happen — silent no-op.
- [ ] `/nessy:init` in a fresh directory: confirm `.nessy/config.yml` appears with the template content.
- [ ] `/nessy:remove`: confirm `.nessy/` disappears.

If any of these steps fail unexpectedly, capture the actual behavior + any hook log output (stderr surfaced by Claude Code) and either iterate inside this plan (if it's a code fix) or open a follow-up issue (if it's a docs/behavior question for a v2 release).

---

## Plan 2 acceptance criteria

Plan 2 is **complete** when all of the following are true:

1. All Phase 1 verification items have documented findings under `docs/superpowers/verifications/`.
2. All Phase 2–4 tasks are committed; every test in the suite passes via `mise exec -- npm test`.
3. `hooks/hooks.json` registers all five hook events.
4. The README documents the mise prerequisite.
5. End-to-end manual verification (Task 20 Step 5) confirms the standards-drift enforcement works in a real Claude Code session.

## What's deferred to a future release (v3)

Per the spec's §9 Open Questions:

- **Per-rule `hint: false` override** — straightforward to add, defer until there's demand.
- **Globs in `require:`** — design needed (any-of vs all-of semantics).
- **`allow_self_edits` to relax the self-mod guard** — only if real demand appears.
- **Bash file-write interception for standards-drift** — out of scope by design.

## Out-of-scope reminders

- No new lib modules beyond what's listed above.
- No restructuring the plugin into `./plugins/nessy/` (the documented canonical pattern). That's a possible v3 cleanup if the marketplace + `"./"` source ever breaks; for now it works.
- No additional hooks beyond the five registered in Task 18.
