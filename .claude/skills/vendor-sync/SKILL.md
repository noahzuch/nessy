---
name: vendor-sync
description: >
  Vendor a subdirectory of an upstream git repository into this project and keep it reconciled
  with upstream. Upstream changes arrive as a genuine git conflict state the scripts prepare; the
  user resolves and reviews it in their own merge tool, and the skill commits the result.
argument-hint: "add|sync|remove|list [args]"
disable-model-invocation: true
---

# vendor-sync

## What this is
A vendored directory is a copy of one upstream directory, kept in this project and modified locally.
Its `.vendor.json` records the upstream repository, branch, path and the commit it was last
reconciled against.
- `add` vendors an upstream directory into this project.
- `sync` brings a vendored directory up to date with its upstream branch.
- `remove` drops the connection and keeps the files.
- `list` reports every vendored directory and where it stands.

## Who does what
- You gather input, run one script per step, relay each script's object and the fixed blocks, and
  conduct the resolve dialogue.
- The scripts do every git operation, every write of the vendored directory, the stored base and
  `.vendor.json`, and the commit that finishes an action.
- The user resolves conflicts in their IDE, `git mergetool`, or an editor.
A fact that is not in a script's object is not available to you; do not find it out another way.

## Argument gate
Accepted forms:
```
add <repo> <path> <dir> [--ref <branch>] [--sha <commit>]
add <dir> --abort
sync <dir> [--base-from-pin | --without-base]
sync <dir> --abort
remove <dir>
list
```
The user never types `--continue`; the action files run it. Pass `--abort`, `--base-from-pin` and
`--without-base` only when the user chose the matching option. Proceed only when the user named the
action (`add`, `sync`, `remove` or `list`) and every required parameter is held. Never infer the
action from the other arguments, even when they fit only one form: when the action is not named, ask
which one and run nothing until the user answers.

## Script contract
Run scripts from this skill's directory as `node scripts/vendor-<action>.mjs …`. Each run prints one
JSON object and exits:
- 0 — read `state` and follow its entry under **Outcomes** in the action file.
- 1 — the input was wrong or incomplete. Correct it and re-run; when the wrong value was the user's,
  ask them, showing `error.data`. When `error.data.choices` is present, the action file names the
  block to print.
- 2 — stop. Report `error.message` verbatim, and `error.hint` verbatim when present, and do
  nothing further.
Quote stderr verbatim beneath the report only when there is any. Never mention that a hint or
stderr is absent.

An action needs nothing staged outside the vendored directory: a start refuses staged changes
elsewhere (exit 2), and `--continue` refuses them (exit 1) until the user commits or unstages them.

## Boundaries
- Resume or abort an action this session did not start only on the user's choice from the
  open-action block.
- Never run git. Never edit `.vendor.json`.
- Never commit yourself. `--continue` commits, and you run it only on the user's word that they are finished.
- While an action is open, never edit, stage, resolve or delete a file in the vendored directory.
- Never touch any file under `.vendor-sync/`.

## Dispatch
Read `<action>.md` in this directory and follow it. It ends where you are finished.
