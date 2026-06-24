# Nessy — Claude Code Guide

Nessy is a Claude Code plugin that implements a development workflow harness.

## Commands

```bash
npm install          # install deps
npm test             # run vitest suite (all tests)
npm run test:watch   # vitest in watch mode
npm run build        # tsc + tsc-alias + merge-hooks → dist/
npm run lint         # tsc --noEmit (type-check only)
npm run format       # prettier write
```

Build = `tsc && tsc-alias && node scripts/merge-hooks.mjs`. `tsc-alias` post-processes the compiled output to rewrite `src/*` path aliases to relative paths; `merge-hooks.mjs` regenerates `hooks/hooks.json` from each feature's `hooks.fragment.json`. **Always rebuild before running hook integration tests** — they invoke `dist/` directly via `node`.

`dist/` is committed. Users install the plugin without a build step; the compiled output must be up-to-date before pushing.

## Project layout

```
src/
  cli/        # nessy init / nessy remove CLI commands
  features/   # one dir per feature (hooks, lib, hooks.fragment.json)
    read-before-write/
    block-nessy-cli/
    block-nessy-dir-writes/
  shared/     # shared infrastructure (config, log, paths, payload, run-hook)
tests/
  cli/        # unit tests for CLI commands
  features/   # mirrors src/features/ — integration + unit tests per feature
  shared/     # unit tests for src/shared/
  _support/   # test helpers: runHook, buildFakeProject
hooks/
  hooks.json  # generated — see docs/adr/0001-hooks-json-generation.md
scripts/
  merge-hooks.mjs  # merges hooks.fragment.json files into hooks/hooks.json
templates/
  default-config.yml  # written by `nessy init`
bin/
  nessy       # bash wrapper; Claude Code adds bin/ to PATH when plugin is active
```

## Architecture

### How a hook works

Each file in `src/features/<feature>/hooks/` is a standalone script. Claude Code runs it as a child process, passing a JSON payload on stdin. The script:
1. Reads and validates the payload with `readAndParsePayload`
2. Finds the project root by walking up from `cwd` looking for `.nessy/config.yml`
3. Does its work, writing a JSON decision to stdout if needed

All hooks are intentionally stateless — the only shared state is the cache files on disk.

### Cache

`.nessy/cache/<session_id>/<agent_id>.json` — one file per agent. Root session uses `__root__.json`. Format: `{ version, session_id, agent_id, reads: [{ path, mtime_ms, size }] }`. Paths are relative to the project root, normalized to forward slashes.

Staleness is detected by comparing `mtime_ms` + `size` at write-time against the cache entry. If the file changed on disk since the last read, the write is blocked as stale.

### Config

`.nessy/config.yml` — validated by Zod on every hook invocation. Schema:
```yaml
version: 1          # required, must be 1
hints: true         # proactive hint output on reads
log_level: info     # debug | info | warn | error
rules:
  - name: unique-id
    match: "src/**"          # gitignore-style glob(s), supports ! negation
    require:
      - docs/standards/coding.md
```

Rule matching uses the `ignore` package (gitignore semantics). No config file = plugin is inactive for that project.

### Logging

`src/shared/log.ts` — writes structured JSON to stderr. `configure()` must be called once per hook invocation before `log()` is used. Output format: `{ ts, level, hook, session_id, agent_id, message }`.

## Import aliases

`src/*` and `tests/*` are path aliases configured in:
- `vitest.config.ts` — runtime resolution for tests
- `tsconfig.json` — editor/type-checker support for `src/` files
- `tsconfig.test.json` — editor support for test files (use this as your IDE project for `tests/`)

Use `src/shared/foo.js` or `src/features/<feature>/lib/foo.js` not `../lib/foo.js` in source files. Use `src/cli/foo.js` and `tests/_support/foo.js` in test files.

## Testing patterns

**Unit tests** (`tests/features/`, `tests/shared/`, `tests/cli/`) import source modules directly via the `src/` alias. Fast, no filesystem side-effects beyond tmp dirs.

**Integration tests** (`tests/features/<feature>/`) use `runHook(scriptPath, payload, opts)` from `tests/_support/runHook.ts`. This spawns the compiled script at `dist/<scriptPath>.js` as a subprocess (e.g. `"features/read-before-write/hooks/record-read"`) — you must `npm run build` first for changes to take effect.

`buildFakeProject()` from `tests/_support/buildFakeProject.ts` creates a temp directory with a minimal `.nessy/config.yml` for hook integration tests.
