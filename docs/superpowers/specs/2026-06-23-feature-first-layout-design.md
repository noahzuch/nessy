# Feature-First Layout

**Date:** 2026-06-23  
**Status:** Approved

## Problem

The current layout is flat: all hooks live in `src/hooks/`, all shared utilities in `src/lib/`, and hook registrations in a single `hooks/hooks.json`. As Nessy grows, each new feature adds to all three locations with no structural signal about which pieces belong together. `src/lib/` in particular has become a mix of truly shared infrastructure (log, config, payload) and feature-private logic (cache, matching, staleness).

## Goal

Group each feature's hooks, private lib, and hook registration into a single top-level directory so that adding or removing a feature is a localised change. Shared infrastructure lives under `src/shared/` and is visually distinct from feature code.

## Directory Structure

```
src/
  features/
    read-before-write/
      hooks/
        record-at-mention.ts
        record-read.ts
        enforce-read-before-write.ts
        wipe-agent.ts
        wipe-session.ts
      lib/
        cache.ts
        matching.ts
        staleness.ts
      hooks.fragment.json
    block-nessy-cli/
      hooks/
        block-nessy-cli.ts
      hooks.fragment.json
    block-nessy-dir-writes/
      hooks/
        block-nessy-dir-writes.ts
      lib/
        guards.ts
      hooks.fragment.json
  shared/
    config.ts
    log.ts
    paths.ts
    payload.ts
    run-hook.ts
  cli/
    index.ts
    init.ts
    remove.ts
    main.ts

tests/
  features/
    read-before-write/
      record-at-mention.test.ts
      record-read.test.ts
      enforce-read-before-write.test.ts
      wipe-agent.test.ts
      wipe-session.test.ts
      cache.test.ts
      matching.test.ts
      staleness.test.ts
    block-nessy-cli/
      block-nessy-cli.test.ts
    block-nessy-dir-writes/
      block-nessy-dir-writes.test.ts
      guards.test.ts
  shared/
    config.test.ts
    log.test.ts
    paths.test.ts
    payload.test.ts
    run-hook.test.ts
  cli/
    init.test.ts
    remove.test.ts
  _support/
    buildFakeProject.ts
    runHook.ts

hooks/
  hooks.json            # generated — see docs/adr/0001-hooks-json-generation.md

dist/                   # mirrors src/ — committed, do not edit manually
  features/
    read-before-write/
      hooks/  lib/
    block-nessy-cli/
      hooks/
    block-nessy-dir-writes/
      hooks/  lib/
  shared/
  cli/
```

## Feature Classification

| Feature | Hooks | Private lib |
|---|---|---|
| `read-before-write` | record-at-mention, record-read, enforce-read-before-write, wipe-agent, wipe-session | cache, matching, staleness |
| `block-nessy-cli` | block-nessy-cli | — |
| `block-nessy-dir-writes` | block-nessy-dir-writes | guards |

Shared infrastructure (used by all features): config, log, paths, payload, run-hook.

## Import Aliases

The existing `src/*` → `./src/*` path alias covers the new layout without changes to `tsconfig.json` or `vitest.config.ts`. Import strings change in three ways:

- `src/lib/foo.js` → `src/shared/foo.js` (shared infrastructure)
- `src/lib/cache.js` → `src/features/read-before-write/lib/cache.js` (feature-private lib)
- Cross-feature imports: not needed today; introduce only when a concrete case arises

`tsc-alias` rewrites all `src/` prefixes to relative paths at build time, so the deeper paths work without additional config.

## Fragment Merge

Each feature owns a `hooks.fragment.json` that declares its hook registrations using the mirrored `dist/` paths:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/features/read-before-write/hooks/enforce-read-before-write.js" }]
      }
    ]
  }
}
```

A script at `scripts/merge-hooks.mjs` globs `src/features/*/hooks.fragment.json`, merges arrays per hook event key (alphabetical feature order for determinism), and writes `hooks/hooks.json`. It runs as the final step of `npm run build`:

```
"build": "tsc && tsc-alias && node scripts/merge-hooks.mjs"
```

`hooks/hooks.json` carries a generated-file header. The fragments are the source of truth. See `docs/adr/0001-hooks-json-generation.md`.

## dist/ Output

`tsc` with `outDir: "dist"` already produces a layout that mirrors `src/`. After the source move, hook entry points compile to `dist/features/<feature>/hooks/<name>.js` with no tsconfig changes. `dist/` remains committed so users can install the plugin without a build step.

## Testing

Test files mirror the source layout. `runHook` in `tests/_support/runHook.ts` currently resolves `dist/hooks/<name>.js` from a bare hook name. The `scriptName` parameter becomes a path relative to `dist/` without the `.js` extension (e.g. `"features/read-before-write/hooks/record-read"`). The resolve line changes from `join(repo, "dist", "hooks", scriptName + ".js")` to `join(repo, "dist", scriptName + ".js")`. All call sites in `tests/features/` update accordingly. `buildFakeProject` needs no changes.

## Deliverables

1. Move all source files to the new layout and update import strings.
2. Move all test files to mirror the new layout.
3. Write `scripts/merge-hooks.ts` and update `package.json` build script.
4. Update `tests/_support/runHook.ts` to accept the new path format and update all call sites.
5. Write ADR at `docs/adr/0001-hooks-json-generation.md`.
6. Rebuild `dist/` and verify all tests pass.
