# Nessy

Nessy is a Claude Code plugin that implements a development workflow harness.

## Features

### Read-before-write enforcement

Nessy tracks which files Claude has read in a session and blocks writes to files whose required context hasn't been loaded yet. You define rules in `.nessy/config.yml`:

```yaml
version: 1
hints: true
rules:
  - name: source
    match: ["src/**", "!src/generated/**"]
    require:
      - docs/standards/coding.md

  - name: tests
    match: "tests/**"
    require:
      - docs/standards/testing.md
      - docs/standards/coding.md
```

When Claude tries to `Write` or `Edit` a matched file without having read the required files first, the write is blocked with an explanation. When Claude reads a matched file, Nessy proactively hints which files to load before writing.

Rules are **per-agent**: each Claude subagent tracks its own reads independently. Reads in a subagent do not satisfy requirements in the parent session.

## Installation

```
/plugin marketplace add <git-url-of-this-repo>
/plugin install nessy@nessy-marketplace
```

To update later:

```
/plugin marketplace update
```

## First steps

### 1. Enable Nessy in a project

Run the following slash command from inside your project:

```
/nessy:init
```

This creates `.nessy/config.yml` in the current directory with commented-out example rules. Commit it to version control so the whole team shares the same enforcement rules.

### 2. Define rules

Edit `.nessy/config.yml` and add rules. Each rule has:

- `name` — a unique identifier shown in block messages
- `match` — a glob or list of globs (supports `!` negation) for files Claude may write
- `require` — files Claude must have read before writing any matched file

### 3. Remove Nessy from a project

```
/nessy:remove
```

This deletes `.nessy/` from the current directory. The plugin itself stays installed.

## How it works

Nessy registers five hooks that run automatically:

| Event | Hook | What it does |
|---|---|---|
| `PostToolUse` (Read) | `record-read` | Records the file and its mtime in a per-agent cache |
| `UserPromptSubmit` | `record-at-mention` | Treats `@file` mentions in prompts as reads |
| `PreToolUse` (Write/Edit) | `check-reads` | Blocks the write if required reads are missing or stale |
| `PreToolUse` (Bash) | `block-nessy-cli` | Prevents Claude from running `nessy` CLI commands (user-only) |
| `PreCompact` | `wipe-agent` | Clears the agent's read cache when context is compacted |
| `SessionEnd` | `wipe-session` | Clears all agent caches for the session |

The cache lives in `.nessy/cache/` and is never committed — add it to `.gitignore` if it shows up.

## Development

**Prerequisites:** Node ≥ 20. The repo uses [mise](https://mise.jdx.dev/) to pin Node 22 — run `mise install` once from the repo root.

```bash
npm install      # install dependencies
npm test         # run the test suite
npm run build    # compile TypeScript → dist/
npm run lint     # type-check without emitting
```

`dist/` is committed so Claude Code can load the plugin without a separate build step on the user's machine.

Path aliases: `src/` and `tests/` are configured as import aliases in both `vitest.config.ts` (runtime) and `tsconfig.json` (editor). Use `tsconfig.test.json` as your IDE's project for test files — it covers both `src/` and `tests/` without `rootDir` restrictions.
