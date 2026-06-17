# Nessy — Read-Before-Write Enforcement (Design Spec)

- **Date:** 2026-06-17
- **Status:** Draft, pending implementation
- **Scope:** One feature, end-to-end. Prior Nessy designs (Python CLI, SDLC layer, audit log, `state.json`) are discarded.
- **Implementation language:** TypeScript, compiled to JavaScript, executed by Node.

## 1. Goals and Non-Goals

### Goals

- Prevent **standards drift**: when Claude is about to `Write` or `Edit` a file matching a project-defined path pattern, guarantee the relevant standards file(s) are in its current context first.
- Be **per-project opt-in** via a checked-in `.nessy/config.yml`. The plugin is safe to install globally and only activates where this file exists.
- Be **per-agent**: each Claude agent (root session and every subagent spawned via `Task` or `--agent`) tracks its own reads independently. Reads in a subagent do not satisfy requirements in the parent and vice versa, because the parent and the subagent have separate contexts.
- Be **simple to operate**: no daemon, no shared mutable state. Each hook touches one file it owns.
- **Nudge proactively**: when Claude reads a file covered by a rule, surface the rule's required reads so they are loaded *before* a write is attempted, not after a write is blocked.
- **Provide setup commands**: ship a small CLI (`nessy init`, `nessy remove`) wrapped by slash commands (`/nessy:init`, `/nessy:remove`) so users can opt projects in and out without hand-creating `.nessy/`.

### Non-goals

- **Other failure modes** (blind edits of the target file itself, missing-neighbors, subagent context-gap as a goal in itself) are explicitly out of scope for v1.
- **Bash file writes for standards-drift enforcement.** `echo > src/foo.ts`, `sed -i`, `tee` to a rule-matched path are not intercepted for the read-before-write check. Parsing arbitrary shell for that is out of scope. The plugin does install **one** narrow Bash hook that blocks Claude from invoking the `nessy` CLI itself; that is its sole purpose.
- **MCP / custom tool plugins** are not intercepted. Only the standard `Write` and `Edit` tools.
- **Per-session override / bypass** for writes. There is no "skip the check just this once" flag. If you need to develop the rules themselves, edit the config or remove it temporarily.
- **An SDLC layer**, audit log, or any state beyond what is needed for this enforcement.

## 2. Architecture and Scope

### Plugin layout

A Claude Code plugin laid out per the Claude Code plugin convention:

```
nessy/                                    # plugin root
├── .claude-plugin/
│   └── plugin.json                       # plugin metadata (name, version, description)
├── package.json                          # npm package metadata + scripts
├── tsconfig.json
├── hooks/
│   └── hooks.json                        # registers all hook events
├── commands/
│   ├── init.md                           # /nessy:init slash command
│   └── remove.md                         # /nessy:remove slash command
├── bin/
│   └── nessy                             # CLI entry; added to PATH when plugin is enabled
├── dist/                                 # compiled output (committed — see Installation)
│   ├── cli/
│   │   └── index.js
│   └── hooks/
│       ├── record-read.js
│       ├── check-reads.js
│       ├── wipe-agent.js
│       ├── wipe-session.js
│       └── block-nessy-cli.js
├── src/                                  # TypeScript source
│   ├── cli/
│   │   ├── index.ts                      # subcommand dispatch
│   │   ├── init.ts
│   │   └── remove.ts
│   ├── hooks/
│   │   ├── record-read.ts
│   │   ├── check-reads.ts
│   │   ├── wipe-agent.ts
│   │   ├── wipe-session.ts
│   │   └── block-nessy-cli.ts
│   └── lib/
│       ├── config.ts
│       ├── cache.ts
│       ├── matching.ts
│       ├── paths.ts
│       ├── guards.ts
│       ├── staleness.ts
│       └── log.ts
├── templates/
│   └── default-config.yml                # what `nessy init` writes
├── tests/
└── README.md
```

Conventions worth highlighting (these are Claude Code's, not ours):

- **`.claude-plugin/plugin.json`** holds only metadata (name, version, description). Hook registration lives in `hooks/hooks.json`, not in `plugin.json`. Slash command registration is implicit via the `commands/` directory — no manifest entry needed.
- **`bin/nessy`** is the CLI entry. Claude Code adds the plugin's `bin/` to `PATH` automatically when the plugin is enabled. The script is a small shim: `node "$CLAUDE_PLUGIN_ROOT/dist/cli/index.js" "$@"`.
- **Hook scripts** are referenced from `hooks/hooks.json` as `${CLAUDE_PLUGIN_ROOT}/dist/hooks/<name>.js` with `type: "command"`.
- **`dist/` is committed.** Rationale in *Installation and Updates* below.

### Runtime dependencies (kept small)

- `yaml` — parses `.nessy/config.yml`.
- `ignore` — gitignore-syntax pattern matching: globs, `**`, negation (`!pattern`), directory semantics. Same library used widely in the Node ecosystem; behavior is unsurprising.
- Node stdlib only otherwise (`node:fs/promises`, `node:path`, `node:os`, `node:crypto`).

### Development tooling

- TypeScript with `strict: true`, ES2022 target, ESM output.
- `vitest` for unit and integration tests.
- `npm` as the package manager.
- A single `tsc` build step compiles `src/` → `dist/`. Source maps stay enabled; stack traces point at `.ts`.
- Plugin distribution ships compiled `dist/` — no runtime TypeScript dependency.

### Per-project surface

Everything project-specific lives under `.nessy/` at the project root:

```
.nessy/
  config.yml                              # rules + settings; checked in
  cache/                                  # runtime state; gitignored
    {session_id}/                         # one subdir per root session
      __root__.json                       # root session's read cache
      {agent_id}.json                     # one file per subagent
```

`.nessy/config.yml` is checked into the repository; `.nessy/cache/` is gitignored. The plugin owns nothing else under `.nessy/`.

The files a rule's `require:` points at — typically standards documents like `docs/standards/coding.md`, a root-level `CONTRIBUTING.md`, or `.github/PULL_REQUEST_TEMPLATE.md` — are **not** part of `.nessy/`. They live wherever the project already keeps its documentation. The plugin doesn't ship or own them; `config.yml` simply references their project-relative paths.

### Activation rule

All hooks no-op silently if `.nessy/config.yml` cannot be found by walking up from the hook's `cwd`. The plugin is safe to install globally and only "switches on" in projects that have opted in.

### Hook events

| Event                        | Hook script           | Job                                                                          |
| ---------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `PostToolUse` (Read)         | `record-read.js`      | Append `(path, mtime, size)` to current agent's cache; emit hint if covered. |
| `PreToolUse` (Write \| Edit)  | `check-reads.js`      | Match target against rules; block with prompt if missing required reads.     |
| `PreToolUse` (Bash)          | `block-nessy-cli.js`  | Block Claude from invoking `nessy init` / `nessy remove` via Bash.           |
| `PreCompact`                 | `wipe-agent.js`       | Delete the current agent's cache file.                                       |
| `SubagentStop`               | `wipe-agent.js`       | Delete just the stopping subagent's cache file.                              |
| `Stop`                       | `wipe-session.js`     | Delete every cache file belonging to this session_id (root + subagents).     |

Five scripts handle six hook events; `wipe-agent.js` is the single script registered for both `PreCompact` and `SubagentStop`. Each script does one thing.

### Why this shape

Each cache file has a single writer (the owning agent). No locking. No read-modify-write hazards. The single project-level config means rules are versioned alongside the code they govern. The "no config = silent no-op" rule means the plugin is safe to install everywhere.

### Installation and updates

The plugin is distributed through Claude Code's marketplace mechanism. Users do not clone the repo manually.

**One-time setup on a fresh machine:**

```
/plugin marketplace add <git-url-to-the-marketplace-repo>
/plugin install nessy@<marketplace-name>
```

The marketplace is a `marketplace.json` file hosted in a Git repo (typically the same repo as this plugin, or a sibling), conforming to the schema documented in the Claude Code [plugin marketplace docs](https://code.claude.com/docs/en/plugin-marketplaces.md). After `marketplace add`, the user picks plugins from that source by name.

**Updates:**

```
/plugin marketplace update
```

…re-fetches the marketplace index. Installed plugins update from there.

**Why `dist/` is committed.** The Claude Code install path is *not documented* to run `npm install` or `npm run build` on the fetched plugin. To work reliably on any machine without a build toolchain, the plugin ships its compiled JavaScript in `dist/`, committed to the repo. The `src/` TypeScript is also committed (for development) but is not what Claude Code executes — `bin/nessy` and `hooks/hooks.json` point at `dist/`. A normal development cycle is:

1. Edit `src/`.
2. Run `npm run build` (compiles `src/` → `dist/`).
3. Commit both `src/` and `dist/`.
4. Push. Users run `/plugin marketplace update` to pick up the change.

The exact behavior of `/plugin marketplace update` regarding fetch-vs-rebuild is **partially undocumented** (see §9 Open Questions). The committed-`dist/` rule keeps us safe regardless.

## 3. Configuration (`.nessy/config.yml`)

### Shape

```yaml
version: 1
hints: true                              # optional, default true
log_level: info                          # optional, default info
rules:
  - name: source
    match:
      - "src/**"
      - "lib/**"
      - "!src/generated/**"              # negation supported
    require:
      - docs/standards/coding.md

  - name: tests
    match: "tests/**"                    # string or list, both fine
    require:
      - docs/standards/testing.md
      - docs/standards/coding.md

  - name: docs
    match: ["docs/**", "*.md", "!CHANGELOG.md"]
    require:
      - docs/standards/docs.md
```

### Top-level fields

| Field       | Type                    | Required | Default | Notes                                                                                                                 |
| ----------- | ----------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `version`   | integer                 | yes      | —       | Schema version. v1 is the only legal value. Unknown versions fail loud.                                               |
| `hints`     | boolean                 | no       | `true`  | When `true`, `record-read` emits proactive nudges for covered paths. When `false`, no hints (but enforcement remains). |
| `log_level` | string                  | no       | `info`  | One of `debug`, `info`, `warn`, `error`. Minimum severity logged to stderr.                                            |
| `rules`     | array of rule objects   | yes      | —       | May be empty (no enforcement; plugin still active). Order is for logging only; matching is order-independent.         |

### Rule fields

| Field     | Type                       | Required | Notes                                                                                          |
| --------- | -------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `name`    | string                     | yes      | Unique across rules. Used in block messages and logs.                                          |
| `match`   | string or array of strings | yes      | Gitignore-syntax patterns matched against the target file's project-relative path.             |
| `require` | array of strings           | yes      | Literal project-relative file paths. Non-empty. No globs (intentional; see Open Questions).     |

### Multi-match semantics — union

If a target matches multiple rules, the required set is the union of all matching rules' `require` lists, deduplicated. Order-independent. If "first match wins" would be useful, the rules overlap accidentally — fix the rules.

### Path resolution

All paths in the file — `match` patterns and `require` entries — are interpreted relative to the project root (the directory containing `.nessy/`). The Read/Write/Edit tools provide absolute paths; the hooks normalize to project-relative POSIX paths (forward slashes) before comparing.

### Pattern matching engine

The `ignore` package implements gitignore syntax: standard globs, `**` for any depth, `!pattern` for negation, directory matching, ordering rules. Documented and predictable.

### `require` is literal paths, not globs

Globs in `require` would force a confusing "any one matching file" vs "all matching files" decision. Single-purpose for v1. Can be added later if a real need appears.

### Missing-file behavior (config references a path that doesn't exist on disk)

Surfaced at *match time*, not load time. If a rule fires and one of its `require` files is missing on disk, the hook fails the write with a clear message:

> *Nessy config error: rule `source` requires `docs/standards/coding.md`, but that file does not exist. Either create it or remove it from `.nessy/config.yml`.*

A stale `require` does not silently degrade enforcement.

### Malformed-config behavior

- YAML parse error or schema validation failure: `check-reads` blocks the write with the parse/validation detail and the file path. `record-read` and the cleanup hooks tolerate a missing or broken config silently — recording reads and wiping cache are safe even if rules can't be evaluated.
- Unknown `version`: rejected as a schema violation.

### Schema validation

A small hand-written validator (no `zod`/`ajv` dependency — the schema is small enough):

- `version` is exactly `1`.
- `hints`, if present, is a boolean.
- `log_level`, if present, is one of `debug | info | warn | error`.
- `rules` is an array (may be empty; an empty list means the plugin is opted in but no rules are enforced — a valid state after `nessy init`).
- Each rule (when present) has `name` (string), `match` (string or array of strings), `require` (non-empty array of strings).
- Rule `name` values are unique across the array.

### `.nessy/` self-modification guard

A separate guard, evaluated *before* config parsing in `check-reads`. If the target of a `Write` or `Edit` resolves under the project's `.nessy/` directory, block with a dedicated message:

> *Nessy: `.nessy/` is plugin-managed state and should not be edited by Claude. Read-only access is fine. To change rules, ask the user to edit `.nessy/config.yml` directly. To clear cache, run the matching plugin command (or delete the file yourself if you're the user).*

Why hard-block the whole directory, not just `cache/`:

- `cache/**` must be hook-only — Claude editing it would corrupt the read state.
- `config.yml` is user-authored intent for the plugin itself. Letting Claude rewrite the rules it is supposed to be governed by on its own initiative defeats the purpose.
- A blanket block is simpler than a per-subdir policy and fails safe.

(Standards files referenced by `require:` are *not* under `.nessy/` and are not affected by this guard — they're ordinary project files, and Claude may edit them like any other file when the user asks.)

Scope: same as the rest — `Write` and `Edit` only. Read access to `.nessy/` is fully allowed. Bash redirections are out of scope.

Precedence: this guard runs before the read-cache check, so a write to anything under `.nessy/` (e.g., `.nessy/config.yml`) is rejected by the self-mod guard, not by the missing-read-cache rule. Block messages stay single-cause.

If `.nessy/config.yml` doesn't exist, this guard doesn't run — the plugin is not opted into.

## 4. Data Flow and Cache Format

### Cache file layout

Nested — one subdirectory per root session, one file per agent within it:

```
.nessy/cache/
  {session_id}/
    __root__.json                       # root session's read cache
    {agent_id}.json                     # subagent (one file per subagent)
```

`__root__.json` is the sentinel filename for the root agent (i.e., when the hook payload has no `agent_id`). The double-underscore prefix makes it unambiguous against any plausible `agent_id` value while keeping cleanup operations simple. `session_id` and `agent_id` are independent filesystem path components, so no delimiter assumptions are needed — either value can legally contain any character the filesystem permits.

### Cache file contents

```json
{
  "version": 1,
  "session_id": "01HZ...",
  "agent_id": null,
  "agent_type": null,
  "reads": [
    { "path": "docs/standards/coding.md", "mtime_ms": 1718600000123, "size": 4123 },
    { "path": "docs/standards/testing.md", "mtime_ms": 1718600000456, "size": 2871 }
  ]
}
```

- `path` — project-relative, POSIX-style. Normalized at write time so comparisons with `require:` entries are direct string equality.
- `mtime_ms`, `size` — staleness signal. A required read whose current `(mtime, size)` no longer matches the cache is treated as not-read.
- `reads` is deduplicated by path; re-reading the same file replaces the existing entry with the newer mtime/size.
- `agent_id` and `agent_type` are stored in the JSON for self-description even though `agent_id` is also encoded in the filename. Redundant on purpose: a cache file can be diagnosed without parsing its name.

### Project root discovery

Walk up from the hook payload's `cwd` looking for `.nessy/config.yml`. Stop at filesystem root. If not found, the hook no-ops (silent allow). Cached for the duration of a single hook invocation.

### Per-hook flow

#### `record-read.ts` — PostToolUse(Read)

No-op silently on any failure (must never block a Read).

1. Find project root. If none → exit 0.
2. Resolve `tool_input.file_path` to absolute, then project-relative POSIX.
3. Skip recording if the read path is under `.nessy/**` or outside the project root. Neither can ever satisfy a `require:`, recording adds noise.
4. `stat` the file. Stat failure → exit 0.
5. Compute cache file path. `mkdir -p .nessy/cache/{session_id}/` (idempotent; safe to call on every read).
6. Load cache JSON (treat parse errors or missing file as empty). Dedupe-update by path.
7. Atomic write: `{cache}.tmp.{pid}.{ts}` → `rename` to final.
8. Best-effort: load config; if loaded, evaluate the proactive hint (see below); emit it if applicable.
9. Exit 0.

#### `check-reads.ts` — PreToolUse(tool ∈ {Write, Edit})

Order matters — first matching condition wins, so block messages stay single-cause.

1. Find project root. None → allow.
2. Resolve target path to project-relative.
3. **Self-mod guard.** Target under `.nessy/` → block with self-mod message. Runs before config load.
4. Load `.nessy/config.yml`. Parse error or schema validation failure → block with config-error message (includes the parse or validation detail and file path).
5. Match target against all rules' `match` patterns. No matches → allow.
6. Accumulate the union of matching rules' `require` lists.
7. For each required file:
   - Not in cache → record as `missing`.
   - In cache but file no longer exists on disk → record as `config-error`.
   - In cache, file exists, `(mtime, size)` differs from cached → record as `stale`.
   - Otherwise → satisfied.
8. Any non-satisfied entry → block with the missing-reads message (lists each file with its specific status). Otherwise → allow.

#### `wipe-agent.ts` — PreCompact and SubagentStop

Same script, dispatched on `hook_event_name`.

1. Find project root. None → exit 0.
2. Compute this agent's cache path (using `agent_id` from payload, falling back to root file name when absent).
3. `unlink`, ignoring `ENOENT`.
4. Exit 0.

#### `wipe-session.ts` — Stop

1. Find project root. None → exit 0.
2. `fs.rm({projectRoot}/.nessy/cache/{session_id}, { recursive: true, force: true })`. One call; tolerates a missing directory.
3. Exit 0.

#### `block-nessy-cli.ts` — PreToolUse(tool=Bash)

Prevents Claude from running the `nessy` CLI itself. The only Bash interception in the plugin.

1. Read `tool_input.command` from the payload.
2. If the command matches any of these patterns (case-sensitive, word-boundary-aware), block:
   - `\bnessy\s+(init|remove)\b`
   - `\b(?:\./)?(?:bin/)?nessy\s+(init|remove)\b`
   - `\bnode\s+\S*cli(?:\.js)?\s+(init|remove)\b`
3. Block message: *"Nessy: `nessy init` and `nessy remove` are user-only commands; Claude cannot run them. If the user wants this, they should invoke `/nessy:init` or `/nessy:remove` themselves."*
4. All other Bash commands → allow (exit 0).
5. Hook does **not** load `.nessy/config.yml`. It runs regardless of whether the current project is opted into Nessy — `nessy init` and `nessy remove` are user-only everywhere.

This is **not** a general Bash file-write guard (see §1 Non-goals). It exists solely to keep `nessy init` / `nessy remove` user-only.

### Proactive read hints

Goal: warn Claude about required reads *while it is exploring*, so they are in context by the time it tries to Write or Edit. Reduces the "first write blocked → re-read → retry" cycle.

Behavior on every PostToolUse(Read), after the existing record step (skipped when `hints: false`):

1. Match the just-read file against every rule's `match` patterns.
2. For each matching rule, take its `require` list and filter to entries not yet in the agent's cache.
3. If the resulting set is non-empty, emit an informational hint to Claude (non-blocking).

Hint message shape:

```
Nessy: You just read `<path>`, which is covered by rule(s): source.
Before you Write or Edit this file (or any other file matching `src/**`),
read the following:
  - docs/standards/coding.md

Reading them now means no interrupted writes later.
```

Why this works alongside the strict block: the hint is a soft nudge; the PreToolUse block is the enforcement. If Claude ignores hints, it still hits the block at write time. If it follows them, writes succeed first try.

No suppression in v1. If Claude reads `src/foo.ts`, `src/bar.ts`, `src/baz.ts` in succession without yet reading `coding.md`, the hint fires three times. Annoying but informative — and self-extinguishing the moment Claude reads `coding.md`.

Skip cases (no hint emitted):

- Read of a file outside the project root.
- Read of any file under `.nessy/**`.
- Read of a file matching rules where all requires are already satisfied.
- `hints: false` in config.
- Config missing or malformed (best-effort failure — never blocks the Read hook).

### Atomic write pattern

```ts
async function atomicWriteJson(target: string, data: unknown) {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, target);
}
```

Sufficient because each cache file has a single writer (the owning agent). Hooks fire sequentially within an agent, so there is no intra-agent race.

### Block-message format invariants

Every blocking response from `check-reads` follows the same shape:

```
Nessy: <one-line summary of why blocked>

<details — multi-line if needed, but always actionable>

<explicit next action — "Read these files", "Ask the user to fix config", "Do not retry">
```

Three flavors:

- **Self-mod** — exact wording from §3.
- **Config error** — includes the parse or validation message and the file path; next action is "Ask the user to fix the config before continuing. Do not retry the write."
- **Missing / stale reads** — see template below.

Missing / stale template:

```
Nessy: Cannot Write/Edit `<target>` yet — required context is not loaded.

Triggered rule(s): <name1>, <name2>
You must have these files in your current context before writing:
  - docs/standards/coding.md      [not yet read this session]
  - docs/standards/testing.md     [changed on disk since you last read it]

Use the Read tool on each of the files above, then retry the same Write/Edit.

Note: even if a prior summary mentions these files, recent compaction may
have removed their actual content from your context. Re-read them.
```

The wording is chosen so Claude obeys instead of arguing. Two things matter most: "Use the Read tool" (specific action, not "make sure you have context"), and the compaction caveat (preempts "but I already read this earlier").

## 5. Error Handling and Failure Modes

### Two governing principles

1. **`record-read` must never block.** A buggy or failing read-tracking hook would silently degrade Claude's ability to explore. Any error path in `record-read` → log to stderr, exit 0. Worst case: the read isn't recorded, the eventual write hits the block once, Claude re-reads, retries, succeeds.

2. **`check-reads` fails closed for ambiguity, fails open for irrelevance.**
   - *Ambiguity* (config exists but is malformed, target path can't be resolved): block. The user needs to see this.
   - *Irrelevance* (no `.nessy/config.yml` at all, target outside project root): allow. The plugin is not opted into this situation.

### Per-hook failure matrix

| Failure                                                       | `record-read`                              | `check-reads`                                                                                                    | `wipe-agent` / `wipe-session`                    |
| ------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| No `.nessy/config.yml` found                                  | exit 0 (no-op)                             | exit 0 (allow)                                                                                                   | exit 0 (no-op)                                   |
| `.nessy/config.yml` malformed YAML                            | log + exit 0 (still records reads, skips hints) | **block** with parse error + file path                                                                       | exit 0 (cleanup doesn't need config)             |
| `.nessy/config.yml` fails schema validation                   | log + exit 0 (skips hints)                 | **block** with validation error                                                                                  | exit 0                                           |
| Target path resolves outside project root                     | n/a (skip recording)                       | exit 0 (allow — out of scope)                                                                                    | n/a                                              |
| Target path resolves under `.nessy/`                          | n/a (skip recording)                       | **block** with self-mod message — runs before config load                                                        | n/a                                              |
| Cache file missing                                            | treat as empty, write fresh                | treat as empty → block (no reads satisfied)                                                                      | exit 0 (ENOENT-tolerant unlink)                  |
| Cache file unreadable (permission / IO)                       | log + exit 0                               | log + treat as empty → block                                                                                     | log + exit 0                                     |
| Cache file corrupted (invalid JSON)                           | log + overwrite with fresh                 | log + treat as empty → block                                                                                     | log + unlink anyway                              |
| `stat` on target fails (file deleted between hook and check)  | exit 0 (don't record)                      | n/a (the tool itself will fail downstream)                                                                       | n/a                                              |
| `stat` on a required file fails (file removed from disk)      | n/a                                        | **block** with config-error: "rule X requires file Y, which does not exist"                                       | n/a                                              |
| Cache directory unwritable                                    | log + exit 0 (read uncaptured)             | falls through to "cache file missing" → block                                                                    | log + exit 0                                     |
| Disk full during cache write                                  | log + exit 0                               | not a write path                                                                                                 | log + exit 0                                     |
| Malformed hook payload (missing `session_id`, bad stdin JSON) | log + exit 0 (fail open)                   | log + exit 0 (fail open — Claude Code protocol bug shouldn't block the user)                                      | log + exit 0                                     |
| Atomic write fails mid-rename                                 | leaves `.tmp.{pid}.{ts}` orphan; exit 0    | n/a                                                                                                              | n/a                                              |

### Stale-cache edge cases worth calling out

**Compaction without `PreCompact` firing per-agent.** Spec assumes `PreCompact` fires with `agent_id` inside a subagent. The `(mtime, size)` staleness check is a *partial* mitigation — it catches "file changed on disk" but not "file unchanged on disk but content evicted from Claude's context by compaction." If the assumption fails, the documented fallback is to wipe the agent's cache on every `SessionStart` (cost: standards re-read once per session, which is the desired behavior anyway). Spec this fallback as a contingency, not the default.

**Concurrent reads from the same agent.** Don't happen — hooks within an agent are sequential per Claude Code's contract. The atomic write pattern protects against external interference (e.g., the user inspecting or deleting cache files mid-session), not against intra-agent races.

**`agent_id` collisions.** We trust the platform. If two subagents are ever issued the same `agent_id` within one root session, they would corrupt each other's cache files. No mitigation in v1 — this would be a Claude Code bug.

**Cache accumulation from crashed sessions.** If `Stop` doesn't fire (host crash, `kill -9` of Claude Code), cache files for that `session_id` orphan in `.nessy/cache/`. They don't affect future sessions (different `session_id`), so this is cosmetic. No sweeper in v1. If it ever becomes a real annoyance, add a SessionStart hook that deletes files older than 30 days.

### Logging

#### Required-and-only structured fields

Every log line carries exactly four pieces of metadata, every time, in addition to the message itself:

| Field        | Source                                                                  |
| ------------ | ----------------------------------------------------------------------- |
| `ts`         | ISO-8601 timestamp, set by the logger                                   |
| `hook`       | hook script name (`check-reads`, `record-read`, `wipe-agent`, `wipe-session`) |
| `session_id` | hook payload                                                            |
| `agent_id`   | hook payload (`null` for root session)                                  |

Everything else — what was blocked, which rule, which files, why a recovery happened — lives in the free-form `message` string. No additional structured fields are introduced anywhere in the codebase.

Rationale: universal identifiers are universal — they belong on every line. Per-event detail is per-event — standardizing it just invents bikesheds. Logs stay greppable on the four fields; semantic content lives in human-readable English.

#### v1 API

```ts
// src/lib/log.ts
export type Level = "debug" | "info" | "warn" | "error";

export function configure(opts: {
  level: Level;
  hookName: string;
  sessionId: string;
  agentId: string | null;
}): void;

export function log(level: Level, message: string): void;
```

That is the entire surface. No `event` parameter, no `fields` object.

#### Output shape

One JSON object per line on stderr:

```json
{"ts":"2026-06-17T10:23:00.000Z","level":"info","hook":"check-reads","session_id":"01HZ...","agent_id":null,"message":"block: Write to src/foo.ts requires reading docs/standards/coding.md (not yet read this session)"}
```

By convention (not enforced) callers may prefix messages with a short category like `block:`, `hint:`, `wipe:` to keep grep useful. The logger does not care.

#### Per-level intent

| Level   | What goes here                                                            |
| ------- | ------------------------------------------------------------------------- |
| `debug` | every read recorded, every check considered (allows included), config-load events |
| `info`  | block decisions, hint emissions, cleanup operations (default)             |
| `warn`  | non-fatal recoveries (corrupt cache rewritten, missing optional fields)   |
| `error` | hook errors that prevented intended work                                  |

#### Initialization order in every hook

1. Parse hook payload from stdin.
2. Find project root.
3. Best-effort config peek for `log_level` (failure → default `info`).
4. `configure({ level, hookName, sessionId, agentId })`.
5. Main hook logic; every call site is `log(level, message)`.

This ordering means startup parse errors (before step 3) log at the default `info`, which is always emitted. Config-related errors log at `error`, which every level emits regardless. Errors are never silently dropped due to a log-level setting.

#### Future extension — file destination

The logger is centralized so adding a file destination later is a single-file change with zero call-site churn:

```ts
// Hypothetical v2 — illustrative only, NOT implemented in v1
export function configure(opts: { level?: Level; file?: string; ... }): void;
```

Body of `configure()` opens a `WriteStream`; body of `log()` writes the same JSON line to it. No callers change.

### Cleanup hooks and `log_level`

`wipe-agent` and `wipe-session` don't otherwise need config, but they perform a *best-effort* config peek to pick up `log_level` only. If that peek fails (missing/malformed), they fall back to `info` and continue. Their primary job (deleting cache files) never blocks on a config issue.

### `block-nessy-cli` failure handling

This hook is too narrow for the "fails closed / fails open" framing above. Its policy:

- Pattern matches → block.
- Pattern does not match → exit 0 (allow).
- Regex engine itself throws (effectively impossible, but listed for completeness) → log at `error`, exit 0. A broken Nessy guard must not block ordinary Bash usage.

### Explicit non-goals / known bypasses

- **Bash file writes are not intercepted for standards-drift enforcement.** `echo > src/foo.ts`, `sed -i`, `tee` to a rule-matched path will bypass the read-before-write block. Documented limitation; closing it would require parsing arbitrary shell. The `block-nessy-cli` hook intentionally does *not* extend to file writes.
- **Plugin partial installation is not detected.** If `hooks/hooks.json` is hand-edited and one hook is removed, the user gets confusing partial behavior. v1 assumes the plugin is installed as a unit.
- **Custom MCP tool plugins are not intercepted.** Only the standard `Write` and `Edit` tools. Extension is possible by adding tool names to the PreToolUse matcher.
- **No "approve list" override.** No way for Claude (or the user mid-session) to say "skip the check just this once". Deliberate — it would undermine the guarantee.

## 6. CLI Commands

The plugin ships a small CLI for initializing and removing the per-project `.nessy/` directory. Invocable as `nessy <subcommand>` from the shell when the plugin is enabled (Claude Code adds `bin/` to `PATH` automatically). The CLI never reads `.nessy/config.yml` — `init` creates it, `remove` deletes it, neither needs to parse it.

### `nessy init`

Creates `.nessy/` at the current working directory with a default `config.yml`.

**Behavior:**

1. Resolve cwd.
2. If `.nessy/` already exists, exit non-zero with: *".nessy/ already exists at <path>; remove it first or edit the existing config."* — never silently overwrite.
3. Create `.nessy/` directory.
4. Write `.nessy/config.yml` from the template (below).
5. Print a one-line confirmation: *"Initialized .nessy/ at <path>. Edit .nessy/config.yml to define rules."*

**Default `config.yml` template** (`templates/default-config.yml` in the plugin):

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

Empty `rules: []` ships intentionally. The project is opted in (the file exists) but no rules enforce yet — `record-read` runs (skipping hints, since no rules match), `check-reads` allows everything (no rules match). The user adds rules incrementally as project standards solidify.

**Exit codes:** `0` on success; non-zero on refusal (`.nessy/` already present, IO failure).

### `nessy remove`

Deletes the entire `.nessy/` directory at cwd.

**Behavior:**

1. Resolve cwd.
2. If `.nessy/` doesn't exist, print *"Nothing to remove."* and exit `0`.
3. If stdin is a TTY (interactive shell) and `--yes` was not given, prompt: `Remove .nessy/ and all its contents? [y/N]`. Anything other than `y`/`Y`/`yes` cancels (exit non-zero).
4. If `--yes` was given, skip the prompt.
5. `fs.rm({recursive: true, force: true})` on `.nessy/`.
6. Print one-line confirmation.

**Flag:**

- `--yes` — skip the interactive prompt. Required for non-interactive use (CI, scripts, slash command invocation).

**Exit codes:** `0` on successful removal or no-op; non-zero on user cancellation or IO failure.

### Common CLI behavior

- Both commands write all human-facing output (status, prompts, errors) to stderr; stdout is reserved for nothing in v1 (slash commands surface both streams to the user regardless).
- Both commands use the same project-root semantics as the hooks: cwd, no walking up. If the user wants Nessy at a parent directory, they `cd` there first. Predictable.
- Neither command modifies anything outside `.nessy/`.

## 7. Slash Commands

The plugin exposes two slash commands as the user-facing entry to the CLI. Both live in `commands/` as Markdown files; Claude Code registers them automatically as `/nessy:init` and `/nessy:remove` — no entry in `plugin.json` needed.

### `/nessy:init`

`commands/init.md` invokes `nessy init` via Claude Code's slash-command shell-execution mechanism. Output (stdout + stderr) is surfaced to the user.

### `/nessy:remove`

`commands/remove.md` invokes `nessy remove --yes`. The `--yes` flag is required because slash commands run non-interactively and cannot service a TTY prompt. Destructiveness is gated upstream by the slash command's own confirmation UI in Claude Code, not by the CLI's TTY check.

### Why Claude cannot fire these directly

- **Slash commands themselves are not a tool Claude has access to.** Claude has Bash, Read, Write, Edit, Task, etc. — not "invoke slash command". `/nessy:init` is only callable by the user from the Claude Code prompt.
- **The Bash shortcut is closed by `block-nessy-cli`** (§4). Claude calling `Bash("nessy init")` (or variants — `./bin/nessy init`, `node dist/cli/index.js init`) is blocked.

The combination is robust against routine misbehavior. It is not literally tamper-proof — a sufficiently determined Claude could `cp $(which nessy) /tmp/x && /tmp/x init` — but such workarounds are obviously adversarial, the block message tells the user what happened, and the operation requires non-trivial shell gymnastics that Claude does not reach for during normal work.

## 8. Testing Strategy

### Two-tier approach

| Tier         | Scope                       | Tool                                | What we are verifying                                                                                                  |
| ------------ | --------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Unit**     | Pure functions in `src/lib/` | `vitest`                            | Logic correctness — pattern matching, schema validation, cache semantics, staleness math, path normalization, logger behavior |
| **Integration** | Hook scripts as black boxes | `vitest` + spawning compiled JS | Stdin JSON → stdout JSON / exit code / cache-file side-effects                                                          |

A manual verification pass closes the loop on what cannot be automated (real Claude Code session, real `PreCompact` behavior).

### Unit tests (`tests/unit/`)

One file per `src/lib/` module. Each module is designed to be testable in isolation: no global state beyond the logger's `configure()`, no Claude-Code-specific shapes.

| Module        | Key cases                                                                                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`   | valid configs (single + multi rule, negation patterns, scalar vs array `match`); malformed YAML → typed error; schema violations (missing/extra fields, wrong types, duplicate rule names, empty `require`, invalid `log_level`); defaults applied (`hints=true`, `log_level=info`); unknown `version` rejected |
| `matching.ts` | globs (`src/**`, `**/*.ts`), negation (`!src/generated/**`), single-string vs array `match`, multi-rule union, path-outside-project rejection, POSIX normalization on Windows-style inputs                                              |
| `cache.ts`    | read-missing returns empty; read-corrupted returns empty (+ logs warn); write produces correct on-disk JSON; dedup-by-path replaces older entries; atomic temp-then-rename leaves no partial file; cache path computation differs for root vs subagent |
| `paths.ts`    | project-root discovery walks up to `.nessy/config.yml`; stops at filesystem root; returns `null` if not found; symlinked roots handled; cwd-relative inputs normalized                                                                  |
| `guards.ts` (self-mod) | paths under `.nessy/` blocked; paths in sibling directories like `.nessy-old/` allowed; absolute vs relative inputs; symlink to inside `.nessy/` blocked                                                                       |
| `staleness.ts`| mtime equal & size equal → fresh; mtime differs → stale; size differs → stale; file missing on disk → config-error; both equal → fresh even if content changed (acceptable known limitation)                                            |
| `log.ts`      | level filter (debug suppressed when info configured; error always emitted); JSON shape exactly matches §5; `configure()` is idempotent (last call wins); `agent_id: null` rendered, not omitted                                          |

Coverage target: 100% of `src/lib/`.

### Integration tests (`tests/integration/`)

One file per hook script. Each test:

1. Builds a fake project in a `tmp` dir (helper described below).
2. Spawns the compiled hook (`node dist/hooks/<name>.js`).
3. Pipes a JSON payload on stdin.
4. Asserts on (a) exit code, (b) stdout JSON shape, (c) on-disk side-effects (cache file contents, deletion).

| Hook            | Cases                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `record-read`   | happy path records; skip when path under `.nessy/`; skip when path outside project; stat-failure does not crash; hint emitted when matching rule has unsatisfied requires; hint suppressed when `hints: false`; no-op when config missing |
| `check-reads`   | allow when no rules match; allow when all requires satisfied; block (missing) when requires not in cache; block (stale) when mtime/size diverged; block (config-error) when `require` file deleted; block (self-mod) when target under `.nessy/`; block (config-error) when YAML malformed; allow when no `.nessy/config.yml`            |
| `wipe-agent`    | deletes the agent's cache file on `PreCompact`; deletes only the subagent's file on `SubagentStop`; tolerates ENOENT; ignores unrelated files in the cache dir                                          |
| `wipe-session`  | removes the `{session_id}/` directory and every file inside; leaves other session directories untouched; tolerates missing session directory                                                            |
| `block-nessy-cli` | blocks `nessy init`, `nessy remove`, `./bin/nessy init`, `bin/nessy remove`, `node dist/cli/index.js init`; allows ordinary Bash (`ls`, `git status`, `npm test`); allows `nessy --help`, `nessy --version` (no init/remove keyword) |

### CLI subcommand tests (`tests/cli/`)

The `nessy init` and `nessy remove` subcommands are tested similarly to integration tests: build a temp directory, spawn the compiled CLI as a child process, assert on exit code, output, and on-disk effects.

| Subcommand     | Cases                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nessy init`   | creates `.nessy/` with template `config.yml`; refuses non-zero when `.nessy/` already exists; correct stderr message in each case                       |
| `nessy remove` | deletes `.nessy/` recursively when present; no-op (exit 0) when absent; cancels when TTY prompt answered `n`; proceeds with `--yes`; correct messages |

Coverage target: happy path + each failure mode listed in §5 for each hook.

### Test harness (`tests/_support/`)

Two helpers are worth their own files because every integration test reaches for them:

1. **`buildFakeProject(opts)`** — creates a temp project root with:
   - `.nessy/config.yml` (from a fixture or inline string),
   - optional project files referenced by `require:` (typically docs under `docs/`, but anywhere in the project tree),
   - optional pre-seeded `.nessy/cache/*.json` files,
   - returns `{ projectRoot, cleanup }`.

2. **`runHook(scriptName, payload)`** — spawns the compiled hook with the payload on stdin, captures `{ exitCode, stdoutJson, stderrLines }`. Throws on protocol violations.

Fixtures live under `tests/_support/fixtures/configs/` for re-use across tests.

### Manual verification (before merge)

1. **`PreCompact` carries `agent_id` inside a subagent.** Spec assumes yes. Verify on a real Claude Code session by triggering compaction inside a `Task`-spawned subagent and inspecting hook payloads (log at `debug`).
2. **`PostToolUse` non-blocking hint mechanism.** Spec assumes `hookSpecificOutput.additionalContext` (or equivalent) surfaces to Claude on the next turn. Verify the hint reaches Claude visibly. If not, fall back to stderr-only and document the loss.
3. **End-to-end "blocked write → read → retry succeeds" loop.** Real session: trigger a write to a covered path, confirm block, have Claude read the required file, confirm retry succeeds.
4. **`Stop` hook fires reliably when Claude Code exits.** Confirm cache directory is empty for the just-ended session after a normal exit.

### Non-goals for v1 testing

- Property-based tests for the matcher. `ignore` is already battle-tested.
- Mutation testing or fuzzing.
- Performance benchmarks.
- Cross-platform CI matrix. Develop and target macOS + Linux; Windows is best-effort.

### CI shape (minimal)

`package.json` scripts:

- `npm run build` → `tsc`
- `npm test` → `vitest run` (unit + integration)
- `npm run lint` → `tsc --noEmit` + a small `eslint` config

GitHub Actions: one workflow, one job, Node 20, run `build` + `lint` + `test`. No coverage gate as a hard CI failure in v1.

## 9. Open Questions / Verification Items

These are decisions or assumptions that must be confirmed before or during implementation.

1. **`PreCompact` and `agent_id`.** Does `PreCompact` fire inside a subagent with the subagent's `agent_id` in the payload? Spec assumes yes; if no, the fallback is wiping the agent's cache on every `SessionStart`.
2. **`PostToolUse` non-blocking hint mechanism.** Confirm the exact Claude Code field that surfaces a hint to the model without blocking the tool call. Likely `hookSpecificOutput.additionalContext`; verify field name.
3. **Per-rule `hint` override.** Deferred to v2. Adding `rules[].hint: boolean` is non-breaking.
4. **Globs in `require`.** Deferred to v2. Semantics (any-of vs all-of) need design before adding.
5. **Bash interception for file writes.** Permanently out of scope as designed. The `block-nessy-cli` hook is the only Bash hook; extending Bash interception to file writes would require a separate hook design.
6. **`/plugin marketplace update` semantics.** Does it re-fetch only, or does it ever run a build step? Spec assumes re-fetch only; ship prebuilt accordingly. Verify on a real install/update cycle before depending on the assumption.
7. **`marketplace.json` schema.** Confirm exact field shape against the current Claude Code docs (the docs guide we consulted referenced [plugin-marketplaces.md](https://code.claude.com/docs/en/plugin-marketplaces.md) but did not paste the full schema). Build the manifest and validate it loads cleanly.
8. **`commands/*.md` vs `skills/<name>/SKILL.md`.** Claude Code docs reference both layouts for user-invocable commands. Default to `commands/*.md` since slash commands here are not full skills. Verify they register and dispatch correctly under that layout; if not, fall back to the skill layout.
9. **CLI on `PATH` reliability.** Spec assumes Claude Code adds the plugin's `bin/` to `PATH` for both interactive shells (user typing `nessy init` at a terminal) and slash-command shell execution. Verify both code paths see the binary.

## 10. Glossary

- **Session.** A Claude Code conversation, root-level. Identified by `session_id`. `Stop` fires when it ends.
- **Agent.** A Claude Code execution context. The root session is one agent; each `Task`-spawned or `--agent`-invoked subagent is another. Identified by `agent_id`, which is `null` for the root session.
- **Hook payload.** The JSON blob Claude Code writes to a hook script's stdin. Contains `session_id`, `agent_id?`, `agent_type?`, `cwd`, `hook_event_name`, `tool_name?`, `tool_input?`.
- **Project root.** The directory containing `.nessy/`. Discovered by walking up from the hook's `cwd`.
- **Cache.** The set of files under `.nessy/cache/` recording each agent's reads. One file per agent.
- **Rule.** A `{name, match, require}` entry in `.nessy/config.yml`. Defines a path pattern and the files that must be read before writing into it.
- **Block.** A PreToolUse hook decision that prevents the tool call from executing and surfaces a reason to Claude.
- **Hint.** A PostToolUse-emitted message that is shown to Claude on its next turn but does not block any tool call.
