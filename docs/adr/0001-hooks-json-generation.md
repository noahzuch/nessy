# ADR 0001: hooks.json is generated from per-feature fragments

## Status
Accepted — 2026-06-23

## Context
Claude Code loads hook registrations from a single `hooks.json` file. Nessy has multiple independent features, each contributing their own hooks. To keep each feature's code cohesive — hooks, private lib, and registration living together — we need each feature to own its registration entries while still producing the single file Claude Code expects.

## Decision
Each feature under `src/features/` owns a `hooks.fragment.json` that declares its hook registrations, referencing `dist/features/<feature>/hooks/<name>.js` paths. A build script (`scripts/merge-hooks.mjs`) reads all fragments in alphabetical feature order, merges the hook-event arrays, and writes `hooks/hooks.json`.

`hooks/hooks.json` is **generated output — never edit it directly**. It is committed so users can install the plugin without a build step.

## Adding a new feature

1. Create `src/features/<feature-name>/hooks.fragment.json` with the feature's registrations.
2. Run `npm run build` — the merge step regenerates `hooks/hooks.json`.
3. Commit the fragment, the new source files, and the updated `hooks/hooks.json`.

## Fragment format

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<ToolMatcher>",
        "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/features/<feature>/hooks/<name>.js" }]
      }
    ]
  }
}
```

Omit `matcher` for lifecycle events (e.g. `SessionEnd`, `PreCompact`) that apply to all tools.

## Merge order
Features are merged in alphabetical directory name order. This is deterministic and easy to verify. Entries within the same event type are appended in that order.

## Consequences
- Adding or removing a feature is a local change inside `src/features/<feature>/`.
- `hooks/hooks.json` diffs show the merged output; reviewers should check the relevant fragment, not the generated file.
