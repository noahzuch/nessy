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

**Prerequisites:** Node 22 via [mise](https://mise.jdx.dev/). Once mise is installed, run `mise install` from the repo root. If your shell has mise activation hooks loaded, `npm`/`node` work directly; otherwise prefix with `mise exec --`.

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
