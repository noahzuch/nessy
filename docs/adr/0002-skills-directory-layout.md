# ADR 0002: Skills Directory Layout

**Status:** Accepted — 2026-06-24

## Context

Nessy is a Claude Code plugin. Claude Code auto-discovers skills from a top-level `skills/` directory at the plugin root; all `.md` files found there (including in subdirectories) are registered and invokable as `nessy:<skill-name>` or `nessy:<subdir>/<skill-name>`.

As Nessy gains skills, a placement decision is needed: co-locate skill files inside `src/features/<feature>/` alongside the TypeScript implementation, or keep them in a dedicated top-level `skills/` directory.

## Decision

Skills live in a top-level `skills/` directory, organized with one subdirectory per feature:

```
skills/
  read-before-write/
    <skill-name>.md
  block-nessy-cli/
    <skill-name>.md
  block-nessy-dir-writes/
    <skill-name>.md
```

## Consequences

**Adding a feature's skills:** create `skills/<feature>/` and add `.md` files there. No plugin.json changes required — Claude Code discovers them automatically.

**Invocation:** skills are available as `nessy:<feature>/<skill-name>` (e.g. `nessy:read-before-write/enforce-rules`).

**Why not inside `src/features/`:** `src/` contains TypeScript compiled to `dist/`; skill files are prose that is never compiled. Mixing them in `src/` would require either excluding them from the TypeScript build or adding a copy step. The top-level `skills/` directory is also Claude Code's discovery root — placing skills elsewhere would require explicit registration in `plugin.json`.

**Feature cohesion:** the subdirectory structure (`skills/<feature>/` mirrors `src/features/<feature>/`) preserves the signal that skills and hooks belong to the same feature, without co-locating files of fundamentally different kinds.
