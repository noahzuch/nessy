# Design: `runHook` wrapper for shared hook setup

## Problem

Every hook in `src/hooks/` repeats the same setup sequence: parse the payload, find the project root, load config for the log level, and call `configure()`. Two hooks also duplicate a `normalize` path utility inline.

## Solution

A `runHook` helper in `src/lib/run-hook.ts` centralises this boilerplate. Each hook body shrinks to its business logic inside a callback.

## Interface

```ts
// Discriminated union — prevents the impossible combination (requiresProject: false + requiresConfig: true)
type RunHookOpts =
  | { requiresProject: false }
  | { requiresProject: true; requiresConfig: false }
  | { requiresProject: true; requiresConfig: true  }

// Three overloads give exact ctx types at each call site
function runHook<T extends BasePayload>(
  name: string,
  schema: ZodSchema<T>,
  opts: { requiresProject: false },
  fn: (ctx: { payload: T; sessionId: string; agentId: string | undefined; projectRoot: string | null; cfg: Config | null }) => void
): void

function runHook<T extends BasePayload>(
  name: string,
  schema: ZodSchema<T>,
  opts: { requiresProject: true; requiresConfig: false },
  fn: (ctx: { payload: T; sessionId: string; agentId: string | undefined; projectRoot: string; cfg: Config | null }) => void
): void

function runHook<T extends BasePayload>(
  name: string,
  schema: ZodSchema<T>,
  opts: { requiresProject: true; requiresConfig: true },
  fn: (ctx: { payload: T; sessionId: string; agentId: string | undefined; projectRoot: string; cfg: Config }) => void
): void
```

`ctx.sessionId` and `ctx.agentId` are convenience aliases for `payload.session_id` / `payload.agent_id` — no `?? null` coercion, typed as-is from the schema.

## Control flow (implementation)

1. `payload = readAndParsePayload(schema)` — always returns `T`, throws on invalid or missing payload. Process exits non-zero; Claude Code surfaces the error rather than silently swallowing bad input.
2. **If `requiresProject: true`**: `projectRoot = findProjectRoot(payload.cwd)` — silently return if null.
   **If `requiresProject: false`**: best-effort `findProjectRoot(payload.cwd)` → `string | null`, always continue.
3. Best-effort config load (only when `projectRoot` is non-null): read + parse `.nessy/config.yml`, extract `log_level`. Call `configure({ level, hookName, sessionId, agentId })` once.
4. **If `requiresConfig: true`** and config failed in step 3: emit `{ decision: "block", reason: "Nessy: configuration error in .nessy/config.yml — ask the user to fix the config before continuing." }` and return, preserving `check-reads`' blocking behaviour without a per-hook message.
5. Call `fn(ctx)`.

## File changes

| File | Change |
|---|---|
| `src/lib/payload.ts` | `readAndParsePayload` return type `T \| null` → `T` (throws). All null-guard call sites removed. |
| `src/lib/paths.ts` | Add `normalize` as a named export (moved from `record-read.ts` and `record-at-mention.ts`). |
| `src/lib/run-hook.ts` | New file — `RunHookOpts`, `runHook` overloads + implementation. |
| `src/hooks/*.ts` (all six) | Refactored to use `runHook`. Business logic moves into the callback. |

## Hook → opts mapping

| Hook | `requiresProject` | `requiresConfig` |
|---|---|---|
| `block-nessy-cli` | `false` | — |
| `wipe-agent` | `true` | `false` |
| `wipe-session` | `true` | `false` |
| `record-read` | `true` | `false` |
| `record-at-mention` | `true` | `false` |
| `check-reads` | `true` | `true` |

## Behaviour change notes

- `check-reads` currently emits a detailed config-parse error message when `.nessy/config.yml` is invalid. After this refactor the wrapper emits a generic block instead. The hook itself no longer calls `configure()` twice.
- `readAndParsePayload` is now a breaking change to callers outside hooks (none currently exist, but tests that mock it will need updating).
