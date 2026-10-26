# vendor-sync

> **Decision Journal:** Rationale, rejected alternatives, and implicit knowledge
> are documented in `decisions.md` (same directory).
> On ambiguity: **check there FIRST** before choosing your own interpretation.

<!-- FACT-CHECK annotations: `decisions.md:N` points at the journal entry starting on line N;
     `<script>:N` points at `.claude/skills/vendor-sync/scripts/<script>` in the repository. -->

## Goal

<!-- FACT-CHECK: True. decisions.md:46 (D-1), decisions.md:156 (D-7), decisions.md:497 (D-35), SKILL.md:15-17 (a copy of one upstream subdirectory, kept and modified locally) -->
vendor-sync copies one subdirectory of an upstream git repository into a project and keeps that copy reconciled with upstream while it carries local modifications.
<!-- FACT-CHECK: True. decisions.md:92 (D-2), decisions.md:415 (D-30), decisions.md:678 (D-45) -->
Reconciling is git's own three-way merge: the scripts put the vendored directory into a genuine git conflict state, the user resolves and reviews it in the merge tool they already use, and a final script call commits the result.
<!-- FACT-CHECK: True. decisions.md:156 (D-7: no summaries, no grouping), decisions.md:201 (D-13: never edit, stage or resolve a file during a merge), decisions.md:744 (D-58) -->
The agent that drives the skill gathers input, runs one script per step and relays the script's output and a few fixed text blocks; it never summarizes or groups upstream's changes and never touches a file in the vendored directory while an action is open.

## Context

<!-- FACT-CHECK: True. decisions.md:36 (F-5) -->
A vendored copy drifts: upstream keeps changing, and the project changes its copy too. Bringing the copy up to date must show the user every conflict in a familiar visual tool, must be fast when most changes merge cleanly, and must make it observable that the result is right.
<!-- FACT-CHECK: True. decisions.md:84 (F-20), decisions.md:70 (F-18), decisions.md:261 (D-18 (4): "any IDE with proper git integration is expected to handle it") -->
IntelliJ lists unmerged index entries as merge conflicts with no launcher, `git mergetool` works on the same state, and any IDE with proper git integration is expected to do the same, so a conflict state written into the repository's own index is a review surface that needs no IDE-specific code.

Fixed constraints:

<!-- FACT-CHECK: True. decisions.md:415 (D-30, "Known costs"), decisions.md:711 (D-49 (3)), decisions.md:802 (D-64: git 2.40), git.mjs:14-15 (MIN_GIT_VERSION) -->
- git 2.40 or newer: the merge uses `git merge-tree --write-tree --merge-base`, which older git lacks.
<!-- FACT-CHECK: True. CLAUDE.md:48 ("its scripts are .mjs run directly, no build step"), decisions.md:552 (F-76, "The scripts are dependency-free `.mjs`"), decisions.md:415 (D-30: the scratch extraction via git archive and tar is deleted), decisions.md:641 (D-42: git writes the files) -->
- The scripts are dependency-free Node `.mjs` files run directly with `node`, with no build step; git is the only external program.
<!-- FACT-CHECK: True. lib.mjs:429-450 (fetchTracking, listRemoteBranches), vendor-add.mjs:76-88 (fetchBranch), decisions.md:530 (F-73: pushing is an outward-facing write the design never does) -->
- Network access is `git fetch` of the tracked branch, plus `git ls-remote --heads` when `add` names a branch the remote lacks, to list the branches it has; nothing is ever pushed.
<!-- FACT-CHECK: True. decisions.md:42 (F-8), SKILL.md:21-28 (current skill text, "The scripts do every git operation") -->
- Only the scripts run git and write `.vendor.json`; the agent never does.
<!-- FACT-CHECK: True. decisions.md:618 (F-88), decisions.md:544 (D-39) -->
- Pull requests in a consuming repository may be squash- or rebase-landed, so nothing the merge needs may depend on commit ancestry surviving a landing.
<!-- FACT-CHECK: True. decisions.md:605 (F-84), decisions.md:678 (D-45, "Rejected keeping it with the user") -->
- IntelliJ's commit window ignores git's staging area and commits only the files the user ticks, so a script cannot rely on the user committing every file it staged.

## Design

### Overview

<!-- FACT-CHECK: True. decisions.md:737 (D-57, module split), SKILL.md:84-86 (Dispatch: the agent reads `<action>.md`) -->
The skill is four building blocks stacked on top of each other. Each one calls only the block beneath it.

<!-- FACT-CHECK: True. decisions.md:737 (D-57), decisions.md:156 (D-7) -->
| Block | What it is | What it does |
|---|---|---|
| Skill text | `SKILL.md` and one action file per action | Tells the agent which script to run, how to read its output, and which fixed text to print |
| Entry scripts | `scripts/vendor-add.mjs`, `vendor-sync.mjs`, `vendor-remove.mjs`, `vendor-list.mjs` | One command-line program per action; parses arguments, runs the action's steps, prints one JSON object |
| Library modules | `scripts/merge.mjs`, `connection.mjs`, `git.mjs`, `contract.mjs` | Everything the entry scripts share: the merge, the connection's files on disk, git, the output contract |
| Git and the file system | the repository's index, objects, refs, and the files described in [Persistent state](#persistent-state) | Holds all state between script runs |

<!-- FACT-CHECK: True. decisions.md:730 (D-55), decisions.md:737 (D-57) -->
The diagram [`diagrams/overview.html`](diagrams/overview.html) shows the blocks and who calls whom.

Terms used throughout:

<!-- FACT-CHECK: True. SKILL.md:13-19 (current definition of a vendored directory and `.vendor.json`) -->
- **Connection** — the link between one vendored directory (`<dir>`, relative to the repository root) and one upstream directory: a repository (`repo`), a branch (`ref`) and a path inside it (`path`). It is recorded in `<dir>/.vendor.json`.
<!-- FACT-CHECK: True. lib.mjs:153-160 (deriveSlug), vendor-add.mjs:109-124 (requireSlugUnused), decisions.md:667 (D-44: base/<slug> and scratch/<slug>) -->
- **Slug** — the connection's name, derived from `<dir>`; it names the connection's ref and its folders under `.vendor-sync/`.
<!-- FACT-CHECK: True. SKILL.md:15-17 ("the upstream commit it was last reconciled against") -->
- **Pinned commit** — the upstream commit the vendored directory was last reconciled against (`sha` in the manifest).
<!-- FACT-CHECK: True. lib.mjs:224-232 (marker field `target_sha`) -->
- **Target commit** — the upstream commit an open action reconciles towards: the branch's tip for `sync`, the pinned commit for `add`.
<!-- FACT-CHECK: True. decisions.md:544 (D-39), decisions.md:667 (D-44) -->
- **Stored base** — upstream's directory at the pinned commit, committed in the project under `.vendor-sync/base/<slug>/`; the base of the next three-way merge.
<!-- FACT-CHECK: True. lib.mjs:224-232 (marker), decisions.md:331 (D-24) -->
- **Open action** — an `add` or `sync` whose start has run but whose `--continue` or `--abort` has not; recorded by the marker in the manifest.
<!-- FACT-CHECK: True. connection.mjs:198-207 (identityOf) -->
- **Identity fields** — `dir`, `slug`, `repo`, `path` and `ref`: every object `add` and `sync` return carries them; the `remove` and `list` objects carry the subset their tables show.

### Persistent state

<!-- FACT-CHECK: True. lib.mjs:1-6 (scripts state facts and write files), decisions.md:322 (F-44: every input `--continue` needs lives on disk) -->
Besides git's index and object store, everything that outlives one script run lives in four places. No script keeps state in memory between runs, and no agent conversation is needed to continue an action: a later session can resume or abort it from what is on disk.

<!-- FACT-CHECK: True. decisions.md:737 (D-57), decisions.md:678 (D-45), decisions.md:667 (D-44) -->
| State | Location | Written by | Committed |
|---|---|---|---|
| Manifest | `<dir>/.vendor.json` | every start that opens an action, `--continue`, `--abort` | yes, by `--continue` |
| Stored base | `.vendor-sync/base/<slug>/`, `.vendor-sync/.gitignore`, `.vendor-sync/.gitattributes` | `--continue` only | yes, by `--continue` |
| Scratch | `.vendor-sync/scratch/<slug>/` | a start that writes merge state | never (ignored) |
| Refs | `refs/vendor/<slug>`; `refs/vendor-base`, `refs/vendor-local`, `refs/vendor-upstream` | every fetch; one merge call | never (refs are not files) |

#### The manifest

<!-- FACT-CHECK: True. lib.mjs:37-38 (MANIFEST_NAME, MANIFEST_FIELDS), decisions.md:737 (D-57: field `base_tree`) -->
`<dir>/.vendor.json` identifies the connection and records where it stands. It is a JSON object with exactly seven fields.

<!-- FACT-CHECK: True. lib.mjs:239-275 (parseManifest: required non-blank strings, marker validation), lib.mjs:224-232 (isValidMarker), lib.mjs:154-160 (slug alphabet), decisions.md:737 (D-57: `base_tree`) -->
<!-- FACT-CHECK: True. decisions.md:744 (D-58): no extra properties, non-blank strings, 40-hex patterns, per-action state enums -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "vendor-sync manifest (.vendor.json)",
  "type": "object",
  "additionalProperties": false,
  "required": ["slug", "repo", "path", "ref", "sha", "base_tree", "in_progress"],
  "properties": {
    "slug":      { "type": "string", "pattern": "^[A-Za-z0-9_][A-Za-z0-9_-]*$",
                   "description": "Connection name, derived from <dir>" },
    "repo":      { "type": "string", "pattern": "\\S",
                   "description": "Upstream repository: a URL or an absolute local path" },
    "path":      { "type": "string", "pattern": "\\S",
                   "description": "Upstream directory, relative to the upstream repository root" },
    "ref":       { "type": "string", "pattern": "\\S",
                   "description": "Tracked upstream branch" },
    "sha":       { "type": "string", "pattern": "^[0-9a-f]{40}$",
                   "description": "Pinned commit" },
    "base_tree": { "type": "string", "pattern": "^[0-9a-f]{40}$",
                   "description": "Tree oid of upstream's directory at the pinned commit, a root .vendor.json removed; equals the committed stored base" },
    "in_progress": {
      "oneOf": [
        { "type": "null" },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["action", "state", "target_sha"],
          "properties": {
            "action":     { "enum": ["add", "sync"] },
            "state":      { "type": "string" },
            "target_sha": { "type": "string", "pattern": "^[0-9a-f]{40}$" }
          },
          "allOf": [
            { "if": { "properties": { "action": { "const": "add" } } },
              "then": { "properties": { "state": { "enum": ["ready", "merging", "merge_staged"] } } } },
            { "if": { "properties": { "action": { "const": "sync" } } },
              "then": { "properties": { "state": { "enum": ["pin_ready", "merging", "merge_staged"] } } } }
          ]
        }
      ]
    }
  }
}
```

Example — a connection with an open sync:

```json
{
  "slug": "skills-demo",
  "repo": "https://github.com/example/upstream",
  "path": "plugins/demo/skills/demo",
  "ref": "main",
  "sha": "9570870d5c94ccda6c694c0ce55b1b80a2e358e7",
  "base_tree": "4f1c2a9e0d3b7c6a5e8f9d0c1b2a3e4f5d6c7b8a",
  "in_progress": {
    "action": "sync",
    "state": "merge_staged",
    "target_sha": "6690958dfb864f61e01f7e56c9478426b02bb380"
  }
}
```

<!-- FACT-CHECK: True. connection.mjs:121-130 (serializeManifest: field order, two-space indent, trailing newline), connection.mjs:147-185 (parseManifest), decisions.md:744 (D-58) (position of base_tree), decisions.md:806 (D-64: the manifest is its schema) -->
The scripts always write the fields in the schema's `required` order, with two-space indentation and a trailing newline. They read a manifest by the same schema: one that breaks it — a missing or extra field, a `slug`, `sha` or `base_tree` outside its pattern, an invalid marker — fails exit 2 (see `parseManifest` under [connection.mjs](#connectionmjs)).

<!-- FACT-CHECK: True. decisions.md:544 (D-39, "manifest.sha stays as the connection's identity"), decisions.md:542 (F-75: the stored base round-trips to the identical tree oid) -->
`sha` is the connection's identity towards upstream. `base_tree` is the oid of upstream's directory at the pinned commit with a root `.vendor.json` removed — the tree `git rev-parse <sha>:<path>` returns whenever upstream has no such file. The stored base is written from exactly that tree and has the same oid when committed, so comparing the two oids proves the committed stored base is intact.

<!-- FACT-CHECK: True. decisions.md:780 (D-61), vendor-sync.mjs:97-102 (sync marker written last), vendor-add.mjs:161-170 (add marker), decisions.md:331 (D-24) -->
`in_progress` is `null` while no action is open. A start that writes nothing into `<dir>` (`pin_ready`) sets the marker as its last write, so a start that fails earlier leaves no open action. A start that writes into `<dir>` — a merge, or an add's `ready` start — opens the action with state `merging` as soon as its plan exists, before any file in `<dir>` changes, and switches it to `merge_staged` (or `ready`) as its last write; a start interrupted in between therefore leaves an open action that `--abort` can undo. The marker's states are:

<!-- FACT-CHECK: True. vendor-add.mjs:172-187 (`ready`), vendor-sync.mjs:144-151 (`pin_ready`), vendor-sync.mjs:164-186 (`merge_staged`), decisions.md:780 (D-61) (`merging`) -->
| `action` | `state` | Meaning |
|---|---|---|
| `add` | `ready` | `<dir>` was empty or absent (see [add](#add)); upstream's files are written and staged |
| `add` | `merging` | a start began writing `<dir>` and did not finish |
| `add` | `merge_staged` | `<dir>` held committed content; the merge state is written |
| `sync` | `pin_ready` | upstream moved, but its directory is identical at both commits; nothing but the marker has been written |
| `sync` | `merging` | a merge start began writing `<dir>` and did not finish |
| `sync` | `merge_staged` | the merge state is written |

#### The stored base

<!-- FACT-CHECK: True. decisions.md:544 (D-39), decisions.md:659 (D-43), decisions.md:667 (D-44), decisions.md:618 (F-88), decisions.md:624 (D-40) -->
`.vendor-sync/base/<slug>/` holds upstream's directory at the pinned commit as ordinary committed files. It is the base of the next three-way merge, and because it is part of the project's own commits, every clone, branch and CI checkout carries it, however pull requests are landed.

<!-- FACT-CHECK: True. decisions.md:665 (F-93), decisions.md:667 (D-44) -->
```
.vendor-sync/
  .gitignore         /scratch/
  .gitattributes     base/** -diff -merge linguist-generated
  base/
    <slug>/          upstream's directory at the pinned commit, file for file
  scratch/           ignored; see Scratch and the plan
```

<!-- FACT-CHECK: True. decisions.md:665 (F-93), decisions.md:559 (F-77) -->
- `.gitignore` keeps scratch out of git while the base is tracked.
<!-- FACT-CHECK: True. decisions.md:559 (F-77: -diff), decisions.md:665 (F-93: check-attr), decisions.md:739 (F-94: -merge in a branch merge), decisions.md:674 (Q-14: nested linguist-generated unverified) -->
- `.gitattributes` makes git show a changed base file as a one-line `Binary files … differ` instead of a full diff (`-diff`); turns a branch merge that changed a base file on both sides into a conflict that keeps the current branch's version, instead of merging the text (`-merge`); and asks hosting tools to collapse the files as generated (`linguist-generated` — that GitHub honors it from a nested `.gitattributes` is assumed, not verified).
<!-- FACT-CHECK: True. decisions.md:667 (D-44: "Both files are committed and live inside the tool's own folder") -->
- Both dotfiles are committed. They live inside `.vendor-sync/`, so the scripts never write the project's own root `.gitignore` or `.gitattributes`.
<!-- FACT-CHECK: True. decisions.md:552 (F-76: blob sharing), decisions.md:559 (F-77: one object for identical content) -->
- A base file identical to its vendored counterpart is the same git object, so it costs no extra storage.

<!-- FACT-CHECK: True. decisions.md:678 (D-45), decisions.md:733 (D-56: base written fresh from the target), decisions.md:641 (D-42: git writes from the object store) -->
Only `--continue` writes the stored base, and always from the target commit, in the same commit as the merge result and the manifest. git writes every file from its object store, so modes and symlinks are exact.

<!-- FACT-CHECK: True. decisions.md:689 (D-46) -->
The integrity check compares `base_tree` with `git rev-parse HEAD:.vendor-sync/base/<slug>`. It reads the committed tree, never the files on disk: a correct base that was never committed would pass a disk check while every teammate's clone lacks it.

#### Scratch and the plan

<!-- FACT-CHECK: True. decisions.md:667 (D-44: scratch at `.vendor-sync/scratch/<slug>/`), lib.mjs:787-810 (scratchDir, ensureScratch), decisions.md:278 (D-21), decisions.md:415 (D-30: base/ and upstream/ extraction deleted), decisions.md:641 (D-42), decisions.md:763 (D-59): self-ignoring scratch -->
`.vendor-sync/scratch/<slug>/` holds per-action working files that must survive between the start and `--continue` or `--abort` but are never committed. It holds `plan.json`, written by a start that writes merge state, and a `.gitignore` of `*` that keeps scratch out of git even before `.vendor-sync/.gitignore` has ever been committed. The whole folder is deleted when the action closes.

<!-- FACT-CHECK: True. decisions.md:278 (D-21: plan holds base, target and per-file local_oid), decisions.md:355 (D-27: local_oid as created-vs-existing discriminator), decisions.md:375 (F-52: the abort splits planned paths by local_oid) -->
<!-- FACT-CHECK: True. decisions.md:744 (D-58): `action` and `touched`; merge-state.mjs:31-32 (PLAN_VERSION 1); decisions.md:506 (F-67: the `<name>~<label>` collision file) -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "vendor-sync merge plan (plan.json)",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "action", "base", "target", "touched"],
  "properties": {
    "version": { "const": 1 },
    "action":  { "enum": ["add", "sync"] },
    "base":    { "type": ["string", "null"], "pattern": "^[0-9a-f]{40}$",
                 "description": "Commit whose directory is the merge base; null for a merge without a base" },
    "target":  { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "touched": {
      "description": "Every path under <dir> the merge wrote; drives --abort",
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["path", "local_oid"],
        "properties": {
          "path":      { "type": "string" },
          "local_oid": { "type": ["string", "null"] }
        }
      }
    }
  }
}
```

Example:

```json
{
  "version": 1,
  "action": "sync",
  "base": "9570870d5c94ccda6c694c0ce55b1b80a2e358e7",
  "target": "6690958dfb864f61e01f7e56c9478426b02bb380",
  "touched": [
    { "path": "a.md", "local_oid": "25c30b64b8abaaf5c4fc329673bb25557770d5a9" },
    { "path": "new.md", "local_oid": null }
  ]
}
```

<!-- FACT-CHECK: True. decisions.md:355 (D-27), decisions.md:375 (F-52) -->
- `touched` lists every path the merge wrote. `--abort` restores the paths with a `local_oid` from `HEAD` and deletes the ones without.
<!-- FACT-CHECK: True. decisions.md:322 (F-44: "every non-null local_oid is also HEAD's blob for that path, because the start requires a clean directory") -->
- Every non-null `local_oid` is also `HEAD`'s blob for that path, because a start requires a clean directory. The pre-merge content therefore stays reachable however long the action stays open.

#### Refs

<!-- FACT-CHECK: True. lib.mjs:397-399 (trackingRef), lib.mjs:429-437 (fetchTracking refspec) -->
- `refs/vendor/<slug>` — the tracking ref. Every fetch force-updates it to the branch's tip with `+refs/heads/<ref>:refs/vendor/<slug>`; it gives the scripts a name for upstream's commits without touching the project's branches.
<!-- FACT-CHECK: True. decisions.md:493 (D-34), decisions.md:516 (D-38), decisions.md:719 (D-50) -->
- `refs/vendor-base`, `refs/vendor-local`, `refs/vendor-upstream` — the three temporary merge refs. They exist only during the one `git merge-tree` call of a start (see [The merge](#the-merge)), are created right before it and deleted right after it on every exit path, and a stale one from a crashed run is overwritten.

<!-- FACT-CHECK: True. decisions.md:491 (F-66), decisions.md:510 (D-37 rationale on labels), decisions.md:514 (F-68), decisions.md:516 (D-38) -->
The temporary refs exist for the conflict markers: `merge-tree` labels each side with the name it was given, so the markers read `<<<<<<< vendor-local`, `||||||| vendor-base` and `>>>>>>> vendor-upstream`. They are plain refs, never branches: git resolves the short name all the same, while a branch would invite a checkout that deletes every file outside the vendored directory (D-38).

<!-- FACT-CHECK: True. decisions.md:536 (F-74: the merge base always comes from the manifest, no other ref is read), decisions.md:544 (D-39: the base ref is removed entirely) -->
No other ref is created. In particular, nothing keeps old upstream commits alive: the stored base makes the merge independent of upstream's history.

### Script layer

<!-- FACT-CHECK: True. SKILL.md:51-52 (scripts live in `scripts/`, run as `node scripts/vendor-<action>.mjs` from the skill directory), lib.mjs:384-391 (repoRoot from cwd), CLAUDE.md:48 (project-local skill under .claude/skills/) -->
The four entry scripts live in `scripts/` of the skill's directory and are run from that directory as `node scripts/vendor-<action>.mjs …`. They find the repository from their working directory with `git rev-parse --show-toplevel`; the skill directory lies inside the project, so that finds the project's root.

#### The script contract

<!-- FACT-CHECK: True. lib.mjs:1-6, lib.mjs:62-100 (emit, run), SKILL.md:49-63 -->
Every run prints exactly one JSON object to stdout, pretty-printed with two-space indentation, and exits with one of three codes:

<!-- FACT-CHECK: True. lib.mjs:26 (EXIT), SKILL.md:55-61 -->
| Exit | Meaning | Object |
|---|---|---|
| 0 | the script ran | has `state`, naming what happened; the rest of the object depends on the state |
| 1 | the input was wrong or incomplete; correct it and re-run | `{ "error": { "message", "hint"?, "data"? } }` |
| 2 | stop; the recourse is the user's | `{ "error": { "message", "hint"? } }` |

<!-- FACT-CHECK: True. lib.mjs:67-100 (run), SKILL.md:55-63 -->
- `error.message` says what is wrong, naming the paths and commits involved.
- `error.hint` is information for the user: what the situation is and what would resolve it. It is never an instruction for the agent.
- `error.data` carries what the caller needs to correct the input: a branch list, a directory listing, the unresolved paths, or a list of `choices`.
<!-- FACT-CHECK: True. lib.mjs:83-86 (gitStderr to stderr), SKILL.md:63 -->
- stderr carries git's own output and nothing else, written when a git command behind the failure produced any.

<!-- FACT-CHECK: True. lib.mjs:73-77 (process.exitCode, not process.exit), decisions.md:763 (D-59): carried over -->
The exit code is set through `process.exitCode`, never `process.exit()`, because exiting right after printing can truncate a large object on a macOS pipe.

#### Action lifecycle

<!-- FACT-CHECK: True. decisions.md:178 (D-9: two-call flow), decisions.md:678 (D-45: --continue commits), decisions.md:355 (D-27: --abort restores) -->
`add` and `sync` are two-call actions. The **start** assesses the situation and, where a change is needed, writes the decision surface and opens the action. Between the calls the user brings the directory to the state they want. **`--continue`** records that state as one commit and closes the action; **`--abort`** discards it and closes the action. `remove` and `list` are single calls. The diagram [`diagrams/lifecycle.html`](diagrams/lifecycle.html) shows the states and transitions.

<!-- FACT-CHECK: True. decisions.md:331 (D-24), decisions.md:350 (D-26), decisions.md:335 (D-25) -->
A start that finds an open action exits 1 with `error.data.choices`, and the agent asks the user to pick one:

<!-- FACT-CHECK: True. decisions.md:350 (D-26), decisions.md:780 (D-61) -->
| Open action | Starting | `choices` |
|---|---|---|
| same action | `add` on an open `add`, `sync` on an open `sync` | `["resume", "abort", "leave"]` |
| other action | `add` on an open `sync`, or the reverse | `["abort", "leave"]` |
| an interrupted start | any start on a marker in state `merging` | `["abort", "leave"]` |

<!-- FACT-CHECK: True. decisions.md:350 (D-26: `--continue` strict, `--abort` accepts either marker), decisions.md:335 (D-25: a later session may resume or abort) -->
`resume` runs the open action's `--continue`, and is never offered for `merging`, whose merge state is incomplete; `abort` runs `--abort`, which accepts either action's marker and reads the manifest to learn which one it is discarding; `leave` changes nothing. Any later session may resume or abort, because every input either call needs is on disk.

##### The aborted object

<!-- FACT-CHECK: True. vendor-sync.mjs:260, sync.md:165-176 -->
`--abort` of either action returns the `aborted` object:

| Field | Value |
|---|---|
| `state` | `"aborted"` |
| identity fields | see [Overview](#overview) |
| `restored` | paths put back to their committed content |
| `removed` | paths the action created, now deleted |
| `left` | untracked paths under `<dir>` that no script wrote, left alone — a merge tool's backup files are the common case |

#### add

<!-- FACT-CHECK: True. vendor-add.mjs:69-74 (USAGE), vendor-add.mjs:323-368 (argv dispatch), decisions.md:497 (D-35: no --mode) -->
```
node scripts/vendor-add.mjs <repo> <path> <dir> [--ref <branch>] [--sha <commit>]
node scripts/vendor-add.mjs <dir> --continue
node scripts/vendor-add.mjs <dir> --abort
```

<!-- FACT-CHECK: True. add.md:6-19 (inputs), vendor-add.mjs:364 (`--ref` default `main`), vendor-add.mjs:90-107 (pinnedCommit) -->
| Argument | Meaning |
|---|---|
| `<repo>` | upstream repository: a URL or an absolute local path |
| `<path>` | upstream directory, relative to the upstream repository root |
| `<dir>` | destination in this project, relative to the repository root; absent, empty, or holding committed content |
| `--ref <branch>` | branch to track; default `main` |
| `--sha <commit>` | pin this commit instead of the branch's tip; must be reachable from the branch |
| `--continue` | finish the open add; takes only `<dir>` |
| `--abort` | discard the open add; takes only `<dir>` |

##### Start

<!-- FACT-CHECK: True. vendor-add.mjs:138-225 (startAdd) -->
Checks [the preconditions](#the-precondition-order), then:

<!-- FACT-CHECK: True. vendor-add.mjs:85-100 (empty, or nothing committed and clean → ready), decisions.md:808 (D-64: collision guard) -->
- If `<dir>` is absent or empty: run [the merge](#the-merge) with the empty tree as base and as local side, so it writes and stages upstream's files as they are, with git's modes and symlinks (where `core.symlinks` is `false`, git writes a symlink's target text as a plain file); it writes the manifest with marker `merging`, then `ready`. Return `ready`. Empty means no entries at all, or nothing committed under `<dir>` and a clean working tree there — only ignored files or empty folders; the merge's [collision guard](#the-collision-guard) keeps those safe.
<!-- FACT-CHECK: True. vendor-add.mjs:189-195, decisions.md:502 (D-36: empty tree as merge base) -->
- Otherwise run [the merge](#the-merge) with the empty tree as base; it writes the manifest with marker `merging`, then `merge_staged`. Return `merge_staged`.

<!-- FACT-CHECK: True. vendor-add.mjs:152-154, vendor-add.mjs:221-224 (a failed start deletes the tracking ref) -->
A start that fails after the fetch deletes the tracking ref again, so a failed add leaves no trace.

<!-- FACT-CHECK: True. vendor-add.mjs:180-186, add.md:74-86 -->
`ready` object:

| Field | Value |
|---|---|
| `state` | `"ready"` |
| identity fields | see [Overview](#overview) |
| `sha` | the commit that will be pinned |
| `files` | upstream's file paths at `sha`, relative to `<path>`, sorted: the blobs `treeEntries` lists, so without submodule entries and a root `.vendor.json` — what the start wrote and staged |
| `skipped_submodules` | the paths of upstream's submodule entries (gitlinks, mode `160000`) in `<sha>:<path>`, relative to `<path>`, byte-sorted; `[]` when there are none. They are left out of the add, so these folders stay absent |

<!-- FACT-CHECK: True. vendor-add.mjs:212-220, add.md:88-138, decisions.md:502 (D-36), decisions.md:506 (F-67: every differing file comes back both-added) -->
`merge_staged` object (add):

| Field | Value |
|---|---|
| `state` | `"merge_staged"` |
| identity fields | see [Overview](#overview) |
| `base` | always `null`: there was never a pinned commit |
| `sha` | the commit that will be pinned |
| `files` | one entry per upstream file `<dir>` lacks or holds differently: `{ path, presence }`, `presence` `both` (differing content on both sides) or `upstream` (only upstream has it); files only `<dir>` has are not listed |
| `skipped_submodules` | the paths of upstream's submodule entries (gitlinks, mode `160000`) in `<sha>:<path>`, relative to `<path>`, byte-sorted; `[]` when there are none. They are left out of the add, so these folders stay absent |
| `notes` | `["no_base"]` |

##### --continue

<!-- FACT-CHECK: True. vendor-add.mjs:176-202 (continueAdd), decisions.md:641 (D-42), decisions.md:678 (D-45), decisions.md:744 (D-58): refuses during another git operation, decisions.md:780 (D-61): refuses merging -->
Requires an open `add` marker (exit 2 otherwise) and no other git operation in progress (exit 2). A `merging` marker exits 2 with `the add on <dir> did not finish its start; discard it with --abort`. Every start wrote and staged its result, so `--continue` writes nothing into `<dir>`: whatever `<dir>` holds now is what gets committed. In `ready` and `merge_staged` alike:

<!-- FACT-CHECK: True. merge.mjs (requireResolvedPlan), vendor-add.mjs (continueAdd), decisions.md:186 (D-10), D-65 -->
- Refuse while any path under `<dir>` is unmerged — a `git stash pop` can leave one in `ready` too: exit 1, `error.message` `"<n> files in <dir> are still unmerged"`, `error.data.unresolved` the paths. Stop (exit 2) when the plan is missing or targets another commit than the marker. Then refuse while anything is staged outside the tool's paths (exit 1, see [The commit at --continue](#the-commit-at---continue)).

Then run [the commit at --continue](#the-commit-at---continue) and return `added`. A failed commit leaves the add open with its files in place, so `--continue` can run again or `--abort` can discard it.

<!-- FACT-CHECK: True. vendor-add.mjs:272-282, add.md:140-159, decisions.md:275 (D-20), decisions.md:678 (D-45), decisions.md:744 (D-58): `commit` field -->
`added` object:

| Field | Value |
|---|---|
| `state` | `"added"` |
| identity fields | see [Overview](#overview) |
| `sha` | the pinned commit |
| `commit` | the commit `--continue` made |
| `files` | the paths the commit changed under `<dir>`, `.vendor.json` aside (see [The changed files](#the-changed-files)) |

##### --abort

<!-- FACT-CHECK: True. vendor-add.mjs:285-321 (abortAdd), decisions.md:355 (D-27), decisions.md:324 (D-23 scope rules) -->
Discards the open add: in every state (`ready`, `merging`, `merge_staged`) runs [the abort restore](#the-abort-restore), deletes the manifest, removes `<dir>` if it is left empty, deletes the tracking ref and scratch. A discarded add leaves the same trace as one that never ran. Returns [the `aborted` object](#the-aborted-object).

#### sync

<!-- FACT-CHECK: True. vendor-sync.mjs:52-56 (USAGE), decisions.md:733 (D-56: `--base-from-pin`, `--without-base`) -->
```
node scripts/vendor-sync.mjs <dir> [--base-from-pin | --without-base]
node scripts/vendor-sync.mjs <dir> --continue
node scripts/vendor-sync.mjs <dir> --abort
```

<!-- FACT-CHECK: True. sync.md:6-11 (only <dir>; everything else from the manifest), decisions.md:733 (D-56), decisions.md:704 (D-48) -->
| Argument | Meaning |
|---|---|
| `<dir>` | the vendored directory; repository, branch and upstream path come from its manifest |
| `--base-from-pin` | skip the stored-base check and use upstream's directory at the pinned commit as the merge base |
| `--without-base` | skip the stored-base check and merge without a base |
| `--continue` | finish the open sync; takes only `<dir>` |
| `--abort` | discard the open action on `<dir>`; takes only `<dir>` |

<!-- FACT-CHECK: True. decisions.md:730 (D-55), decisions.md:737 (D-57: sync sequence diagram) -->
The diagram [`diagrams/sync-sequence.html`](diagrams/sync-sequence.html) shows a sync with conflicts from the first call to the commit.

<!-- FACT-CHECK: True. decisions.md:744 (D-58): mutually exclusive, matter only when the sync merges -->
`--base-from-pin` and `--without-base` exclude each other; giving both exits 1. They are passed only after the user chose the matching option of a failed base check, and they only matter when the sync merges.

##### Start

<!-- FACT-CHECK: True. vendor-sync.mjs:69-186 (startSync) -->
Checks [the preconditions](#the-precondition-order) up to the upstream directory; the tip of the fetched branch is the target commit. Then:

<!-- FACT-CHECK: True. vendor-sync.mjs:133-135 -->
- If the pinned commit is the tip: return `up_to_date`, writing nothing.
<!-- FACT-CHECK: True. vendor-sync.mjs:137-151, lib.mjs:911-919 (commitsBehind), decisions.md:271 (F-40) -->
- Count `commits_behind`, the upstream commits since the pinned commit that touched `<path>` (`git rev-list --count <sha>..<tip> -- <path>`), or `null` when the pinned commit is not an ancestor of the tip.
<!-- FACT-CHECK: True. vendor-sync.mjs:149-151 (identical trees → pin), decisions.md:733 (D-56: --continue writes the base fresh from the target), decisions.md:744 (D-58): no base check for pin_ready -->
- If upstream's directory is the same tree at both commits: write marker `pin_ready` and return `pin_ready`. No base check runs, because `--continue` rewrites the stored base anyway.
<!-- FACT-CHECK: True. decisions.md:689 (D-46), decisions.md:704 (D-48), decisions.md:733 (D-56), decisions.md:744 (D-58): --base-from-pin fails 1 without the pinned commit -->
- Choose the merge base: `base_tree` after a passed [base check](#base-check); with `--base-from-pin`, `<sha>:<path>` without the check (exit 1 if the pinned commit is not in the object store); with `--without-base`, the empty tree without the check.
<!-- FACT-CHECK: True. vendor-sync.mjs:153-162 (no listed file → pin) -->
- Describe the changes (see [The merge](#the-merge)). If no file is listed — the trees differ only in what the description ignores — continue as `pin_ready`.
<!-- FACT-CHECK: True. vendor-sync.mjs:164-185 -->
- Run [the merge](#the-merge), which writes marker `merging`, then `merge_staged`, and return `merge_staged`.

##### Base check

<!-- FACT-CHECK: True. decisions.md:689 (D-46), decisions.md:704 (D-48: without_base offered only when the pinned commit is unavailable), decisions.md:733 (D-56), decisions.md:773 (D-60): the applicable repair plus leave -->
Without a flag, a sync that will merge requires `HEAD:.vendor-sync/base/<slug>` to exist and to equal `base_tree` (see [The stored base](#the-stored-base)). A failed check exits 1 before anything is written:

| Cause | `error.message` | `error.data.choices` |
|---|---|---|
| `HEAD` has no `.vendor-sync/base/<slug>` | `the stored base for <dir> is missing from HEAD` | `["base_from_pin", "leave"]` when the pinned commit is in the object store, else `["without_base", "leave"]` |
| the committed tree differs from `base_tree` | `the stored base for <dir> does not match the pinned upstream commit <sha>` | the same |

<!-- FACT-CHECK: True. decisions.md:704 (D-48 rationale), decisions.md:733 (D-56 mechanism), decisions.md:773 (D-60) -->
`base_from_pin` is the normal repair, because upstream usually still holds the pinned commit; `without_base` covers an upstream that rewrote its history (D-48, D-56). `leave` changes nothing, so the user can fix the cause instead — commit a base that is only on disk, or redo a branch merge that took `.vendor.json` and the base from different sides — and re-run (D-60).

<!-- FACT-CHECK: True. vendor-sync.mjs:133-135, sync.md:68-75 -->
`up_to_date` object:

| Field | Value |
|---|---|
| `state` | `"up_to_date"` |
| identity fields | see [Overview](#overview) |
| `sha` | the commit the directory and the branch both stand at |

<!-- FACT-CHECK: True. vendor-sync.mjs:137-147, sync.md:77-93 -->
`pin_ready` object:

| Field | Value |
|---|---|
| `state` | `"pin_ready"` |
| identity fields | see [Overview](#overview) |
| `sha_before`, `sha_after` | the pinned commit and the tip |
| `commits_behind` | as counted above |
| `skipped_submodules` | the paths of upstream's submodule entries (gitlinks, mode `160000`) in `<tip>:<path>`, relative to `<path>`, byte-sorted; `[]` when there are none. They are left out of the sync, so these folders stay absent |

<!-- FACT-CHECK: True. vendor-sync.mjs:177-185, sync.md:95-148, decisions.md:192 (D-11: field names), decisions.md:497 (D-35: no `mode`, no `lookalike`) -->
`merge_staged` object (sync):

| Field | Value |
|---|---|
| `state` | `"merge_staged"` |
| identity fields | see [Overview](#overview) |
| `base` | the commit whose directory is the merge base (the pinned commit), or `null` with `--without-base` |
| `sha_before`, `sha_after` | the pinned commit and the tip |
| `commits_behind` | as counted above |
| `files` | with a base: `{ path, upstream_changes, local_changes }` per file upstream changed — `upstream_changes` `modified`, `added`, `deleted`; `local_changes` `unchanged`, `modified`, `deleted`, `absent`. Without a base: `{ path, presence }` as for add. Files only the local side changed are not listed |
| `skipped_submodules` | the paths of upstream's submodule entries (gitlinks, mode `160000`) in `<tip>:<path>`, relative to `<path>`, byte-sorted; `[]` when there are none. They are left out of the sync, so these folders stay absent |
| `notes` | `[]`, or `["no_base"]` when `base` is `null` |

##### --continue

<!-- FACT-CHECK: True. vendor-sync.mjs:188-234 (continueSync), decisions.md:186 (D-10), decisions.md:678 (D-45), decisions.md:744 (D-58): refuses during another git operation, decisions.md:780 (D-61): refuses merging -->
Requires an open `sync` marker (exit 2 otherwise) and no other git operation in progress (exit 2); a `merging` marker exits 2 with `the sync on <dir> did not finish its start; discard it with --abort`. In either state it refuses while any path under `<dir>` is unmerged (exit 1 with `error.data.unresolved`, as for add); for `merge_staged` it then stops (exit 2) when the plan is missing or targets another commit than the marker. In either state it then refuses while anything is staged outside the tool's paths (exit 1, see [The commit at --continue](#the-commit-at---continue)). Then it runs [the commit at --continue](#the-commit-at---continue) and returns `synced`.

<!-- FACT-CHECK: True. vendor-sync.mjs:226-233, sync.md:150-163, decisions.md:678 (D-45), decisions.md:744 (D-58): `commit` field -->
`synced` object:

| Field | Value |
|---|---|
| `state` | `"synced"` |
| identity fields | see [Overview](#overview) |
| `sha_before`, `sha_after` | the commit pinned before and the commit pinned now |
| `commit` | the commit `--continue` made |
| `files` | the paths the commit changed under `<dir>`, `.vendor.json` aside (see [The changed files](#the-changed-files)); `[]` after a `pin_ready` the user left as it was |

##### --abort

<!-- FACT-CHECK: True. vendor-sync.mjs:236-261 (abortSync), decisions.md:350 (D-26: --abort accepts either marker) -->
Discards the open action, whichever it is (see [Action lifecycle](#action-lifecycle)). For a sync: after `merging` or `merge_staged` it runs [the abort restore](#the-abort-restore), then clears the marker; `sha` stays where it was, because the sync did not create the manifest. For an add it behaves exactly as `add --abort`. Returns [the `aborted` object](#the-aborted-object).

#### remove

<!-- FACT-CHECK: True. vendor-remove.mjs:25-49, remove.md:1-44, decisions.md:737 (D-57: also deletes the stored base, no commit) -->
```
node scripts/vendor-remove.mjs <dir>
```

<!-- FACT-CHECK: True. vendor-remove.mjs:27-48, decisions.md:737 (D-57) -->
Drops the connection and keeps every vendored file. It refuses a `<dir>` inside another connection's directory (exit 2, see [The precondition order](#the-precondition-order)), loads the manifest (exit 2 without one), refuses while an action is open (exit 2: finish or abort it first), then deletes `<dir>/.vendor.json`, `.vendor-sync/base/<slug>/`, the tracking ref and scratch. It does not commit: the deletions are the user's to review and commit.

<!-- FACT-CHECK: True. vendor-remove.mjs:1-4 ("Performs no network operation"), decisions.md:763 (D-59): carried over -->
`remove` performs no network operation: fetching only to delete would add an offline failure mode to an operation with no other reason to fail.

<!-- FACT-CHECK: True. vendor-remove.mjs:48 -->
`removed` object:

| Field | Value |
|---|---|
| `state` | `"removed"` |
| `dir`, `slug` | the directory and the connection that was dropped |
| `files_retained` | the number of files left in `<dir>` |

#### list

<!-- FACT-CHECK: True. vendor-list.mjs:31, vendor-list.mjs:86-93 -->
```
node scripts/vendor-list.mjs
```

<!-- FACT-CHECK: True. vendor-list.mjs:1-6, vendor-list.mjs:31-78 (assess never throws), connection.mjs:214-235 (findVendoredDirs skips .git, node_modules and .vendor-sync, and stops at a connection), decisions.md:807 (D-64: nested manifests) -->
Walks the repository for `.vendor.json` files — skipping `.git`, `node_modules` and `.vendor-sync`, and not descending into a connection's directory, because a `.vendor.json` below one is upstream content that connection manages, not a connection of its own — and assesses each connection. A connection that cannot be assessed is reported inline with `status` `error`, so one broken manifest or unreachable remote never hides the others, and `list` always exits 0. It writes no file; only tracking refs move, as any fetch moves them.

<!-- FACT-CHECK: True. vendor-list.mjs:52-76, decisions.md:737 (D-57: base_missing meaning, local_modifications against the stored base) -->
Per connection, in order: parse the manifest; if an action is open, report `in_progress` without fetching, since every derived fact would describe a half-finished directory; fetch; count `commits_behind`; check the stored base and report `base_missing` if it fails, with `local_modifications` `null`, since there is no intact base to compare against; compute `local_modifications`; report `up_to_date` or `behind`.

<!-- FACT-CHECK: True. vendor-list.mjs:40-50, list.md:17-42, decisions.md:737 (D-57) -->
`listed` object: `state` `"listed"` and `connections`, one object per connection in directory order (`[]` when nothing is vendored):

| Field | Value |
|---|---|
| `dir` | the directory |
| `slug`, `repo`, `ref` | from the manifest; `null` when it could not be read |
| `pinned_sha` | the pinned commit; `null` when the manifest could not be read |
| `upstream_tip` | the branch's tip; `null` when not fetched |
| `status` | `up_to_date`, `behind`, `base_missing`, `in_progress` or `error`; each word's meaning is its [status clause](#verbatim-blocks) |
| `commits_behind` | as for sync; `null` when the assessment did not get that far |
<!-- FACT-CHECK: True. decisions.md:744 (D-58): working tree against the stored base, untracked files counted as vendor-list.mjs:70-74 (git diff --no-index) counts them today -->
| `local_modifications` | `true` when `<dir>` differs from the stored base, manifest excluded — a tracked difference in the working tree or any untracked file counts; `null` when the assessment did not get that far |
| `error` | only with `status` `error`: the message and, beneath it, git's own output |


### Library layer

#### Module map

<!-- FACT-CHECK: True. decisions.md:737 (D-57: four modules, one-way dependencies) -->
<!-- FACT-CHECK: True. decisions.md:744 (D-58), design choice pending the author's confirmation. Refinement while filling: `merge.mjs` imports `connection.mjs`, because the abort and the merge start read and write the manifest and scratch; the outline drew both beside each other. -->
The scripts directory holds four library modules and four entry scripts. Dependencies run one way only — entry scripts → `merge.mjs` → `connection.mjs` → `git.mjs` → `contract.mjs` — and an entry script may import any library module, so each module can be tested without the ones above it. The diagram [`diagrams/modules.html`](diagrams/modules.html) shows the structure.

<!-- FACT-CHECK: True. decisions.md:737 (D-57: the approved interface list), decisions.md:744 (D-58) -->
| Module | Owns |
|---|---|
| `contract.mjs` | the [script contract](#the-script-contract): exit codes, `ScriptError`, `run`, argument parsing, and two pure shape checks (`HEX40`, `isPlainObject`) |
| `git.mjs` | every git invocation: spawning, refs, fetch, commits, trees, the index, version and in-progress checks |
| `connection.mjs` | a connection's files: slug, directory, manifest and marker, stored base, scratch, the commit at `--continue` |
| `merge.mjs` | the merge: change description, the merge start, the plan, the abort |

<!-- FACT-CHECK: True. lib.mjs:1-6 (run() is the only place that writes stdout or sets the exit code), merge-state.mjs:1-2 ("never writes stdout") -->
Only `run()` in `contract.mjs` writes stdout or sets the exit code; every other failure is a thrown `ScriptError`. Entry scripts export nothing.

#### Mechanisms

##### The precondition order

<!-- FACT-CHECK: True. vendor-add.mjs:138-225 (startAdd order), vendor-sync.mjs:69-131 (startSync order), decisions.md:711 (D-49 (3)), decisions.md:331 (D-24), decisions.md:261 (D-18 (2)), decisions.md:689 (D-46) -->
Every start runs these checks top to bottom and writes nothing before all that apply to it have passed. This is the only statement of the order; the action sections refer to it.

<!-- FACT-CHECK: True. vendor-add.mjs:323-368, vendor-sync.mjs:263-290 (arguments), lib.mjs:384-391 (root), decisions.md:711 (D-49 (3): version), lib.mjs:181-194 (dir), lib.mjs:162-171 (slug), vendor-add.mjs:146-149 and vendor-sync.mjs:75-76 (manifest, marker), vendor-add.mjs:109-124 (slug unused), vendor-sync.mjs:78-84 and vendor-add.mjs:189-195 (clean, git operation), vendor-add.mjs:76-107 and vendor-sync.mjs:86-95 (fetch, upstream path), decisions.md:689 (D-46: base check), decisions.md:744 (D-58): version placement, add's git-operation check onto existing content -->
| Check | Fails with | `add` | `sync` |
|---|---|---|---|
| the arguments | exit 1 | yes | yes |
| the repository root | exit 2 | yes | yes |
| git 2.40.0 or newer — the first check that runs git beyond locating the repository | exit 2 | yes | yes |
| `<dir>` inside the repository | exit 1 | yes | yes |
| `<dir>` is not a symbolic link and lies under none: no existing path component between the root and `<dir>`, inclusive of `<dir>`, is one (checked with `lstat`; components that do not exist yet pass) | exit 1, `<component> is a symbolic link`, naming the outermost, hint `choose a directory that is not a symbolic link or inside one` | yes | — |
| `<dir>` not inside another connection's directory: no directory between the root and `<dir>` holds a `.vendor.json` that `list` would find | exit 2, `<dir> is inside the vendored directory <outer>`, naming the outermost, hint `choose a directory outside it` | yes | yes |
| `<dir>` contains no other connection's directory: no directory below `<dir>`, as the file system resolves `<dir>`, is one that `list` would report | exit 2, `<dir> contains the vendored directory <inner>`, naming the first in `list`'s sorted order, hint `choose a directory that holds no vendored directory` | yes | — |
| a slug can be derived from `<dir>` | exit 1 | yes | — the manifest holds it |
| the manifest and its marker | exit 1 with `choices` for an open action; otherwise exit 2 | an existing manifest: open marker → `choices`, closed → `already vendored` | no manifest → `not a vendored directory`; open marker → `choices` |
| the slug is not used by another connection | exit 1 | yes | — |
| `<dir>` is clean (`git status --porcelain -z --no-renames --untracked-files=all -- <dir>` lists nothing) | exit 2, `<dir> has uncommitted changes: <paths>`, hint `commit or discard them, then re-run` | — see the last rows | yes |
| no merge, cherry-pick, revert or rebase in progress | exit 2 | — see the last rows | yes |
| nothing staged outside `<dir>` (see [The commit at --continue](#the-commit-at---continue)) | exit 2, `staged changes outside <dir>: <paths>` | yes | yes |
| `<dir>`, if it exists, is a directory | exit 2, `<dir> is not a directory`, hint `choose another directory` | yes | — the manifest lies in it |
| the fetch | exit 2; `add` exits 1 with `data.branches` when the branch is missing | yes | yes |
| the upstream directory | as noted | the commit to pin resolves and `<path>` is a directory there (exit 1, `data.entries` when absent) | `<path>` exists at the tip (exit 2) |
| the stored base | exit 1 with `choices` | — | only when the sync will merge; see [Base check](#base-check) |
| a `<dir>` that is not empty is clean | exit 2, `<dir> has uncommitted changes: <paths>`, hint `commit or discard them, then re-run` | yes — known only after the fetch | — |
| no merge, cherry-pick, revert or rebase in progress — both add starts write the index | exit 2 | yes | — |
| [the collision guard](#the-collision-guard) | exit 2 | yes, as part of the merge (the `ready` start's included) | as part of the merge |

<!-- FACT-CHECK: True. decisions.md:331 (D-24) -->
The open-action check precedes the clean check because a directory holding merge state always has uncommitted changes; the clean check would otherwise report the wrong cause (D-24).
<!-- FACT-CHECK: True. git.mjs uncommittedPaths, connection.mjs requireCleanDir, decisions.md D-18 (note 2026-10-26) -->
The clean check names what makes `<dir>` unclean: `<paths>` are the repository paths under `<dir>` that the same `git status` query lists — staged, unstaged and untracked, a rename as its two paths — sorted and joined with `, `, so the message and the check cannot disagree.
<!-- FACT-CHECK: True. decisions.md:711 (D-49 (3)), decisions.md:744 (D-58), decisions.md:802 (D-64: git 2.40) -->
The git version is checked before any git command that needs 2.40, and fails with exit 2 because upgrading git is the user's step (D-49).
<!-- FACT-CHECK: True. connection.mjs:99-117 (requireNotNested), decisions.md:807 (D-64: nested manifests) -->
A `.vendor.json` inside another connection's directory is upstream content that connection manages, so no script acts on it; the outermost connection names the directory, as in `list`.
<!-- FACT-CHECK: True. connection.mjs requireNoSymlink, vendor-add.mjs requireAddable, decisions.md D-64 (nested manifests, amended 2026-10-24: symbolic links) -->
`add` refuses a `<dir>` that is a symbolic link or lies under one: the start would write the manifest through the link, outside `<dir>`, and `git restore` would replace the link with a directory, so `--abort` could not undo it. Choosing another directory resolves it (exit 1).
<!-- FACT-CHECK: True. vendor-add.mjs:75, vendor-sync.mjs:62, decisions.md:799 (D-64: clean index) -->
A start refuses staged changes outside `<dir>` because `--continue` commits the index; an unstaged edit or an untracked file outside `<dir>` does not stop it.

<!-- FACT-CHECK: True. decisions.md:350 (D-26), vendor-add.mjs:176-192, vendor-sync.mjs:143-154, merge.mjs:501-510 (abortOpenAction), vendor-remove.mjs:22-27, decisions.md:744 (D-58): checks of --continue and --abort -->
`--continue` and `--abort` run the first five checks and the manifest check, then require their marker (exit 2 without one); `--continue` also refuses while another git operation is in progress, because it commits, and, once its marker's own checks have passed, while anything is staged outside the tool's paths (exit 1). `remove` runs the same checks as `--abort` except the git version.

##### The merge

<!-- FACT-CHECK: True. decisions.md:415 (D-30), decisions.md:493 (D-34), decisions.md:502 (D-36), decisions.md:719 (D-50) -->
A start that writes into `<dir>` — merge state, or an add's `ready` start — runs one git merge over three trees and turns git's result into the working tree, the index and the plan. The diagram [`diagrams/merge.html`](diagrams/merge.html) shows the flow.

<!-- FACT-CHECK: True. decisions.md:415 (D-30 step 1), decisions.md:502 (D-36), decisions.md:689 (D-46), decisions.md:733 (D-56) -->
The three sides:

| Side | Tree | Label |
|---|---|---|
| base | sync: `base_tree` after a passed check, `<sha>:<path>` with `--base-from-pin`, the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904` with `--without-base`; add: the empty tree | `vendor-base` |
| local | `HEAD:<dir>` — `HEAD` is the local side because the start requires a clean directory; the user's own submodule entries stay in it. An add's `ready` start: the empty tree, so the merged tree is upstream's and nothing conflicts | `vendor-local` |
| upstream | `<target>:<path>` | `vendor-upstream` |

The steps:

<!-- FACT-CHECK: True. decisions.md:408 (F-58: read-tree --prefix into a temp index; the real index refuses), decisions.md:415 (D-30 step 1) -->
1. **Prefix.** Each tree is read into a temporary index with `git read-tree --prefix=<dir>/` and written back with `git write-tree`, so every path in the merge is already a repository path and git's output needs no rewriting. The temporary index is required: `read-tree --prefix` into the real index fails when `<dir>` is tracked.
<!-- FACT-CHECK: True. decisions.md:744 (D-58), design choice pending the author's confirmation: a `.vendor.json` at the root of the base or upstream tree is dropped while prefixing — an upstream directory that is itself vendored elsewhere carries one, and it would otherwise collide with the local manifest. The existing classification already ignores the manifest (lib.mjs:629, treeEntries). -->
   A `.vendor.json` at the root of the base or the upstream tree is left out while prefixing: an upstream directory that is itself vendored somewhere carries its own manifest, which would otherwise collide with the local one. The local tree keeps its manifest, so the merge carries it through unchanged.
<!-- FACT-CHECK: True. git.mjs:296-332 (prefixedTree: gitlinks dropped unless keepGitlinks, rm --cached -f), merge.mjs:168-170, decisions.md:805 (D-64: gitlinks) -->
   Submodule entries (gitlinks, mode `160000`) are left out of the base and the upstream tree too, and so of the stored base: neither the merge nor the stored base can write a submodule's checkout. The start objects list upstream's left-out entries in `skipped_submodules`. The local tree keeps the user's own gitlinks, so the merge leaves them as they are. Both removals run `git rm --cached -f` in the temporary index: without `-f`, git compares the temporary entry with the real working tree and refuses when they differ.
<!-- FACT-CHECK: True. decisions.md:491 (F-66), decisions.md:493 (D-34), decisions.md:516 (D-38), decisions.md:719 (D-50) -->
1. **Name.** Each prefixed tree gets a parentless commit (`git commit-tree`) and a temporary ref: `refs/vendor-base`, `refs/vendor-local`, `refs/vendor-upstream`. Existing refs of those names are overwritten.
<!-- FACT-CHECK: True. decisions.md:415 (D-30 step 3), decisions.md:408 (F-58: `-c merge.conflictStyle=diff3` restores the base section), decisions.md:803 (D-64: zdiff3), decisions.md:459 (F-63: rename detection stays on in git's merge), decisions.md:744 (D-58): other exits fail 2 -->
1. **Merge.** `git -c merge.conflictStyle=zdiff3 merge-tree --write-tree -z --merge-base=vendor-base vendor-local vendor-upstream`. Exit 0 means clean, exit 1 means conflicts, anything else fails exit 2 with git's stderr. git's default rename detection applies. Like `diff3`, `zdiff3` puts the base section into the markers; but without a base, `diff3` turns every add/add conflict into one block holding both whole files, where `zdiff3` keeps the conflict to the differing lines.
<!-- FACT-CHECK: True. decisions.md:719 (D-50) -->
1. **Unname.** The three refs are deleted, in a `finally`, so they are gone whatever happened in the **Merge** step.
<!-- FACT-CHECK: True. decisions.md:459 (F-63, "Implementation note"), decisions.md:387 (F-55: stage lines are already update-index format), decisions.md:739 (F-94: the -z layout) -->
1. **Parse.** The output is read as bytes and split on NUL, never decoded as a string or passed through a shell: the first record is the merged tree oid, followed by one record per conflicted stage, `<mode> <oid> <stage>\t<path>`, and after an empty record git's informational messages. A text decode strips the NUL bytes, the stage records vanish, and the merge looks clean while it applied no conflicts.
<!-- FACT-CHECK: True. decisions.md:278 (D-21), decisions.md:322 (F-44) -->
<!-- FACT-CHECK: True. decisions.md:744 (D-58), design choice pending the author's confirmation: `touched` = `git diff-tree -r --name-only --no-renames <prefixed local> <merged>` ∪ the paths of the stage records -->
1. **Plan.** `touched` is every path under `<dir>` where the merged tree differs from the local tree (`git diff-tree -r --name-only --no-renames`), plus every path in a stage record; each with the local tree's blob as `local_oid`, or `null`. [The collision guard](#the-collision-guard) checks the paths with `null`, the ones the merge creates, before anything is written. The plan — `touched`, `base`, `target` — is written to scratch, so an open action always has its plan.
<!-- FACT-CHECK: True. decisions.md:780 (D-61) -->
1. **Open.** Write the manifest's marker with state `merging`. From here on an interruption leaves an open action that `--abort` undoes from the plan.
<!-- FACT-CHECK: True. decisions.md:408 (F-58: git restore materializes the whole result with modes, symlinks, deletions), decisions.md:415 (D-30 step 4), decisions.md:788 (D-62: manifest excluded), git.mjs:375-389 and merge.mjs:232-251 (case-only renames) -->
1. **Materialize.** `git restore --source=<merged tree> --staged --worktree -- ':(literal)<dir>' ':(exclude,literal)<dir>/.vendor.json'` writes the whole result: changed files, new files, deletions, executable bits and symlinks, all by git. For a conflicted path git has already put the marker text into the merged tree. The manifest is excluded because the merged tree holds it as committed in `HEAD`, without a marker, and restoring it would erase the `merging` marker the Open step wrote. On a case-insensitive file system `git restore` can delete a file it has just written when the old name differs only in case (a case-only rename), so every such path the index holds is written once more from the index.
<!-- FACT-CHECK: True. decisions.md:68 (F-17: the stage-0 removal line), decisions.md:415 (D-30 step 5) -->
1. **Conflicts.** All stage records go to one `git update-index --index-info`, each path preceded by its stage-0 removal line `0 0000000000000000000000000000000000000000\t<path>`. Without the removal line stage 0 survives and git shows a plain modification instead of a conflict.
<!-- FACT-CHECK: True. lib.mjs:812-824 (stageStart: the marker is written last), decisions.md:780 (D-61) -->
1. **Staged.** Switch the marker to `merge_staged` (an add's `ready` start: `ready`) as the last write.

<!-- FACT-CHECK: True. decisions.md:459 (F-63: symmetric results per row), decisions.md:506 (F-67: no-base results), decisions.md:396 (F-56), decisions.md:479 (F-65), decisions.md:739 (F-94: no-base binary and rename) -->
What git produces, and so what the user sees in the merge tool:

| Situation | With a base | Without a base |
|---|---|---|
| upstream changed, local unchanged | staged modification | conflict, both added |
| both changed, no overlap | merged, staged | conflict, both added |
| both changed, overlapping | conflict with zdiff3 markers | conflict, both added |
| upstream added | staged addition | staged addition |
| both added, different content | conflict, both added | conflict, both added |
| upstream deleted, local unchanged | staged deletion | not detectable; the file stays |
| upstream deleted, local changed | conflict, deleted by them | not detectable; the file stays |
| upstream changed, local deleted | conflict, deleted by us | upstream's file is added |
| upstream renamed, local edited | the edit follows the rename | not detected: the local file stays, upstream's file under the new name is added |
| binary changed on both sides | conflict, local bytes in the working tree | conflict, local bytes in the working tree |
| file became a directory (or the reverse) and the other side changed it | git renames one side to `<name>~vendor-local` or `<name>~vendor-upstream` | as with a base |
| only local has the file, or both are identical | untouched | untouched |

<!-- FACT-CHECK: True. decisions.md:506 (F-67: "without a base git cannot tell 'they changed it' from 'we changed it', so nothing merges silently") -->
Without a base, git cannot tell "upstream changed it" from "we changed it", so every file both sides hold that differs becomes a conflict, and a file only the local side holds is kept, even if upstream deleted it.
<!-- FACT-CHECK: True. decisions.md:502 (D-36, accepted cost), decisions.md:438 (F-61) -->
The conflict stays scoped to the differing lines while the two versions are close; where changes interleave, one conflict block holds the whole diverged region of both sides.

<!-- FACT-CHECK: True. merge-state.mjs:64-134 (classifyWithBase, classifyNoBase), decisions.md:192 (D-11: field names), decisions.md:763 (D-59): carried over -->
**The change description** — the `files` of the `merge_staged` object — is computed from the three trees' blob entries, not from git's merge, because it reports what each side did rather than how git combined it:

<!-- FACT-CHECK: True. merge-state.mjs:70-110 (classifyWithBase rows), merge.mjs:63-102 (blob and mode), decisions.md:804 (D-64: modes) -->
- With a base, a path is listed when upstream changed it: present in base and upstream with a different blob or mode (`upstream_changes` `modified`), present only upstream and not identical locally (`added`), or present in base, absent upstream and present locally (`deleted`). `local_changes` compares the local blob with the base: `unchanged`, `modified`, `deleted` (absent locally), or `absent` for an upstream addition the local side lacks; a local file at the path of an upstream addition counts as `modified`.
<!-- FACT-CHECK: True. merge-state.mjs:112-134 (classifyNoBase) -->
- Without a base, a path is listed when upstream has it and the local side lacks it (`presence` `upstream`) or holds different content (`both`).
<!-- FACT-CHECK: True. merge.mjs:55-67 (byPath: UTF-8 bytes; same: oid and mode), lib.mjs:629 and lib.mjs:648 (manifest excluded), decisions.md:804 (D-64: modes) -->
- Two entries are the same file only when blob oid and mode both agree, so a mode-only change upstream — an executable bit — is listed as `upstream_changes` `modified` and goes through the merge, and `local_changes` compares the local blob and mode with the base, so a local mode change counts as `modified`. The manifest is ignored; entries are sorted by plain byte comparison of the UTF-8 path, never by a locale's collation.

##### The collision guard

<!-- FACT-CHECK: True. merge.mjs:253-293 (requireNoCollisions), merge.mjs:200-206 (stageMerge), vendor-add.mjs:91 and vendor-add.mjs:211 (add start, ready --continue), decisions.md:808 (D-64: collision guard) -->
`git restore` silently overwrites whatever sits on disk at a path it writes, and `--abort` deletes every path the action created, so an untracked or ignored file at such a path would be lost. Before an action writes into `<dir>`, it checks every path it will create there — every path `HEAD` lacks, a `<name>~vendor-local` side file included — against the disk, and stops with exit 2 when one collides:

| `error.message` | `error.hint` |
|---|---|
| `<dir> holds files upstream would overwrite: <paths>` | `move them out of <dir>, then re-run` |

<!-- FACT-CHECK: True. merge.mjs:253-261 (the rules), merge.mjs:262-293 -->
- A path collides with an on-disk entry of the same name, and with a non-directory entry on its parent chain, unless that entry is a path tracked at `HEAD` that the action replaces; the clean check guarantees such an entry equals `HEAD`.
- A directory that holds tracked paths, which upstream replaced with a file, is no collision itself, but every untracked or ignored file inside it is: `git restore` deletes them with it.
- When git ignores case (`core.ignorecase`, which `git init` sets on a case-insensitive file system), names match up to case, as the file system would write through them, and an entry that matches a tracked path up to case counts as tracked.
- `<paths>` are relative to `<dir>` and sorted.

<!-- FACT-CHECK: True. merge.mjs:200-206, vendor-add.mjs:89-91, vendor-add.mjs:209-211 -->
It runs in the merge's **Plan** step, so at every start that writes into `<dir>`, an `add` start into a `<dir>` that has entries but nothing committed included. `--continue` writes nothing into `<dir>` and needs no guard.

##### The commit at --continue

<!-- FACT-CHECK: True. decisions.md:678 (D-45), decisions.md:737 (D-57) -->
`--continue` records the state the user arrived at as one commit, like `git merge --continue`. The time between the start and `--continue` is where the user resolves, reviews and adjusts; `--continue` does not ask again.

<!-- FACT-CHECK: True. connection.mjs:385-399 (requireNothingStagedOutside), git.mjs:132-142 (stagedPaths), vendor-add.mjs:75, vendor-sync.mjs:62, vendor-add.mjs:187, vendor-add.mjs:192, vendor-sync.mjs:154, decisions.md:799 (D-64: clean index, replaces D-45 condition 2) -->
The commit is a plain commit of the index, so the index must hold nothing but the tool's paths — `<dir>`, `.vendor-sync/base/<slug>`, `.vendor-sync/.gitignore` and `.vendor-sync/.gitattributes` — when it runs. Like `git merge`, an action therefore refuses to run while anything else is staged: a start exits 2 when anything outside `<dir>` is staged, and `--continue` exits 1 when anything outside the tool's paths is, so the user commits or unstages it and the agent runs `--continue` again. Both refuse before writing anything:

| `error.message` | `error.hint` |
|---|---|
| `staged changes outside <dir>: <paths>` | `commit or unstage them, then re-run` |

<!-- FACT-CHECK: True. git.mjs:132-142 (stagedPaths: --ignore-submodules=none) -->
`<paths>` are the repository paths outside the tool's paths (outside `<dir>` at a start) that `git diff --cached --name-only --no-renames --ignore-submodules=none` lists, sorted, so a staged gitlink counts whatever the submodule configuration says. Unstaged edits and untracked files outside `<dir>` do not count.

<!-- FACT-CHECK: True. decisions.md:678 (D-45), decisions.md:641 (D-42), decisions.md:665 (F-93), decisions.md:667 (D-44) -->
In order:

<!-- FACT-CHECK: True. decisions.md:641 (D-42), decisions.md:733 (D-56: base always from the target), decisions.md:744 (D-58): root .vendor.json dropped -->
1. **Base.** Write the stored base: prefix `<target>:<path>` with `.vendor-sync/base/<slug>` (dropping a root `.vendor.json` and submodule entries, as in the merge) and run `git restore --source=<prefixed tree> --staged --worktree -- .vendor-sync/base/<slug>`. `git restore` without `--overlay` also deletes base files the new tree no longer has.
<!-- FACT-CHECK: True. decisions.md:665 (F-93), decisions.md:667 (D-44) -->
1. **Tool files.** Write `.vendor-sync/.gitignore` and `.vendor-sync/.gitattributes` with the content [The stored base](#the-stored-base) defines, and stage both.
<!-- FACT-CHECK: True. lib.mjs:826-835 (finalizeContinue writes the closed manifest), decisions.md:737 (D-57: base_tree) -->
1. **Manifest.** Write the manifest closed: `sha` = target, `base_tree` = the tree oid the Base step wrote, `in_progress` = `null`; stage it.
<!-- FACT-CHECK: True. git.mjs:391-404 (commitIndex), decisions.md:678 (D-45), decisions.md:737 (D-57: message), decisions.md:744 (D-58): seven characters, decisions.md:799 (D-64: add -u and a plain commit), decisions.md:800 (D-64: why not --only) -->
1. **Commit.** `git add -u -- <dir>` stages every unstaged edit to a tracked file under `<dir>`, so adjustments the user made after resolving are included; untracked files — a merge tool's `*.orig` backups — are not. Then `git commit -m "vendor-sync: <action> <dir> to <short target>"` commits the index. A plain commit records the index as it stands, so a file that became a directory, a case-only rename and a gitlink the user tracks are committed as staged. The short target is its first seven characters.
<!-- FACT-CHECK: True. decisions.md:678 (D-45, condition 3), decisions.md:737 (D-57: exit 1), connection.mjs:415-426 (finishAction rollback), connection.mjs:354-362 (pruneToolDirs), git.mjs:396-402 (stderr and stdout), decisions.md:801 (D-64: accepted cost) -->
1. **On failure.** If the commit fails — a hook rejected it, signing failed — the stored base and the two dotfiles go back to `HEAD` in the index and the working tree, `.vendor-sync/base/` and `.vendor-sync/` are removed again when that leaves them empty, the manifest's index entry goes back to `HEAD`, the manifest is written back with its marker open, and the call exits 1 with git's output on stderr, both git's stderr and its stdout, since hooks may print to either. Everything stays as it was, except that an unstaged edit inside `<dir>` that `git add -u` staged stays staged, with the same content; the user fixes the cause and `--continue` runs again.
<!-- FACT-CHECK: True. lib.mjs:826-835 (scratch removed last) -->
1. **Clean up.** Delete scratch and return the commit's oid.

<!-- FACT-CHECK: True. decisions.md:678 (D-45, condition 3: "nothing is bypassed") -->
The user's hooks and signing configuration apply as to any commit; nothing is bypassed with `--no-verify`. Nothing is pushed, so `git reset HEAD~1` undoes the commit.

<!-- FACT-CHECK: True. decisions.md:678 (D-45, "Rejected keeping it with the user"), decisions.md:605 (F-84) -->
The commit makes the base, the manifest and the merge result land together; see the IntelliJ constraint in [Context](#context) (D-45).

##### The abort restore

<!-- FACT-CHECK: True. decisions.md:355 (D-27), decisions.md:375 (F-52), decisions.md:343 (F-47) -->
`--abort` after a start that wrote into `<dir>` (`merging`, `merge_staged`, an add's `ready`) puts back exactly the plan's `touched` paths with three path-scoped git commands, and nothing else:

<!-- FACT-CHECK: True. decisions.md:375 (F-52: split by local_oid; checkout accepts only paths in HEAD) -->
```
git reset -q -- <every touched path>
git checkout -- <touched paths with a local_oid>
git clean -fx -- <touched paths without a local_oid>
```

<!-- FACT-CHECK: True. merge.mjs:437-470 (abortMerge: literal paths, case twins) -->
Every path goes to git as `:(literal)<dir>/<path>`. A created path that differs from a restored one only in case is deleted from disk first: on a case-insensitive file system it is the same file, and `git checkout` would keep the created name. After `git clean`, each folder on a created path's parent chain is removed once it is empty, deepest first; a folder that holds anything else stays.

<!-- FACT-CHECK: True. decisions.md:375 (F-52), decisions.md:343 (F-47: modes restored, debris untouched, -x cannot reach unlisted ignored files) -->
`git checkout` restores content and mode from `HEAD`, which is the pre-merge state because the start required a clean directory. It accepts only paths `HEAD` has, so created paths go to `git clean` instead; `-x` lets it remove a created file even if an ignore rule matches it. Because every command names exact paths, nothing the merge did not write is touched: an ignored file, a local-only file, a merge tool's backup.

<!-- FACT-CHECK: True. merge-state.mjs:411-415 (leftovers), decisions.md:324 (D-23: debris reported in left[], not removed) -->
Afterwards `left` lists the untracked files under `<dir>` that are not in `touched`. They are reported, never removed.

<!-- FACT-CHECK: True. merge-state.mjs:423-441 (readPlanForAbort: missing plan carries a hint), decisions.md:763 (D-59): non-destructive hint -->
Without a usable plan the scripts cannot tell which paths they wrote, so `--abort` stops with exit 2 and a hint for the user: `git restore --source=HEAD --staged --worktree -- <dir>` puts every tracked file back, and the untracked files `git status -- <dir>` then lists are for the user to review before deleting any, because only the plan knew which of them the merge created.

##### The changed files

<!-- FACT-CHECK: True. decisions.md D-66, git.mjs (committedPaths), vendor-add.mjs (continueAdd), vendor-sync.mjs (continueSync) -->
After the commit, `--continue` reads the `files` of `added` and `synced` from the commit itself: `git diff-tree --no-commit-id --root -r --name-only --no-renames -z HEAD -- :(literal)<dir>`, which compares the new commit with its parent (with the empty tree for a root commit). The result is every path under `<dir>` whose blob, mode or existence the commit changed, relative to `<dir>`, without `.vendor.json`, sorted by UTF-8 bytes. It counts what was committed, whatever the plan said: a written file the user deleted before `--continue` is absent, a file the user edited beyond the plan is present, and a `pin_ready` the user left as it was gives `[]`.

#### Module interfaces

<!-- FACT-CHECK: True. decisions.md:726 (D-53), decisions.md:737 (D-57), decisions.md:744 (D-58), decisions.md:788 (D-62) -->
Every export of every library module, then the internal functions of the entry scripts. "fails 1" and "fails 2" mean the function throws a `ScriptError` with exit 1 (`EXIT.FIX`) or exit 2 (`EXIT.STOP`) through `fail`; "calls" names the other exports a function uses, so the call graph can be read off the tables. `root` is always the repository root's absolute path, `rel` the vendored directory relative to it with forward slashes, `abs` its absolute path. A function not marked "pure" runs git or touches the file system.

##### contract.mjs

<!-- FACT-CHECK: True. lib.mjs:26 (EXIT), lib.mjs:45-60 (ScriptError, fail), lib.mjs:62-100 (emit, run), lib.mjs:106-151 (parseArgv), decisions.md:763 (D-59): carried over -->
| Export | Signature → result | Behavior |
|---|---|---|
| `EXIT` | `{ OK: 0, FIX: 1, STOP: 2 }` | The three exit codes of [the script contract](#the-script-contract). Frozen. |
| `ScriptError` | `class extends Error`; `new ScriptError(exit, message, { hint?, data?, gitStderr? })` | Stores `exit`, `hint`, `data` and `gitStderr` as fields and sets `name` to `"ScriptError"`. The only failure type the scripts throw on purpose; `run` turns it into the error object. |
| `fail` | `(exit, message, opts?) → never` | Constructs a `ScriptError` from its arguments and throws it. Every "fails 1" and "fails 2" in these tables goes through it. Calls `ScriptError`. |
| `HEX40` | `/^[0-9a-f]{40}$/` | A full object id: 40 lowercase hex digits. Checks the manifest's `sha`, `base_tree` and `target_sha`, the plan's `base` and `target`, and the merged tree oid. |
| `isPlainObject` | `(value) → boolean` | Pure. `value` is an object, not `null` and not an array: the shape the manifest, its marker and the plan must have. |
| `run` | `(main: () => object) → void` | Calls `main()` synchronously inside a `try`. On a returned object: writes `JSON.stringify(obj, null, 2)` and a newline to stdout and sets `process.exitCode = 0`. On a `ScriptError`: writes `gitStderr` to stderr when it is non-empty (adding a trailing newline if missing), writes `{ error: { message, hint, data } }` with `hint` and `data` omitted when undefined, and sets `process.exitCode` to the error's `exit`. On any other thrown value: writes `{ error: { message } }` from the value's message and sets exit 2. Never calls `process.exit()`; every child process is `spawnSync`, so the process ends by itself once stdout has drained. The only writer of stdout. |
| `parseArgv` | `(argv: string[], spec: { value: string[], bool: string[] }) → { positionals, flags, problems }` | Pure. Walks `argv` left to right: a token not starting with `--` is a positional; `--name` with `name` in `spec.bool` sets `flags[name] = true`; `--name=value` with `name` in `spec.bool` adds `--name takes no value` to `problems`; `--name=value` or `--name value` with `name` in `spec.value` sets the value, and a missing value (end of `argv`, or a next token starting with `--`) adds `missing value for --name` to `problems`; any other `--name` adds `unknown flag: --name`. Never fails; the entry script fails 1 with the usage as `hint` when `problems` is non-empty. |
| `usageFailure` | `(usage) → (message) => never` | Returns a function that fails 1 with `message` and `usage` as the hint. The entry scripts' per-script argument checks go through it. Calls `fail`. |
| `parseArgvOrFail` | `(argv, spec, usage) → { positionals, flags }` | `parseArgv`; non-empty `problems` fail 1 with `problems` joined by `; ` and `usage` as the hint. Calls `parseArgv`, `usageFailure`. |
| `resumeMode` | `(positionals, flags, startFlags: string[], usage) → "continue" \| "abort" \| null` | `null` when neither `flags.continue` nor `flags.abort` is set. Both set fails 1 `--continue and --abort exclude each other`; otherwise a `positionals` count other than one, or any `startFlags` entry set in `flags`, fails 1 `--<mode> takes only <dir>`; both with `usage` as the hint. Returns the mode. Calls `usageFailure`. |

##### git.mjs

<!-- FACT-CHECK: True. lib.mjs:364-382 (git, gitOrFail), lib.mjs:512-524 (gitBuffer), lib.mjs:384-391 (repoRoot), lib.mjs:693-696 (gitDir), lib.mjs:741-744 (workingTreeClean), lib.mjs:760-781 (requireNoGitOperation), lib.mjs:393-423 (refs), lib.mjs:429-450 (remote), lib.mjs:456-506 (objects), lib.mjs:600-680 (index readers), lib.mjs:559-568 (updateIndexInfo), lib.mjs:911-919 (commitsBehind) -->
<!-- FACT-CHECK: True. git.mjs:44-52 (literal, literalExclude), git.mjs:430-439 (indexRecords fails 2), git.mjs:122-130, git.mjs:407-423, decisions.md:809 (D-64: literal pathspecs), git.mjs:60-67 (gitQuery: exit 1 is the answer), git.mjs:210-219 (isAncestor's missing commit), git.mjs:204-208 (isWellFormedRev), git.mjs:232-237 (pathKind) -->
Two rules hold for every function below. Every path a function passes to git as a pathspec, after `--`, is a literal pathspec, `:(literal)<path>`, built by `literal`, so a name holding `*`, `?` or `[` matches only itself; the one exclude is `:(exclude,literal)<rel>/.vendor.json`, built by `literalExclude`. And a function that reads git's output fails 2 with git's stderr when git exits with an unexpected status. Any non-zero status is unexpected unless the function's row names the one status that is an answer and what it returns for it (`null`, `false`, `[]`): exit 1 of `git rev-parse --verify -q` (absent), of `git config --get` (unset), of `git merge-base --is-ancestor` (not an ancestor), and of `git diff --quiet` (differs). Any other status, such as 128 for a fatal error, fails 2. The rows of `isAncestor`, `isWellFormedRev` and `pathKind` name their exceptions.

<!-- FACT-CHECK: True. decisions.md:744 (D-58), decisions.md:788 (D-62): new or changed exports — env option, requireGitVersion, prefixedTree, commitTree, mergeTree, diffTreeNames, restoreTree, commitPaths, worktreeDiffers, untrackedFiles; decisions.md:415 (D-30), decisions.md:408 (F-58), decisions.md:459 (F-63), decisions.md:739 (F-94) for the git commands; decisions.md:798 (D-64): literal, literalExclude, tempIndexPath, ignoresCase, stagedPaths, gitlinkPaths, commitIndex -->
| Export | Signature → result | Behavior |
|---|---|---|
| `EMPTY_TREE_OID` | `"4b825dc642cb6eb9a060e54bf8d69288fbee4904"` | The empty tree. git knows this object without it ever being written, so it can serve as a merge base and as input to `prefixedTree` in any repository. |
| `MIN_GIT_VERSION` | `"2.40.0"` | Read by `requireGitVersion`. `merge-tree --merge-base` needs git 2.40. |
| `git` | `(args, root, { env? }) → { status, stdout, raw, stderr }` | `spawnSync("git", args)` in `root`, UTF-8, 64 MiB output limit, `env` merged over `process.env`. `stdout` is trimmed, `raw` untrimmed. `status` is −1 when git could not be spawned or was killed. Never throws. Use it for text output only. |
| `gitBuffer` | `(args, root, { input?, env? }) → { status, stdout: Buffer, stderr }` | As `git`, but stdout stays a `Buffer` (256 MiB limit) and `input` is written to stdin. Required for file bytes and every `-z` output, because a string decode would corrupt bytes and drop NULs. Never throws. |
| `literal` | `(path) → string` | Pure. `:(literal)<path>`: a pathspec that matches exactly `path`. Without the magic, git reads `[`, `*` and `?` as glob characters. |
| `literalExclude` | `(path) → string` | Pure. `:(exclude,literal)<path>`: excludes exactly `path`. |
| `gitOrFail` | `(args, message, root, { env? }) → result` | Calls `git`; on a non-zero status fails 2 with `message`, carrying git's stderr as `gitStderr`. Calls `git`, `fail`. |
| `repoRoot` | `(cwd) → string` | Runs `git rev-parse --show-toplevel` in `cwd`; fails 2 `not inside a git repository` with git's stderr. Returns the path through `realpathSync`, so a symlinked temporary directory compares equal to the paths git prints. Calls `git`, `fail`. |
| `gitDir` | `(root) → string` | `git rev-parse --absolute-git-dir`, which also resolves a worktree's git directory. Calls `gitOrFail`. |
| `requireGitVersion` | `(root) → void` | Runs `git --version` and reads the first `<major>.<minor>.<patch>` from the output, ignoring suffixes such as `(Apple Git-155)`. Compares it numerically with `MIN_GIT_VERSION`; below it, or unparseable, fails 2 `vendor-sync needs git 2.40.0 or newer; found <version>` with the hint `upgrade git, then re-run`. Calls `git`, `fail`. |
| `requireRepository` | `(cwd) → string` | `repoRoot(cwd)`, then `requireGitVersion` on it; returns the root. The first checks of every `add` and `sync` call; `remove` and `list` call `repoRoot` alone. Calls `repoRoot`, `requireGitVersion`. |
| `requireNoGitOperation` | `(root) → void` | Checks the git directory for `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`, `rebase-apply`, in that order; the first that exists fails 2 `another git operation is in progress: <name>` with the hint `finish or abort it, then re-run`. Calls `gitDir`, `fail`. |
| `ignoresCase` | `(root) → boolean` | `git config --get --type=bool core.ignorecase` prints `true`: git treats names that differ only in case as one file, as `git init` sets up on a case-insensitive file system. Exit 1, unset, reads as `false`; any other non-zero status (a value that is not a boolean) fails 2 `cannot read core.ignorecase`. Calls `git`, `fail`. |
| `uncommittedPaths` | `(rel, root) → string[]` | The repository paths under `rel` that `git status --porcelain -z --no-renames --untracked-files=all -- <rel>` lists, sorted; empty means clean. Untracked files count, whatever `status.showUntrackedFiles` says; ignored files do not; a rename is its two paths. A non-zero status fails 2 `git status failed`. Calls `gitBuffer`, `literal`, `nulRecords`, `fail`. |
| `stagedPaths` | `(root) → string[]` | `git diff --cached --name-only -z --no-renames --ignore-submodules=none`: every repository path whose index entry differs from `HEAD` (from the empty tree on an unborn `HEAD`), sorted. `--ignore-submodules=none` shows a staged gitlink whatever the submodule configuration says. A non-zero status fails 2 `cannot list the staged paths`. Calls `gitBuffer`, `nulRecords`, `fail`. |
| `trackingRef` | `(slug) → string` | Pure. `refs/vendor/<slug>`. |
| `readRef` | `(ref, root) → string \| null` | `git rev-parse --verify -q <ref>`; the oid, or `null` on exit 1, absent. Any other non-zero status fails 2 `cannot read <ref>`. Calls `git`, `fail`. |
| `setRef` | `(ref, oid, root) → void` | `git update-ref <ref> <oid>`, creating or overwriting the ref. Calls `gitOrFail`. |
| `deleteRef` | `(ref, root) → void` | `git update-ref -d <ref>`; the status is ignored, so deleting an absent ref is not an error. Calls `git`. |
| `fetchTracking` | `(repo, ref, slug, root) → void` | `git fetch --no-tags <repo> +refs/heads/<ref>:<trackingRef(slug)>`. The leading `+` forces the update, so an upstream history rewrite still moves the ref. Non-zero fails 2 `fetch failed: repo=<repo> ref=<ref>` with git's stderr. Calls `trackingRef`, `git`, `fail`. |
| `listRemoteBranches` | `(repo, root) → string[]` | `git ls-remote --heads <repo>`; takes the second column of each line, keeps `refs/heads/*` with the prefix stripped, sorts. `[]` when the command fails. Calls `git`. |
| `commitExists` | `(sha, root) → boolean` | `resolveCommit(sha)` is not `null`: the commit is in the local object store. Calls `resolveCommit`. |
| `resolveCommit` | `(rev, root) → string \| null` | `git rev-parse --verify -q <rev>^{commit}`: the full commit oid, or `null` on exit 1, absent or not a commit. Any other non-zero status fails 2 `cannot resolve <rev>^{commit}`. Calls `git`, `fail`. |
| `isWellFormedRev` | `(rev, root) → boolean` | `git rev-parse --verify -q <rev>` exits 0. An exception to the reader rule: any non-zero status is `false`, because `rev` is the user's `--sha`, read right after a successful fetch, so a failure comes from the input (`HEAD@{99}` exits 128) and `pinnedCommit` reports it with exit 1. A syntactically valid full oid passes even when the object is absent; existence is `commitExists`. Calls `git`. |
| `isAncestor` | `(sha, ref, root) → boolean` | `git merge-base --is-ancestor <sha> <ref>`: exit 0 is `true`, exit 1 `false`. git exits 128 both when `sha` is not in the object store and on a real failure; the first is `false`, because after upstream rewrites its history the pinned commit is gone and sync and list then report `commits_behind` `null`. So on any other status it returns `false` when `commitExists(sha)` is `false`, and otherwise fails 2 `cannot tell whether <sha> is an ancestor of <ref>`. Calls `git`, `commitExists`, `fail`. |
| `commitsBehind` | `(sha, tip, path, root) → number` | `git rev-list --count <sha>..<tip> -- <path>`, parsed as a number: the commits after `sha` up to `tip` that touched `path`. Calls `gitOrFail`, `literal`. |
| `pathKind` | `(rev, path, root) → "tree" \| "blob" \| null` | `git rev-parse --verify -q <rev>:<path>`: `null` on any non-zero status, the path does not resolve. An exception to the reader rule: `path` is the user's `<path>`, read right after a successful fetch, so a failure comes from the input (`../x` exits 128) and `requireUpstreamDirectory` reports it with exit 1. Then `git cat-file -t <oid>`: its type when that is `tree` or `blob`, else `null`. A submodule entry names a commit the store lacks, so `cat-file` fails there; that is `null` when `git ls-tree -z <rev> -- <path>` shows mode `160000`, and otherwise fails 2 `cannot read the type of <rev>:<path>`. Calls `git`, `gitBuffer`, `literal`, `fail`. |
| `siblingListing` | `(rev, path, root) → string[]` | `git ls-tree -z --name-only <rev>:<parent of path>`, split on NUL: the names beside `path`, shown in `error.data.entries` when an upstream path is mistyped. `-z` gives exact names; without it git C-quotes unusual ones. `[]` on failure. Calls `gitBuffer`, `nulRecords`. |
| `treeOid` | `(rev, path, root) → string \| null` | `git rev-parse --verify -q <rev>:<path>`: the oid of the tree or blob at `path`, `null` on exit 1, absent. Any other non-zero status fails 2 `cannot resolve <rev>:<path>`. With `path` `""` it resolves `<rev>^{tree}`, `rev`'s root tree. Calls `git`, `fail`. |
| `nulRecords` | `(buf: Buffer) → string[]` | Pure. Splits a `-z` output on the byte `0x00` and decodes each record on its own as UTF-8; empty records in the middle stay, the trailing empty record is dropped. Every `-z` reader in this module and `parseMergeTreeOutput` split through it. |
| `treeEntries` | `(rev, path, root) → Map<string, { mode, oid }>` | `git ls-tree -r -z <rev>:<path>` (`<rev>^{tree}` for `path` `""`), split on NUL; each record `<mode> <type> <oid>\t<file>`. Keeps blobs only — regular files, executables and symlinks; drops submodule entries — and drops a root `.vendor.json`. A non-zero status fails 2 `cannot list the tree <spec>`, `<spec>` being the tree spec it listed (`<rev>:<path>` or `<rev>^{tree}`): it also reads `HEAD` and the stored base, so a caller that must report a missing upstream path checks for it first. Calls `gitBuffer`, `nulRecords`, `fail`. |
| `gitlinkPaths` | `(rev, path, root) → string[]` | `git ls-tree -r -z <rev>:<path>` (`<rev>^{tree}` for `path` `""`): the paths of the submodule entries (mode `160000`) under `path`, relative to it, sorted by UTF-8 bytes — what `treeEntries` and `prefixedTree` leave out, reported as `skipped_submodules`. A non-zero status fails 2 `git ls-tree failed`. Calls `gitBuffer`, `nulRecords`, `fail`. |
| `prefixedTree` | `(tree, prefix, root, { omitManifest?, keepGitlinks? }) → string` | Re-roots `tree` under `prefix`. Runs `git read-tree --prefix=<prefix>/ <tree>` with `GIT_INDEX_FILE` pointing at a fresh temporary index, `<git directory>/vendor-sync-index-<pid>-<milliseconds>`, which does not exist yet, so git starts it empty. Unless `keepGitlinks`, drops every submodule entry (mode `160000`), because neither the merge nor the stored base can write a submodule's checkout; `keepGitlinks` is for the local side, where a gitlink the user tracks inside `<dir>` stays. With `omitManifest` also drops `<prefix>/.vendor.json`. Both drops run one `git rm --cached -f -q --ignore-unmatch -- <paths>` in the temporary index; `-f` because git otherwise compares the temporary entry with the real working tree and refuses when they differ. Then `git write-tree` returns the new tree's oid. The temporary index is deleted in a `finally`. The project's real index is never touched, because `read-tree --prefix` into it fails when `prefix` is tracked. Calls `gitDir`, `gitOrFail`, `gitBuffer`, `nulRecords`, `literal`, `fail`. |
| `commitTree` | `(tree, root) → string` | `git commit-tree <tree> -m "vendor-sync merge side"`: a parentless commit of `tree`, used only to give `merge-tree` named sides. Needs a git identity like any commit. Calls `gitOrFail`. |
| `mergeTree` | `(base, local, upstream, root) → { conflicted: boolean, stdout: Buffer }` | `git -c merge.conflictStyle=zdiff3 merge-tree --write-tree -z --merge-base=<base> <local> <upstream>`, where the three arguments are ref names. Exit 0 → `conflicted: false`, exit 1 → `true`, anything else fails 2 `git merge-tree failed` with git's stderr. The output stays a `Buffer` for `parseMergeTreeOutput`. Calls `gitBuffer`, `fail`. |
| `diffTreeNames` | `(treeA, treeB, root) → string[]` | `git diff-tree -r --name-only --no-renames -z <treeA> <treeB>`, split on NUL and sorted: every path whose blob, mode or existence differs. Fails 2 on a non-zero status. Calls `gitBuffer`, `nulRecords`, `fail`. |
| `committedPaths` | `(rel, root) → string[]` | `git diff-tree --no-commit-id --root -r --name-only --no-renames -z HEAD -- :(literal)<rel>`: the paths under `rel` that the commit at `HEAD` changed against its parent, or against the empty tree for a root commit — blob, mode or existence — relative to `rel`, without `rel`'s own `.vendor.json`, sorted by UTF-8 bytes. The `files` of `added` and `synced` ([The changed files](#the-changed-files)). A non-zero status fails 2 `cannot list the paths HEAD changed in <rel>`. Calls `gitBuffer`, `nulRecords`, `literal`, `fail`. |
| `restoreTree` | `(tree, pathspecs: string[], root) → void` | `git restore --source=<tree> --staged --worktree -- <pathspecs>`. Writes index and working tree from the tree with git's modes, symlinks and line-ending rules; tracked paths the tree lacks are deleted, untracked files are left alone. Then every path the index holds but the working tree lacks (`git ls-files -d -z`) is written once more with `git checkout-index -f`: on a case-insensitive file system `git restore` deletes a file it just wrote when the old name differs only in case. The caller passes literal pathspecs. Calls `gitOrFail`, `gitBuffer`, `nulRecords`, `fail`. |
| `commitIndex` | `(message, rel, root) → string` | `git add -u -- <rel>` stages every unstaged edit to a tracked file under `rel` (fails 2 `cannot stage the edits to commit`); untracked files stay out. Then `git commit -q -m <message>` commits the index, running the user's hooks and signing. The callers have made sure the index holds nothing but the tool's paths (`requireNothingStagedForCommit`). A non-zero commit status fails 1 `the commit failed; the action is still open`, carrying git's stderr and stdout as `gitStderr`, because hooks may print to either. Returns `HEAD`'s new oid. Calls `gitOrFail`, `git`, `literal`, `readRef`, `fail`. |
| `worktreeDiffers` | `(tree, rel, root) → boolean` | `git diff --quiet <tree> -- :(literal)<rel> :(exclude,literal)<rel>/.vendor.json`; exit 1 means the working tree differs from `tree`, exit 0 that it does not, anything else fails 2 `cannot compare <rel> with <tree>`. `tree` must already be prefixed with `rel`. Untracked files are not seen. Calls `git`, `literal`, `literalExclude`, `fail`. |
| `untrackedFiles` | `(rel, root) → string[]` | `git ls-files -o --exclude-standard -z -- <rel>`: untracked, not ignored files under `rel`, relative to it, sorted. A non-zero status fails 2 `git ls-files failed`. Calls `gitBuffer`, `nulRecords`, `literal`, `fail`. |
| `indexEntries` | `(rel, root) → Map<string, { mode, oid }>` | `git ls-files -s -z -- <rel>`; keeps stage-0 entries, paths relative to `rel`, a root `.vendor.json` dropped. A path carrying only unmerged stages is absent. A non-zero status fails 2 `git ls-files failed`. Calls `gitBuffer`, `nulRecords`, `literal`, `fail`. |
| `unmergedFiles` | `(rel, root) → string[]` | `git ls-files -u -z -- <rel>`: every path with an unmerged stage, relative to `rel`, deduplicated (one path has up to three stages) and sorted. Untracked files never appear. A non-zero status fails 2 `git ls-files failed`. Calls `gitBuffer`, `nulRecords`, `literal`, `fail`. |
| `updateIndexInfo` | `(lines: string[], root) → void` | No-op when `lines` is empty. Otherwise writes the lines, newline-terminated, to the stdin of one `git update-index --index-info`; fails 2 on a non-zero status. Calls `gitBuffer`, `fail`. |

##### connection.mjs

<!-- FACT-CHECK: True. lib.mjs:37-39 (MANIFEST_NAME, MANIFEST_FIELDS, SCRATCH_ROOT), lib.mjs:153-194 (slug, normalizeLocalDir, isInside), vendor-add.mjs:109-124 (requireSlugUnused), lib.mjs:196-358 (manifest and marker functions), lib.mjs:784-810 (scratch), lib.mjs:934-951 (listDirFiles, countFiles), lib.mjs:826-835 (finalizeContinue) -->
<!-- FACT-CHECK: True. decisions.md:744 (D-58), decisions.md:763 (D-59), decisions.md:780 (D-61), decisions.md:788 (D-62): new or changed — TOOL_ROOT, requireNoOpenAction's action, requireMarker's options, baseRepoPath, committedBaseTree, requireBaseIntact, writeStoredBase, writeToolFiles, the self-ignoring scratch, countFiles, finishAction; decisions.md:689 (D-46), decisions.md:773 (D-60), decisions.md:678 (D-45) for their behavior; decisions.md:798 (D-64): requireNotNested, parseManifest by the schema, identityOf, findVendoredDirs stopping at a connection, requireNothingStagedOutside, finishAction's commit and rollback -->
| Export | Signature → result | Behavior |
|---|---|---|
| `MANIFEST_NAME` | `".vendor.json"` | |
| `MANIFEST_FIELDS` | `["slug", "repo", "path", "ref", "sha", "base_tree", "in_progress"]` | The serialization order. |
| `TOOL_ROOT` | `".vendor-sync"` | |
| `deriveSlug` | `(rel) → string` | Pure. Replaces `/` with `-`, then every character outside `[A-Za-z0-9_-]` with `-`, collapses runs of `-`, strips leading and trailing `-` and `.`. May return `""`. Not injective: `skills/demo` and `skills-demo` give the same slug, hence `requireSlugUnused`. |
| `requireSlug` | `(rel, root) → string` | Calls `deriveSlug`; an empty result, or `git check-ref-format <trackingRef(slug)>` failing, fails 1 `cannot derive a ref-safe slug from the directory name: <rel>` with the hint `rename the directory and re-run`. Calls `deriveSlug`, `trackingRef`, `git`, `fail`. |
| `requireSlugUnused` | `(slug, rel, connections: string[], root) → void` | Reads the manifest of every other directory in `connections`, what `findVendoredDirs` returned, leniently (unreadable JSON is skipped), and fails 1 `slug "<slug>" is already used by <dir>` with the hint `rename the directory and re-run` on a match. Calls `fail`. |
| `isInside` | `(rootAbs, abs) → boolean` | Pure. `path.relative(rootAbs, abs)` is non-empty, not `..`, does not start with `../` and is not absolute: `abs` lies strictly inside `rootAbs`. |
| `normalizeLocalDir` | `(arg, root) → { abs, rel }` | Resolves `arg` against `root` (which also drops trailing separators); fails 1 `<arg>: directory must lie inside the repository (<root>)` unless `isInside`. `rel` uses forward slashes. Calls `isInside`, `fail`. |
| `requireNotNested` | `(rel, root) → void` | Looks at every directory between the root and `rel`, exclusive of both, for a regular file `.vendor.json` that `findVendoredDirs` would reach (no path segment named `.git`, `node_modules` or `.vendor-sync`). When one holds one, fails 2 `<rel> is inside the vendored directory <outer>` (hint `choose a directory outside it`), naming the outermost: a manifest inside another connection's directory is upstream content that connection manages. Calls `fail`. |
| `requireNoInnerConnection` | `(rel, connections: string[], root) → void` | Looks among `connections`, what `findVendoredDirs` returned, for one that lies below `<rel>`. `<rel>` is compared as the file system resolves it (`realpathSync.native` of `<rel>` and of the root), so on a case-insensitive file system `Vendor` contains `vendor/foo`; the connections are compared as found, because `findVendoredDirs` reads their names from disk and does not follow symbolic links, and `requireNoSymlink` has already refused one in `<rel>`. A `<rel>` that does not exist contains nothing. When one does, fails 2 `<rel> contains the vendored directory <inner>` (hint `choose a directory that holds no vendored directory`), naming the first in `findVendoredDirs`' sorted order: adding onto it would merge that connection's files into the new one and hide it from `list`. A sibling such as `<rel>-x` or a name that only shares a prefix with `<rel>` does not count. Start of `add` only. Calls `fail`. |
| `serializeManifest` | `(manifest) → string` | Pure. Builds an object with exactly the `MANIFEST_FIELDS` keys in order, `in_progress` defaulting to `null` and reduced to `{ action, state, target_sha }`, and returns `JSON.stringify(obj, null, 2)` plus a newline. |
| `parseManifest` | `(text, path) → manifest` | Checks the text against the [manifest schema](#the-manifest), in this order, each failure exit 2: JSON (`<path>: malformed JSON: …`); an object (`<path>: not a JSON object`); no unknown key (`<path>: unknown field "<key>"`); `slug`, `repo`, `path`, `ref`, `sha` and `base_tree` present as non-blank strings, and `in_progress` present (`<path>: missing required field "<field>"`); `slug` matching `^[A-Za-z0-9_][A-Za-z0-9_-]*$` (`<path>: invalid slug`); `sha` and `base_tree` 40 lowercase hex digits (`<path>: invalid sha`, `<path>: invalid base_tree`); `in_progress` `null` or a marker with no key beyond `action`, `state` and `target_sha`, whose `action` is `add` or `sync`, whose `state` is allowed for that action and whose `target_sha` is 40 hex digits (`<path>: invalid in_progress`). Returns the normalized manifest. Calls `HEX40`, `isPlainObject`, `fail`. |
| `manifestExists` | `(abs) → boolean` | `<abs>/.vendor.json` exists. |
| `loadManifest` | `(abs, rel) → manifest` | Fails 2 `not a vendored directory: <rel>` with the hint `use add to vendor it` unless `manifestExists`; otherwise reads the file and parses it with `parseManifest`, naming `<rel>/.vendor.json` in messages. Calls `manifestExists`, `parseManifest`, `fail`. |
| `requireNoSymlink` | `(rel, root) → void` | `lstat`s every path component from the root down to `<rel>`, inclusive of `<rel>`; at the first that does not exist it returns, so a `<rel>` yet to be created passes. When one is a symbolic link (a dangling one too), fails 1 `<component> is a symbolic link`, naming that outermost link by its repo-relative path, with the hint `choose a directory that is not a symbolic link or inside one`: the start would write through the link, outside `<rel>`, and `git restore` would replace it. Start of `add` only. Calls `fail`. |
| `loadConnection` | `(dirArg, root) → { root, abs, rel, manifest }` | `normalizeLocalDir`, `requireNotNested` (in an internal helper), then `loadManifest`. Calls `normalizeLocalDir`, `requireNotNested`, `loadManifest`. |
| `identityOf` | `(rel, manifest) → { dir, slug, repo, path, ref }` | Pure. The [identity fields](#overview) every `add` and `sync` object starts with. |
| `writeManifest` | `(abs, manifest) → void` | Creates `abs` when absent and writes `serializeManifest(manifest)` to `<abs>/.vendor.json`. The only file in `<dir>` a script writes itself. Calls `serializeManifest`. |
| `findVendoredDirs` | `(root) → string[]` | Walks the directory tree from `root`, recording every directory that contains a regular file named `.vendor.json`. It does not descend into a recorded directory, because a manifest below a connection's directory is that connection's upstream content; the root itself is never a connection's directory, so a manifest there does not stop the walk. Skips directories named `.git`, `node_modules` or `.vendor-sync` at any depth; an unreadable directory is skipped silently. Returns the recorded paths relative to `root`, forward-slashed, sorted. |
| `requireNoOpenAction` | `(manifest, action, rel) → void` | Returns when `in_progress` is `null`. Otherwise fails 1 `an unfinished <open action> is open on <rel>, started against <target_sha>` with `data.choices`: `["abort", "leave"]` for a `merging` marker, `["resume", "abort", "leave"]` when the marker's action equals `action`, `["abort", "leave"]` otherwise. Calls `fail`. |
| `requireMarker` | `(manifest, action, rel) → marker` | The marker `--continue` finishes. Fails 2 `no unfinished <action> on <rel>` (hint `run the start call first`) when no marker is open; fails 2 `an unfinished <open action> is open on <rel>, not <action>` (hint `finish it with --continue, or discard it with --abort`) when the open action differs; fails 2 `the <open action> on <rel> did not finish its start; discard it with --abort` for a `merging` marker. Returns the marker. Calls `fail`. |
| `requireAnyMarker` | `(manifest, rel) → marker` | The marker `--abort` discards: whatever action is open, in any state, `merging` included. Fails 2 `no unfinished action on <rel>` (hint `run the start call first`) when no marker is open. Returns the marker. Calls `fail`. |
| `requireMarkerClosed` | `(manifest, rel) → void` | Fails 2 `an unfinished <action> is open on <rel>, started against <target_sha>` with the hint `finish it with --continue, or discard it with --abort` when a marker is open. Used by `remove`. Calls `fail`. |
| `markerWriter` | `(abs, manifest, action, target) → (state) → void` | The `writeMarker` a start hands to `stageMerge` (and sync's `pin_ready` calls): writes `manifest` with `in_progress: { action, state, target_sha: target }` via `writeManifest`. Calls `writeManifest`. |
| `baseRepoPath` | `(slug) → string` | Pure. `.vendor-sync/base/<slug>`. |
| `committedBaseTree` | `(slug, root) → string \| null` | The oid of the committed stored base: `treeOid("HEAD", baseRepoPath(slug))`. Reads `HEAD`, never the working tree. Calls `treeOid`, `baseRepoPath`. |
| `requireBaseIntact` | `(manifest, rel, root) → void` | Returns when `committedBaseTree(slug)` equals `base_tree`. Otherwise fails 1 per [Base check](#base-check): message `the stored base for <rel> is missing from HEAD` when the committed tree is absent, `… does not match the pinned upstream commit <sha>` when it differs; `data.choices` `["base_from_pin", "leave"]` when `commitExists(sha)`, else `["without_base", "leave"]`. Calls `committedBaseTree`, `commitExists`, `fail`. |
| `writeStoredBase` | `(slug, target, path, root) → string` | The **Base** step of [the commit](#the-commit-at---continue): takes `treeOid(target, path)` (fails 2 `upstream path absent at <target>: <path>` when absent), re-roots it with `prefixedTree(…, baseRepoPath(slug), { omitManifest: true })`, which also drops submodule entries, and runs `restoreTree(<that tree>, [literal(baseRepoPath(slug))])`, which writes and stages the base and deletes base files the new tree lacks. Returns the oid of the base directory inside the re-rooted tree — the stripped upstream tree, which becomes `base_tree`. Calls `treeOid`, `prefixedTree`, `restoreTree`, `literal`, `baseRepoPath`, `fail`. |
| `writeToolFiles` | `(root) → void` | The **Tool files** step: creates `.vendor-sync/`, writes `.gitignore` and `.gitattributes` with the content [The stored base](#the-stored-base) defines (overwriting whatever was there) and stages both with `git add --`. Calls `gitOrFail`, `literal`. |
| `scratchDir` | `(root, slug) → string` | Pure. `<root>/.vendor-sync/scratch/<slug>`. |
| `ensureScratch` | `(root, slug) → string` | Creates `scratchDir(root, slug)` with parents and writes a `.gitignore` containing `*` into it, so scratch is ignored even before `.vendor-sync/.gitignore` is committed, and `resetScratch` removes the ignore file with the rest. A file-system error fails 2 `cannot write scratch at <path>: <reason>`. Returns the directory. Calls `scratchDir`, `fail`. |
| `resetScratch` | `(root, slug) → void` | Deletes `scratchDir(root, slug)` recursively; an absent directory is not an error. Then removes `.vendor-sync/scratch/`, `.vendor-sync/base/` and `.vendor-sync/` in that order, each only when it is empty; a directory that is not empty or absent is kept. Calls `scratchDir`. |
| `countFiles` | `(abs) → number` | The number of regular files under `abs`, recursively; `0` when `abs` does not exist. Any other file-system error is thrown. Used by `remove` for `files_retained`. |
| `requireCleanDir` | `(rel, root) → void` | The clean check of a start: fails 2 `<rel> has uncommitted changes: <paths>` (hint `commit or discard them, then re-run`) when `uncommittedPaths` lists anything, `<paths>` being that list joined with `, `. Calls `uncommittedPaths`, `fail`. |
| `requireNothingStagedOutside` | `(rel, root) → void` | The clean-index rule of [the commit](#the-commit-at---continue), at a start: fails 2 `staged changes outside <rel>: <paths>` (hint `commit or unstage them, then re-run`) when `stagedPaths` lists a path outside `rel`. Calls `stagedPaths`, `fail`. |
| `requireNothingStagedForCommit` | `(rel, slug, root) → void` | The same rule at `--continue`: `baseRepoPath(slug)`, `.vendor-sync/.gitignore` and `.vendor-sync/.gitattributes` count as inside too, and a path outside fails 1 with the same message and hint. Calls `stagedPaths`, `baseRepoPath`, `fail`. |
| `finishAction` | `({ root, rel, abs, manifest }) → string` | [The commit at --continue](#the-commit-at---continue), for the action and target of the open marker `manifest.in_progress`: `writeStoredBase(slug, target, path)` returns the new `base_tree`; `writeToolFiles`; `writeManifest(abs, { …manifest, sha: target, base_tree, in_progress: null })` and `git add -- <rel>/.vendor.json`; `commitIndex("vendor-sync: <action> <rel> to <target[0..7]>", rel)`. If any step fails, puts the stored base and the two dotfiles back to `HEAD` in index and working tree (removing them where `HEAD` lacks them), removes `.vendor-sync/base/` and `.vendor-sync/` when that leaves them empty, as `resetScratch` does, puts the manifest's index entry back to `HEAD`, writes the original `manifest` (marker still open) back with `writeManifest`, and rethrows, so `--continue` can run again. On success calls `resetScratch` and returns the commit's oid. Calls `writeStoredBase`, `writeToolFiles`, `writeManifest`, `gitOrFail`, `git`, `literal`, `commitIndex`, `baseRepoPath`, `resetScratch`. |

##### merge.mjs

<!-- FACT-CHECK: True. merge-state.mjs:31-32 (PLAN_NAME, PLAN_VERSION), merge-state.mjs:64-153 (classification, notes, publicFiles), merge-state.mjs:164-187 (plan), merge-state.mjs:356-441 (outcomes, abort, leftovers), decisions.md:763 (D-59): carried over -->
<!-- FACT-CHECK: True. decisions.md:744 (D-58), decisions.md:780 (D-61), decisions.md:788 (D-62): new or changed — MERGE_REFS, describeChanges, noteIds(base), parseMergeTreeOutput, stageMerge, deriveOutcomes from HEAD, leftovers(touched), abortAction; decisions.md:415 (D-30), decisions.md:493 (D-34), decisions.md:719 (D-50), decisions.md:355 (D-27), decisions.md:375 (F-52) for their behavior; decisions.md:798 (D-64): requireNoCollisions, requireResolvedPlan, abortOpenAction, oid and mode; D-65: stageMerge localTree and stagedState, hasPlan, requireResolvedPlan in every state; D-66: deriveOutcomes and publicFiles removed, plan without files -->
| Export | Signature → result | Behavior |
|---|---|---|
| `MERGE_REFS` | `{ base: "refs/vendor-base", local: "refs/vendor-local", upstream: "refs/vendor-upstream" }` | The temporary merge refs of [Refs](#refs). |
| `PLAN_NAME`, `PLAN_VERSION` | `"plan.json"`, `1` | |
| `describeChanges` | `(base: Map \| null, upstream: Map, local: Map) → file[]` | Pure. [The change description](#the-merge) over three blob maps as `treeEntries` and `indexEntries` return them. With a base: iterates the union of base and upstream paths and emits `{ path, upstream_changes, local_changes }` for each path upstream changed. Without one: iterates the upstream paths and emits `{ path, presence }` where the local side lacks the path or holds another blob or mode. Two entries are the same file when oid and mode both agree; sorts by the UTF-8 bytes of `path`. |
| `noteIds` | `(base: string \| null) → string[]` | Pure. `["no_base"]` when `base` is `null`, else `[]`. |
| `parseMergeTreeOutput` | `(stdout: Buffer) → { tree, stageLines: string[], messages: string[] }` | Pure. Splits the `Buffer` on the byte `0x00` and decodes each record separately as UTF-8. Record 0 is the merged tree's oid (anything else fails 2); the records up to the first empty one are stage lines `<mode> <oid> <stage>\t<path>`, each checked against that pattern (a mismatch fails 2); the records after it are messages. Never decodes the whole output as one string. Calls `nulRecords`, `HEX40`, `fail`. |
| `stageMerge` | `({ root, rel, abs, slug, action, base, baseTree, target, upstreamTree, writeMarker, localTree, stagedState }) → void` | The whole of [the merge](#the-merge). `localTree` defaults to `treeOid("HEAD", rel)`; an add's `ready` start passes `EMPTY_TREE_OID`. `stagedState` defaults to `"merge_staged"`; an add's `ready` start passes `"ready"`. **Prefix:** `prefixedTree(baseTree, rel, { omitManifest: true })`, `prefixedTree(localTree, rel, { keepGitlinks: true })`, `prefixedTree(upstreamTree, rel, { omitManifest: true })`. **Name:** `commitTree` of each, `setRef` on the three `MERGE_REFS`. **Merge:** `mergeTree("vendor-base", "vendor-local", "vendor-upstream")`. **Unname:** `deleteRef` on all three in a `finally`. **Parse:** `parseMergeTreeOutput`. **Plan:** `touched` = `diffTreeNames(<prefixed local>, <merged>)` plus the stage-line paths, without the manifest, each with its blob from `indexEntries(rel)` as `local_oid` or `null`, sorted by UTF-8 bytes; `requireNoCollisions` on the paths with `null`, the paths with a blob counting as tracked; `ensureScratch`, then `writePlan` with `{ version, action, base, target, touched }`. **Open:** `writeMarker("merging")`. **Materialize:** `restoreTree(<merged>, [literal(rel), literalExclude("<rel>/.vendor.json")])` — excluding the manifest, which would otherwise be reset to `HEAD`'s version without the marker — then, for `touched` paths that differ only in case and are in the index, `git checkout-index -f` once more. **Conflicts:** for every conflicted path its removal line `0 0000000000000000000000000000000000000000\t<path>` followed by its stage lines, all in one `updateIndexInfo`. **Staged:** `writeMarker(stagedState)`. `writeMarker` is the caller's closure that writes the manifest with the given state (`markerWriter`). Calls `prefixedTree`, `treeOid`, `commitTree`, `setRef`, `mergeTree`, `deleteRef`, `parseMergeTreeOutput`, `diffTreeNames`, `indexEntries`, `requireNoCollisions`, `ensureScratch`, `writePlan`, `restoreTree`, `literal`, `literalExclude`, `gitOrFail`, `updateIndexInfo`. |
| `requireNoCollisions` | `(rel, abs, paths: string[], tracked: Set<string>, root) → void` | [The collision guard](#the-collision-guard). `paths` are the paths the action creates and `tracked` the paths tracked at `HEAD` that it replaces, both relative to `rel`. Reads the directories under `abs` once each and, folding names to lower case when `ignoresCase`, collects every on-disk entry that matches a path or is a non-directory on its parent chain and is not tracked; for a matching directory that holds tracked paths, the files inside it that are not tracked instead. Any collision fails 2 `<rel> holds files upstream would overwrite: <paths>` (sorted) with the hint `move them out of <rel>, then re-run`. Calls `ignoresCase`, `fail`. |
| `writePlan` | `(scratch, plan) → void` | Writes `JSON.stringify(plan, null, 2)` and a newline to `<scratch>/plan.json`. |
| `readPlan` | `(scratch) → plan` | Reads `<scratch>/plan.json` and checks it against the [plan schema](#scratch-and-the-plan): `version` 1, `action`, `base` `null` or 40 hex digits, `target`, `touched` an array of objects with `path` and `local_oid`; any other key, such as the `files` a plan written before D-66 holds, is ignored. Absent, unparseable or invalid fails 2 `scratch is missing: <path>`. Calls `HEX40`, `isPlainObject`, `fail`. |
| `requireResolvedPlan` | `({ root, rel, manifest, marker }) → plan \| null` | The unmerged-files and plan step of `openForContinue`, for either action and every state. `unmergedFiles(rel)` non-empty fails 1 `<n> files in <rel> are still unmerged` with `data.unresolved`. Returns `null` for `pin_ready`, the one state that keeps no plan in scratch. Otherwise: `readPlan(scratchDir(root, slug))`; a plan whose `target` is not the marker's `target_sha` fails 2 `plan.json targets <plan target>, but the open <action> targets <target_sha>` with the hint `discard it with --abort`. Returns the plan. Calls `unmergedFiles`, `readPlan`, `scratchDir`, `fail`. |
| `abortMerge` | `({ root, rel, plan }) → { restored, removed, left }` | [The abort restore](#the-abort-restore) over `plan.touched`, each path passed as `literal("<rel>/<path>")`: `git reset -q --` on all of them; a created path that differs from a restored one only in case is deleted from disk; `git checkout --` on those with a `local_oid`; `git clean -fxq --` on those without, then `rmdir` of each folder on their parent chains, deepest first, best effort, so only the emptied ones go. An empty list skips its command. `restored` and `removed` are the two lists, relative and sorted; `left` comes from `leftovers`. Calls `gitOrFail`, `literal`, `leftovers`. |
| `leftovers` | `({ root, rel, touched }) → string[]` | `untrackedFiles(rel)` without the `touched` paths and without `.vendor.json`: the files under `<dir>` no script wrote, reported in the `aborted` object and never removed. Calls `untrackedFiles`. |
| `abortAction` | `({ root, rel, abs, manifest }) → { restored, removed, left }` | The whole of `--abort` past its checks, for either action: `requireAnyMarker(manifest, rel)`. When the state keeps a plan in scratch (`ready`, `merging`, `merge_staged`): `readPlan(scratchDir(root, slug))` — a missing plan fails 2 with the hint to run `git restore --source=HEAD --staged --worktree -- <rel>` and review the untracked files before deleting any — then `abortMerge`. For `pin_ready`: nothing to restore, `left` from `leftovers` with an empty `touched`. Then for a sync: `writeManifest` with `in_progress: null`. For an add: deletes `<abs>/.vendor.json`, removes `<abs>` when it is empty, `deleteRef(trackingRef(slug))`. Finally `resetScratch`. Calls `requireAnyMarker`, `scratchDir`, `readPlan`, `abortMerge`, `leftovers`, `writeManifest`, `deleteRef`, `trackingRef`, `resetScratch`, `fail`. |
| `openForContinue` | `(dirArg, action, root) → { root, abs, rel, manifest, marker, target, plan }` | The checks of `--continue` of either entry script, in this order: `loadConnection`, `requireMarker(manifest, action, rel)`, `requireNoGitOperation`, `requireResolvedPlan`, `requireNothingStagedForCommit(rel, slug, root)`. Returns the connection, the marker, its `target_sha` as `target`, and the plan (`null` for `pin_ready`). Calls `loadConnection`, `requireMarker`, `requireNoGitOperation`, `requireResolvedPlan`, `requireNothingStagedForCommit`. |
| `abortOpenAction` | `(dirArg, root) → aborted` | `--abort` of either entry script, whatever action is open on `<dir>`: `loadConnection`, `abortAction`; returns [the `aborted` object](#the-aborted-object), `{ state: "aborted", ...identityOf(rel, manifest), restored, removed, left }`. Calls `loadConnection`, `abortAction`, `identityOf`. |

##### Entry scripts

<!-- FACT-CHECK: True. vendor-add.mjs:62-264 (startAdd, upstreamFiles, fetchBranch, pinnedCommit, requireUpstreamDirectory, continueAdd, dispatch), vendor-sync.mjs:51-189 (startSync, mergeBase, continueSync, dispatch), vendor-remove.mjs:22-42, vendor-list.mjs:31-90, decisions.md:744 (D-58), decisions.md:780 (D-61), decisions.md:788 (D-62), decisions.md:798 (D-64) -->
The entry scripts export nothing. Each ends in `run(() => …)` around its argument dispatch: `parseArgvOrFail`; in `add` and `sync`, `resumeMode` with the start's flags (`add`: `ref`, `sha`; `sync`: `base-from-pin`, `without-base`); for a start, or in `remove` and `list`, the script's own count of positionals (and in `sync` the base-flag exclusion) through `usageFailure`; `sync`'s start maps its flags to `baseChoice`: `--without-base` → `"none"`, `--base-from-pin` → `"from_pin"`, neither → `"stored"`. Every argument check fails 1 with the usage as the hint, before the repository is located. Then `add` and `sync` call `requireRepository(process.cwd())`, `remove` and `list` `repoRoot(process.cwd())`, and pass `root` on. `--continue` is `continueAdd` / `continueSync`; `--abort` of either script is `abortOpenAction` from `merge.mjs`. The functions below are internal; their order of calls is the order of [the preconditions](#the-precondition-order) and of each action's section.

| Script · function | Behavior |
|---|---|
| `vendor-add.mjs` · `startAdd(repo, path, dirArg, ref, shaFlag, root)` | `requireAddable`. Then, in a `try` whose `catch` runs `deleteRef(trackingRef(slug))` and rethrows: `fetchBranch`, `pinnedCommit`, `requireUpstreamDirectory`, `skipped_submodules` = `gitlinkPaths(sha, path)`. Both branches call `stageMerge` with `base: null`, `baseTree: EMPTY_TREE_OID`, `upstreamTree: treeOid(sha, path)` and `writeMarker` = `markerWriter(abs, <new manifest>, "add", sha)`, the new manifest's `base_tree` being `treeOid(sha, path)`. A `<dir>` with entries runs `requireCleanDir` (fails 2 `<rel> has uncommitted changes: <paths>`). Then `requireNoGitOperation`, for both branches. An absent or entry-less `<dir>`, or one with nothing committed (`treeOid("HEAD", rel)` null): `startOntoEmpty`; otherwise `startOntoContent`. |
| `vendor-add.mjs` · `requireAddable(dirArg, root) → { abs, rel, slug }` | `normalizeLocalDir`, `requireNoSymlink`, `requireNotNested` (`loadConnection`'s two directory checks with the link check between them); `findVendoredDirs` once, for `requireNoInnerConnection` and `requireSlugUnused`; `requireNoInnerConnection`, `requireSlug`. If `manifestExists`: `loadManifest`, `requireNoOpenAction(manifest, "add")`, else fails 2 `already vendored: <rel>` (hint `use sync to update it`). `requireSlugUnused`, `requireNothingStagedOutside(rel)`; an existing `<dir>` that is not a directory fails 2 `<rel> is not a directory` (hint `choose another directory`). |
| `vendor-add.mjs` · `startOntoEmpty({ root, rel, manifest, merge, skipped_submodules })` | `treeEntries(sha, path)`; `stageMerge` with the start's merge arguments, `localTree: EMPTY_TREE_OID` and `stagedState: "ready"`; returns `ready` with `files` = `upstreamFiles(<those entries>)` and `skipped_submodules`. |
| `vendor-add.mjs` · `startOntoContent({ root, rel, manifest, merge, skipped_submodules })` | `files` = `describeChanges(null, treeEntries(sha, path), indexEntries(rel))`; `stageMerge` with the start's merge arguments; returns `merge_staged` with `files`, `skipped_submodules` and `noteIds(null)`. |
| `vendor-add.mjs` · `upstreamFiles(upstream: Map)` | Pure. The keys of `upstream`, as `treeEntries(sha, path)` returns it, sorted: the `files` of `ready`. |
| `vendor-add.mjs` · `fetchBranch(repo, ref, slug, root)` | `fetchTracking`; when it fails and `listRemoteBranches` returns a non-empty list without `ref`, fails 1 `branch not found on the remote: <ref>` with `data.branches`; otherwise rethrows the fetch failure. |
| `vendor-add.mjs` · `pinnedCommit(shaFlag, ref, slug, root)` | Without `--sha`: `readRef(trackingRef(slug))`. With it: `isWellFormedRev` (fails 1 `not a well-formed revision`), `isAncestor(sha, trackingRef(slug))` (fails 1 `sha is not an ancestor of the tracked branch`), `resolveCommit` to the full oid (fails 1 `not a commit`). |
| `vendor-add.mjs` · `requireUpstreamDirectory(sha, path, root)` | `pathKind(sha, path)`: `null` fails 1 `upstream path absent at <sha>: <path>` with `data.entries` from `siblingListing`; `blob` fails 1 `upstream path is a file, not a directory`. |
| `vendor-add.mjs` · `continueAdd(dirArg, root)` | `openForContinue(dirArg, "add", root)`, `finishAction` (the marker's action and target); returns `added` with `commit` and `files` = `committedPaths(rel)`. |
| `vendor-sync.mjs` · `startSync(dirArg, baseChoice, root)` | `loadConnection`, `requireNoOpenAction(manifest, "sync")`, `requireCleanDir` (fails 2 `<rel> has uncommitted changes: <paths>`), `requireNoGitOperation`, `requireNothingStagedOutside(rel)`, `fetchTracking`; `tip` = `readRef(trackingRef(slug))`; `treeOid(tip, path)` null fails 2 `upstream path absent at <tip>: <path>`. `sha` = `tip` → `up_to_date`. `skipped_submodules` = `gitlinkPaths(tip, path)`. `commits_behind` = `isAncestor` ? `commitsBehind` : `null`. `writeMarker` = `markerWriter(abs, manifest, "sync", tip)`. Equal `treeOid(sha, path)` and `treeOid(tip, path)` → `openPinReady`. `chooseMergeBase`, `describeSync`; empty → `openPinReady`; else `stageMerge` with that `writeMarker`, returning `merge_staged`. |
| `vendor-sync.mjs` · `openPinReady({ id, manifest, tip, commits_behind, skipped_submodules, writeMarker })` | `writeMarker("pin_ready")`; returns `pin_ready`. |
| `vendor-sync.mjs` · `chooseMergeBase(manifest, rel, baseChoice, root) → { base, baseTree }` | `"stored"` → `requireBaseIntact`, `baseTree` = `base_tree`, `base` = `sha`; `"from_pin"` → `commitExists(sha)` (fails 1 `the pinned commit <sha> is not available; choose without_base instead`), `baseTree` = `treeOid(sha, path)`, `base` = `sha`; `"none"` → `baseTree` = `EMPTY_TREE_OID`, `base` = `null`. |
| `vendor-sync.mjs` · `describeSync(manifest, rel, base, baseTree, tip, root)` | `describeChanges(base ? treeEntries(baseTree, "") : null, treeEntries(tip, path), indexEntries(rel))`. |
| `vendor-sync.mjs` · `continueSync(dirArg, root)` | `openForContinue(dirArg, "sync", root)`, `finishAction` (the marker's action and target); returns `synced` with `commit` and `files` = `committedPaths(rel)`. |
| `vendor-remove.mjs` · `remove(dirArg, root)` | `loadConnection`, `requireMarkerClosed`; deletes `<abs>/.vendor.json` and `<root>/.vendor-sync/base/<slug>/` from the working tree; `deleteRef(trackingRef(slug))`; `resetScratch`; returns `removed` with `countFiles(abs)`. No network command, no commit. |
| `vendor-list.mjs` · `assess(rel, root)` | Never throws: everything below runs in a `try` whose `catch` returns `status: "error"` with the message and git's stderr. `parseManifest` of `<rel>/.vendor.json`; an open marker → `in_progress`, without fetching; `fetchTracking`; `upstream_tip` = `readRef(trackingRef(slug))`; `commits_behind` = `isAncestor` ? `commitsBehind` : `null`; `committedBaseTree(slug)` not equal to `base_tree` → `base_missing`, with `local_modifications` `null`; `local_modifications` = `worktreeDiffers(prefixedTree(base_tree, rel), rel)` or an `untrackedFiles(rel)` other than `.vendor.json`; `status` `up_to_date` when `sha` is the tip, else `behind`. The main function maps `assess` over `findVendoredDirs(root)` and returns `listed`. |

### Skill layer

<!-- FACT-CHECK: True. SKILL.md:1-86 (current structure), decisions.md:201 (D-13: fixed verbatim blocks), decisions.md:213 (D-15: wording rules) -->
The skill text is five Markdown files at the root of `.claude/skills/vendor-sync/`. `SKILL.md` holds what applies to every action; one action file per action holds that action's steps. The agent reads `SKILL.md`, then exactly one action file.

#### SKILL.md

<!-- FACT-CHECK: True. SKILL.md:1-9 (front matter: name, description, argument-hint, disable-model-invocation) -->
Front matter: `name: vendor-sync`, a `description` naming what the skill does — vendor an upstream subdirectory and keep it reconciled, with upstream changes resolved by the user in their own merge tool on a conflict state the scripts prepare, and committed by the skill — `argument-hint: "add|sync|remove|list [args]"` and `disable-model-invocation: true`, so the skill runs only when the user invokes it.

Sections:

<!-- FACT-CHECK: True. SKILL.md:13-19 -->
- **What this is** — a vendored directory, its manifest, the four actions in one sentence each.
<!-- FACT-CHECK: True. SKILL.md:21-28, decisions.md:678 (D-45: the scripts commit) -->
- **Who does what** — the agent gathers input, runs one script per step, relays the script's objects and the fixed blocks, and conducts the resolve dialogue; the scripts do every git operation, every write of the vendored directory, the stored base and the manifest, and the commit at `--continue`; the user resolves in their IDE, `git mergetool` or an editor. A fact not in a script's object is not available.
<!-- FACT-CHECK: True. SKILL.md:30-47 (argument gate), decisions.md:733 (D-56) -->
- **Argument gate** — the accepted forms: `add <repo> <path> <dir> [--ref <branch>] [--sha <commit>]`, `add <dir> --abort`, `sync <dir> [--base-from-pin | --without-base]`, `sync <dir> --abort`, `remove <dir>`, `list`. `--continue` is never typed by the user; the action files run it. `--abort`, `--base-from-pin` and `--without-base` are passed only on the user's choice. Proceed only when the user named the action and every required parameter is held. The action is never inferred from the other arguments, even when they fit only one form; when it is not named, the agent asks which one and runs nothing until the user answers (amended 2026-10-26: an agent ran `add` because the given repo, path, ref and sha fit only `add`).
<!-- FACT-CHECK: True. SKILL.md:49-63 -->
- **Script contract** — how to run a script and read its exit code and object, as in [The script contract](#the-script-contract), from the agent's side: on exit 1 correct and re-run, asking the user when the wrong value was theirs and showing `error.data`; on exit 2 report `message`, and `hint` when present, verbatim and stop; quote stderr verbatim beneath the report only when there is any; never mention that a hint or stderr is absent. It also says that an action needs nothing staged outside the vendored directory: a start refuses staged changes elsewhere (exit 2), and `--continue` refuses them (exit 1) until the user commits or unstages them.
<!-- FACT-CHECK: True. SKILL.md:65-82, decisions.md:335 (D-25), decisions.md:678 (D-45), decisions.md:744 (D-58): agent file boundary -->
- **Boundaries** — the agent's rules beyond the contract: resume or abort an action this session did not start only on the user's choice from the open-action block; never run git; never edit `.vendor.json`; never commit — `--continue` commits on the user's word that they are finished; never edit, stage, resolve or delete a file in the vendored directory while an action is open, nor any file under `.vendor-sync/`.
<!-- FACT-CHECK: True. SKILL.md:84-86 -->
- **Dispatch** — read `<action>.md` and follow it; it ends where the agent is finished.

#### Action files

<!-- FACT-CHECK: True. add.md, sync.md, remove.md, list.md (current shape: Inputs, Run, Outcomes per state, Report) -->
Every action file has the same shape: **Inputs**, **Run** (the exact command line), **Outcomes** with one entry per `state` the action's scripts return, each a short numbered list of the agent's steps ending in **Done.**, and **Report**, the template the agent fills. The open-action and base-mismatch blocks sit under **Run**, where the exit 1 that triggers them appears.

<!-- FACT-CHECK: True. add.md:1-152, decisions.md:641 (D-42), decisions.md:678 (D-45), decisions.md:799 (D-64: clean index), decisions.md:805 (D-64: skipped_submodules) -->
- **`add.md`** — Inputs: `<repo>`, `<path>`, `<dir>`, `--ref`, `--sha`. Run: the start; on exit 1 with `choices`, the open-action block; on `resume`, run `--continue` and follow what it returns: an exit 1 with `unresolved` is handled as in `merge_staged`, any other exit 1 as after `ready`. Outcomes:
  - `ready`: show `repo` · `ref` · `path` · `sha` and the `files` the start wrote and staged; print the submodules note when `skipped_submodules` is non-empty; ask the user to review them (`git diff --staged` or the IDE), then to confirm; on yes run `--continue`, on no run `--abort`. On exit 1 from `--continue` — the add is still open, for example because a file in `<dir>` is unmerged or changes are staged outside `<dir>` — show `error.message`, `error.hint` if present and stderr if any, wait, and run `--continue` again when the user says so.
  - `merge_staged`: relay the facts and `files` as a table, print the submodules note when `skipped_submodules` is non-empty, the `no_base` note, and the resolve prompt with `<action>` filled with `add`; wait; when the user is finished run `--continue`. On exit 1 with `unresolved` relay the paths and return to the resolve prompt; on any other exit 1 — the commit failed, or changes are staged outside `<dir>` — show `error.message`, `error.hint` if present and stderr if any and wait.
  - `added`: fill the report.
  - `aborted`: fill the abort report.
<!-- FACT-CHECK: True. sync.md:1-187, decisions.md:689 (D-46), decisions.md:704 (D-48), decisions.md:733 (D-56), decisions.md:773 (D-60), decisions.md:799 (D-64: clean index), decisions.md:805 (D-64: skipped_submodules) -->
- **`sync.md`** — Inputs: `<dir>`. Run: the start; on exit 1 with open-action `choices`, the open-action block, with `resume` as for add; on exit 1 with base-check `choices`, the base-mismatch block that matches them, then re-run with `--base-from-pin` or `--without-base`, or on `leave` stop and report that nothing was written. Outcomes:
  - `up_to_date`: fill the report.
  - `pin_ready`: explain that upstream moved but its files are identical, so only the pinned commit changes; print the submodules note when `skipped_submodules` is non-empty; ask to confirm; on yes run `--continue`, on no run `--abort`; on exit 1 from `--continue`, as after add's `ready`.
  - `merge_staged`: as for add, with `<action>` filled with `sync` and the `no_base` note only when `notes` holds it.
  - `synced`, `aborted`: fill the report.
<!-- FACT-CHECK: True. remove.md:1-44, decisions.md:737 (D-57) -->
- **`remove.md`** — Inputs: `<dir>` and the user's confirmation, asked before running: every file in the directory stays; only `.vendor.json`, the stored base and the upstream tracking go, and vendoring the directory again later starts without a base. Outcome `removed`: fill the report.
<!-- FACT-CHECK: True. list.md:1-53, decisions.md:737 (D-57) -->
- **`list.md`** — Run with no arguments. Outcome `listed`: one table row per connection, `error` quoted beneath its row, one explaining line per status word that appears; when `connections` is `[]`, say that nothing is vendored. This action only reports; it starts nothing else.

<!-- FACT-CHECK: True. sync.md:114-115 ("Interpret nothing; summarize nothing"), decisions.md:156 (D-7), decisions.md:280 (Q-7: answering direct questions is allowed) -->
In every `merge_staged` entry the agent interprets and summarizes nothing, and while waiting answers the user's direct questions; its limits are the SKILL.md boundaries above.

#### Verbatim blocks

<!-- FACT-CHECK: True. decisions.md:213 (D-15: no script internals, no IDE-specific UI), decisions.md:216 (D-16) -->
The agent prints these blocks exactly as written, filling only the `<placeholders>`. They never name script internals such as `--continue`, and never describe IDE-specific UI.

<!-- FACT-CHECK: True. decisions.md:737 (D-57: the drafted resolve prompt), decisions.md:678 (D-45 condition 1: Block 2 must say that finishing commits) -->
**Resolve prompt** — after relaying a `merge_staged` object and its notes, filling `<action>` with the action, `add` or `sync`:

```
Resolve the files in `<dir>` with your IDE, `git mergetool`, or an editor, and review the
staged changes. Tell me when you are finished — I will then continue the <action>.
```

<!-- FACT-CHECK: True. sync.md:39-60 (current block), decisions.md:350 (D-26) -->
**Open action, same action** — on exit 1 with `choices` `["resume", "abort", "leave"]`, filling `<action>` and `<target_sha>` from `error.message`:

```
An unfinished <action> is still open on `<dir>`, started against <target_sha>. There are three options going forward, decide one:

resume    keep the work as it stands and finish the <action> from here.
abort     put `<dir>` back to its last committed state. Files the <action> created are
          deleted; anything else in the directory is left alone.
leave     change nothing. The <action> stays open and `<dir>` stays as it is.

Which one?
```

<!-- FACT-CHECK: True. decisions.md:350 (D-26: "§5.3 needs a two-choice variant of the open-action block"), decisions.md:796 (D-63): written out -->
**Open action, other action or interrupted start** — on exit 1 with `choices` `["abort", "leave"]`, filling `<action>` and `<target_sha>` from `error.message`:

```
An unfinished <action> is still open on `<dir>`, started against <target_sha>. There are two options going forward, decide one:

abort     put `<dir>` back to its last committed state. Files the <action> created are
          deleted; anything else in the directory is left alone.
leave     change nothing. The <action> stays open and `<dir>` stays as it is.

Which one?
```

<!-- FACT-CHECK: True. decisions.md:737 (D-57: the drafted base-mismatch block), decisions.md:733 (D-56), decisions.md:763 (D-59): "a conflict", not "a full conflict", decisions.md:773 (D-60): the leave line, decisions.md:796 (D-63): one block per case -->
**Base mismatch, pinned commit available** — on exit 1 from the base check with `choices` `["base_from_pin", "leave"]`, the first line naming the cause from `error.message`:

```
The stored base for `<dir>` <is missing from your last commit | does not match the pinned upstream commit <sha>>. There are two options going forward, decide one:

base_from_pin   use the pinned commit as the base; it is still available upstream.
leave           change nothing; the sync stops and `<dir>` stays as it is.

Which one?
```

**Base mismatch, pinned commit gone** — on exit 1 from the base check with `choices` `["without_base", "leave"]`:

```
The stored base for `<dir>` <is missing from your last commit | does not match the pinned upstream commit <sha>>.
The pinned commit is no longer available upstream. There are two options going forward, decide one:

without_base    merge without a base: every file both sides have that differs becomes a
                conflict.
leave           change nothing; the sync stops and `<dir>` stays as it is.

Which one?
```

<!-- FACT-CHECK: True. git.mjs:282-294 (gitlinkPaths), vendor-add.mjs:81, vendor-sync.mjs:69 (skipped_submodules), decisions.md:805 (D-64: gitlinks) -->
**Submodules note** — when `skipped_submodules` is non-empty, right after relaying the start object (`ready`, `pin_ready` or `merge_staged`) and before the `no_base` note or the resolve prompt, filling `<paths>` with `skipped_submodules` as a comma-separated list:

```
Note: upstream's submodules are not vendored, so these folders stay absent: <paths>.
```

<!-- FACT-CHECK: True. decisions.md:737 (D-57: the drafted note), decisions.md:506 (F-67: the two consequences to state in the note) -->
**`no_base` note** — when `notes` holds `no_base`, before the resolve prompt:

```
Note: there is no common base. Every file both sides have that differs is a conflict, and
files upstream deleted cannot be detected, so they stay.
```

<!-- FACT-CHECK: True. sync.md:178-198, add.md:174-194 (current reports) -->
<!-- FACT-CHECK: True. decisions.md:744 (D-58), design choice pending the author's confirmation: the `commit` line and the closing sentences replace "These changes are uncommitted — review and commit them", because `--continue` now commits -->
**Reports** — one per action; each sits in the **Report** section of the action file named with it:

*`sync`* — filled from `synced` (after a merge or a pin) or `up_to_date`, in `sync.md`:

```
Synced `<dir>` (connection `<slug>`)
  from      <repo> · branch <ref> · path <path>
  pinned    <sha_before> → <sha_after>
  files     <n> changed
  changes   none: pin only | none: already up to date      (instead of the files line)
  commit    <commit>                                        (omit when already up to date)

The commit is local and not pushed; `git reset HEAD~1` undoes it.
```

*`add`* — filled from `added`, in `add.md`:

```
Vendored `<dir>` (connection `<slug>`)
  from      <repo> · branch <ref> · path <path>
  pinned    <sha>
  files     <n> changed
  commit    <commit>

The commit is local and not pushed; `git reset HEAD~1` undoes it. `remove` drops the connection.
```

*`--abort` of `add` or `sync`* — filled from `aborted`, in both `add.md` and `sync.md`:

```
Aborted the open <action> on `<dir>` (connection `<slug>`)
  restored  <n> files to their last committed state
  removed   <n> files the action had created                (only if any were removed)
  left      <path> …                                        (only if any were left)
```

*`remove`* — filled from `removed`, in `remove.md`:

```
Removed the vendoring connection `<slug>` from `<dir>`.
  retained  <files_retained> files; `.vendor.json` and the stored base deleted

The deletions are uncommitted — review and commit them. Deleting the directory, if wanted, is
your separate step.
```

*`list`* — filled from `listed`, in `list.md`, followed by the status clauses below:

```
| directory | status | pinned → upstream tip | upstream commits touching it | local modifications |
|---|---|---|---|---|
| <dir> | <status> | <pinned_sha> → <upstream_tip> | <commits_behind> | <local_modifications> |
  <error, verbatim — only beneath a row whose status is error>

<status word>: <its clause>        (one line per status word that appears)
```

<!-- FACT-CHECK: True. list.md:17-42 (status clauses), decisions.md:737 (D-57: base_missing meaning) -->
The status clauses: `up_to_date` — the pinned commit is the branch's tip; `behind` — the branch's tip moved past the pinned commit; `base_missing` — the stored base is missing from the last commit or does not match the pinned commit; `in_progress` — an unfinished action is open on it; `error` — the connection could not be assessed.

### Testing

<!-- FACT-CHECK: True. CLAUDE.md (tests/skills mirrors .claude/skills; vendor-sync's own test suite), tests/skills/vendor-sync/_support/fixtures.ts:27-29 (runScript spawns node on the .mjs directly), decisions.md:256 (D-17: throwaway repos, no IDE) -->
The tests live in `tests/skills/vendor-sync/` and run with `npm test`. They need no build: they import the `.mjs` modules directly and spawn the entry scripts with `node`. Every test builds throwaway repositories in a temporary directory; none needs an IDE or the network.

<!-- FACT-CHECK: True. tests/skills/vendor-sync/_support/fixtures.ts:28 (runScript), :112-124 (buildUpstream, buildConsumer), :129-160 (porcelainV2, indexStages, blobOid), :265 (establish), :312 (plantGitOperation) -->
`_support/fixtures.ts` provides the building blocks: `runScript(name, args, cwd)` spawns an entry script and returns its exit code, parsed object and stderr; `buildUpstream` and `buildConsumer` create the two repositories; `establish` brings a consumer to a committed connection; `porcelainV2`, `indexStages` and `blobOid` read back git state; `plantGitOperation` fakes an in-progress merge, rebase, cherry-pick or revert.

<!-- FACT-CHECK: True. decisions.md:744 (D-58), design choice pending the author's confirmation: the test file per module and per action -->
| File | Covers |
|---|---|
| `contract.test.ts` | `contract.mjs`: `run`, `parseArgv`, the output contract |
| `git.test.ts` | `git.mjs` against throwaway repositories, including `requireGitVersion` with a stubbed version string |
| `connection.test.ts` | `connection.mjs`: slug, manifest schema, marker checks, stored-base check, `finishAction` |
| `merge.test.ts` | `merge.mjs`: `describeChanges`, `parseMergeTreeOutput`, `stageMerge` per row of [the merge table](#the-merge), the plan, abort |
| `add.test.ts`, `sync.test.ts`, `remove.test.ts`, `list.test.ts` | each entry script end to end, every state and every error |
| `abort.test.ts` | `--abort` of both actions from every state, from both entry scripts |
| `skill-text.test.ts` | the verbatim blocks and report templates appear in the action files exactly as specified |

<!-- FACT-CHECK: True. decisions.md:84 (F-20), decisions.md:110 (F-25), decisions.md:603 (F-83), decisions.md:605 (F-84), decisions.md:616 (F-87), decisions.md:632 (F-91), decisions.md:256 (D-17: IDE behavior is manual evidence) -->
IDE behavior cannot run in the suite. The design relies on these IntelliJ IDEA 2026.1 properties — the first established by hand on a fabricated conflict state, the second from JetBrains' documentation, the last two by hand on a git merge state; re-check them against a fixture when the supported IDE changes:

<!-- FACT-CHECK: True. decisions.md:84 (F-20) -->
- Unmerged index entries appear under Merge Conflicts with no launcher, and resolving one leaves a staged stage-0 entry.
<!-- FACT-CHECK: True. decisions.md:110 (F-25) -->
- The three-pane merge dialog reads the index stages, not the working file.
<!-- FACT-CHECK: True. decisions.md:603 (F-83) -->
- Resolving only some files leaves the rest listed and the state consistent.
<!-- FACT-CHECK: True. decisions.md:605 (F-84, observation; its conclusion is refuted, the observation stands), decisions.md:678 (D-45) -->
- The commit window ignores the staging area and commits only ticked files — the reason `--continue` commits.

## Acceptance Criteria

<!-- FACT-CHECK: True. CLAUDE.md ("Always run these scripts — never call vitest ... directly"), decisions.md:711 (D-49: where each pre-mortem mitigation lands) -->
Every DoD is a test in `tests/skills/vendor-sync/`, run as `npm test -- tests/skills/vendor-sync/<file> -t "<AC id>"`; each test's name starts with its AC id.

### Persistent state

<!-- FACT-CHECK: True. lib.mjs:200-212, decisions.md:737 (D-57) -->
- AC-1: When a script writes a manifest, it SHALL write exactly the seven fields in the schema's order, two-space indented, with a trailing newline, and the result SHALL validate against the manifest schema.
  DoD: `connection.test.ts` "AC-1" validates written manifests against the schema and compares them byte for byte with the expected serialization.
<!-- FACT-CHECK: True. connection.mjs:147-185, decisions.md:806 (D-64: the manifest is its schema) -->
- AC-2: If a manifest breaks the manifest schema — malformed JSON, a missing or unknown field, a `slug`, `sha` or `base_tree` outside its pattern, or an invalid marker — every script that loads it SHALL exit 2 naming the file and the defect.
  DoD: `connection.test.ts` "AC-2" covers bad JSON, a non-object, each missing, blank or non-string field, a missing `in_progress`, a `slug`, `sha` and `base_tree` outside their patterns, the order of the checks, an unknown `action`, a `state` not allowed for its action, a short `target_sha` and a marker with an extra key.
<!-- FACT-CHECK: True. decisions.md:665 (F-93), decisions.md:667 (D-44) -->
- AC-3: When `--continue` completes, `HEAD` SHALL contain `.vendor-sync/base/<slug>` with tree oid equal to the manifest's `base_tree` and to `<target>:<path>`, plus the two dotfiles with the content [The stored base](#the-stored-base) defines; `git check-attr diff merge linguist-generated` on a base file SHALL report `unset`, `unset`, `set`.
  DoD: `add.test.ts` and `sync.test.ts` "AC-3".
<!-- FACT-CHECK: True. decisions.md:665 (F-93) -->
- AC-4: While an action is open, nothing under `.vendor-sync/scratch/` SHALL be tracked or shown by `git status`.
  DoD: `sync.test.ts` "AC-4": after a `merge_staged` start, `git status --porcelain --untracked-files=all` lists no path under `.vendor-sync/scratch/`.
<!-- FACT-CHECK: True. decisions.md:719 (D-50), decisions.md:516 (D-38) -->
- AC-5: When any start returns, no ref `refs/vendor-base`, `refs/vendor-local` or `refs/vendor-upstream` SHALL exist, on success and on failure, and no ref under `refs/heads/` SHALL have been created.
  DoD: `merge.test.ts` "AC-5" checks `git for-each-ref` after a clean merge, a conflicted merge, a merge whose `merge-tree` call is forced to fail, and a start run over stale refs.

### Contract

<!-- FACT-CHECK: True. lib.mjs:62-100 -->
- AC-6: Every script run SHALL print exactly one JSON object on stdout and exit 0, 1 or 2; on exit 1 or 2 the object SHALL be `{ error: { message, hint?, data? } }`, and stderr SHALL hold only git's output.
  DoD: `contract.test.ts` "AC-6" runs every entry script through a success, an exit-1 and an exit-2 path and parses stdout as one JSON value.
<!-- FACT-CHECK: True. lib.mjs:106-151 -->
- AC-7: If an argument is unknown, a value is missing, a positional is missing or extra, or flags are combined that exclude each other (`--continue` / `--abort` with anything but `<dir>`, `--base-from-pin` with `--without-base`), the script SHALL exit 1 with the usage in `hint` and write nothing.
  DoD: `contract.test.ts` "AC-7" per entry script.

### Preconditions

<!-- FACT-CHECK: True. decisions.md:711 (D-49 (3)), decisions.md:802 (D-64: git 2.40) -->
- AC-8: If git is older than 2.40.0, `add` and `sync` SHALL exit 2 with `vendor-sync needs git 2.40.0 or newer; found <version>` before any other git command that writes.
  DoD: `git.test.ts` "AC-8" feeds `requireGitVersion` the outputs `git version 2.34.1`, `git version 2.39.5` and `git version garbage`, which fail, and `git version 2.40.0` and `git version 2.50.1 (Apple Git-155)`, which pass; `sync.test.ts` "AC-8" runs a start with a `git` shim on `PATH` reporting 2.34.1 and asserts exit 2 and an unchanged repository.
<!-- FACT-CHECK: True. decisions.md:331 (D-24), decisions.md:350 (D-26) -->
- AC-9: When a start finds an open marker, it SHALL exit 1 with `choices` `["resume", "abort", "leave"]` for the same action and `["abort", "leave"]` for the other, even though the directory has uncommitted changes.
  DoD: `sync.test.ts` and `add.test.ts` "AC-9", all four combinations, each over a directory holding merge state.
<!-- FACT-CHECK: True. vendor-sync.mjs:78-84, lib.mjs:760-781, decisions.md:744 (D-58): --continue refuses during another git operation -->
- AC-10: If `<dir>` has uncommitted changes, a `sync` start and an `add` start onto existing content SHALL exit 2 and write nothing; if a merge, cherry-pick, revert or rebase is in progress, every `sync` and `add` start SHALL exit 2 and write nothing; `--continue` SHALL exit 2 while another git operation is in progress.
  DoD: `sync.test.ts` and `add.test.ts` "AC-10" with `plantGitOperation` for each of the five names.
<!-- FACT-CHECK: True. connection.mjs requireNoInnerConnection, decisions.md D-64 (nested manifests, amended 2026-10-24) -->
- AC-39: If `<dir>` contains another connection's directory, an `add` start SHALL exit 2 with `<dir> contains the vendored directory <inner>` and write nothing, also when `<dir>` names the outer directory in another case on a case-insensitive file system; a sibling connection or one that only shares a name prefix with `<dir>` SHALL NOT stop it.
  DoD: `add.test.ts` "AC-39": an inner connection, the same in another case (case-insensitive file system only), a sibling and a name-prefix match.

<!-- FACT-CHECK: True. connection.mjs requireNoSymlink, decisions.md D-64 (nested manifests, amended 2026-10-24: symbolic links) -->
- AC-40: If `<dir>` is a symbolic link, or an existing path component between the repository root and `<dir>` is one, an `add` start SHALL exit 1 with `<component> is a symbolic link`, naming the outermost, and the hint `choose a directory that is not a symbolic link or inside one`, and SHALL write nothing: no manifest in `<dir>` or the link's target, no tracking ref, no scratch, the index unchanged, the link and its target untouched. A sibling directory that is not a link SHALL still start.
  DoD: `add.test.ts` "AC-40": a link to an empty directory, a link to a directory with committed content, a `<dir>` and an absent `<dir>` under a linked ancestor, and a sibling that is not a link; `connection.test.ts` "requireNoSymlink".

### add

<!-- FACT-CHECK: True. vendor-add.mjs:172-187 -->
- AC-11: When `add` targets an absent or empty `<dir>`, the start SHALL write and stage upstream's files, write `<dir>/.vendor.json` with marker `ready` and the plan with every `local_oid` `null`, and return `ready` with the upstream file list.
  DoD: `add.test.ts` "AC-11".
<!-- FACT-CHECK: True. decisions.md:641 (D-42), decisions.md:371 (F-50) -->
- AC-12: When `add --continue` runs on `ready`, `HEAD` SHALL hold every upstream file under `<dir>` with upstream's exact blob and mode — an executable stays `100755`, a symlink stays `120000` with its relative target — and the commit SHALL contain nothing outside `<dir>` and `.vendor-sync/`.
  DoD: `add.test.ts` "AC-12": `git ls-tree -r HEAD -- <dir>` equals `git ls-tree -r <sha>:<path>` (manifest aside); `git show --name-only HEAD` lists only those paths.
<!-- FACT-CHECK: True. decisions.md:502 (D-36), decisions.md:506 (F-67) -->
- AC-13: When `add` targets a directory with committed content, the start SHALL merge with the empty tree as base: every file both sides hold that differs SHALL be unmerged with stages 2 and 3 only, upstream-only files SHALL be staged additions, local-only and identical files SHALL be untouched, and the object SHALL carry `base: null` and `notes: ["no_base"]`.
  DoD: `add.test.ts` "AC-13" asserts `git status --porcelain=v2` lines per file.
<!-- FACT-CHECK: True. vendor-add.mjs:285-321, decisions.md:324 (D-23) -->
- AC-14: When `add --abort` runs, the manifest, the tracking ref, scratch and an empty `<dir>` SHALL be gone, every touched path SHALL be back at `HEAD`, and `git status --porcelain` SHALL list nothing the start wrote.
  DoD: `abort.test.ts` "AC-14" from `ready` and from `merge_staged`; from `ready` also after a user edit, after a rejected `--continue`, with ignored files kept, and after a start that failed with the marker `merging`.

### sync

<!-- FACT-CHECK: True. vendor-sync.mjs:133-151 -->
- AC-15: When the pinned commit is the tip, `sync` SHALL return `up_to_date` and write nothing; when the tip moved but `<path>` is the same tree, it SHALL return `pin_ready` having written only the marker.
  DoD: `sync.test.ts` "AC-15".
<!-- FACT-CHECK: True. decisions.md:689 (D-46), decisions.md:704 (D-48), decisions.md:773 (D-60) -->
- AC-16: If `HEAD` lacks `.vendor-sync/base/<slug>`, or its tree differs from `base_tree`, a `sync` that would merge SHALL exit 1 before writing anything, with the cause in `message` and `choices` `["base_from_pin", "leave"]` when the pinned commit is in the object store, `["without_base", "leave"]` otherwise.
  DoD: `sync.test.ts` "AC-16": base never committed (on disk only), base deleted, base edited, base from another pinned commit; pinned commit removed by rewriting upstream history and `gc --prune=now`.
<!-- FACT-CHECK: True. decisions.md:733 (D-56) -->
- AC-17: When `sync --base-from-pin` runs, the merge base SHALL be `<sha>:<path>` and the start SHALL write nothing outside `<dir>` and scratch beyond what a normal merge start writes; after `--continue` the stored-base check SHALL pass again.
  DoD: `sync.test.ts` "AC-17": a locally edited line and an upstream-edited line elsewhere merge without conflict; `git status` shows no change under `.vendor-sync/base/` after the start; a following start finds the base intact.
<!-- FACT-CHECK: True. decisions.md:502 (D-36), decisions.md:506 (F-67) -->
- AC-18: When `sync --without-base` runs, the merge SHALL use the empty tree as base and the object SHALL carry `base: null`, `files` with `presence`, and `notes: ["no_base"]`.
  DoD: `sync.test.ts` "AC-18".
<!-- FACT-CHECK: True. decisions.md:186 (D-10) -->
- AC-19: While any path under `<dir>` is unmerged, `--continue` SHALL exit 1 with `"<n> files in <dir> are still unmerged"` and the exact paths in `data.unresolved`, and SHALL write nothing; untracked files SHALL NOT count.
  DoD: `sync.test.ts` "AC-19".
<!-- FACT-CHECK: True. vendor-sync.mjs:236-261, decisions.md:350 (D-26) -->
- AC-20: When `sync --abort` runs on an open sync, every touched path SHALL be back at `HEAD`, content and mode, the marker SHALL be cleared and `sha` unchanged; run on an open add, it SHALL behave exactly as `add --abort`.
  DoD: `abort.test.ts` "AC-20", including a `100755` file the user deleted and a `100644` file the user made executable during resolution.

### The merge

<!-- FACT-CHECK: True. decisions.md:459 (F-63), decisions.md:506 (F-67), decisions.md:396 (F-56) -->
- AC-21: When `stageMerge` runs on a fixture for one row of [the merge table](#the-merge), with or without a base, it SHALL produce the index state and working file that row states.
  DoD: `merge.test.ts` "AC-21", one test per row and column, asserting exact `git status --porcelain=v2` lines, index stages and file bytes.
<!-- FACT-CHECK: True. decisions.md:459 (F-63), decisions.md:711 (D-49 (4)), decisions.md:803 (D-64: zdiff3) -->
- AC-22: When two sides change the same line of a file, that path SHALL end unmerged — present in `git ls-files -u` and `UU` in `git status --porcelain=v2` — and its working file SHALL hold zdiff3 markers labeled `vendor-local`, `vendor-base` and `vendor-upstream`.
  DoD: `merge.test.ts` "AC-22"; `parseMergeTreeOutput` is also tested on a captured `-z` output containing two conflicted paths.
<!-- FACT-CHECK: True. decisions.md:408 (F-58), decisions.md:379 (F-54) -->
- AC-23: When a merge start completes, an executable SHALL keep mode `100755` and a symlink SHALL stay a symlink with its relative target, in the index and in the working tree.
  DoD: `merge.test.ts` "AC-23" with `stat` and `readlink`.
<!-- FACT-CHECK: True. decisions.md:479 (F-65), decisions.md:506 (F-67) -->
- AC-24: When upstream turns a file into a directory, or the reverse, and the local side changed it, the start SHALL complete without error, and every path it wrote SHALL be in the plan's `touched`, so `--abort` removes it.
  DoD: `merge.test.ts` "AC-24" for both directions; `abort.test.ts` checks the `<name>~vendor-local` file is gone afterwards.
<!-- FACT-CHECK: True. decisions.md:744 (D-58), design choice pending the author's confirmation: manifest dropped from base and upstream trees -->
- AC-25: If the upstream directory contains its own `.vendor.json`, the merge SHALL leave the local manifest untouched and report no conflict for it.
  DoD: `merge.test.ts` "AC-25".
<!-- FACT-CHECK: True. decisions.md:278 (D-21), decisions.md:322 (F-44) -->
- AC-26: When a start writes the marker `merging`, the plan SHALL already exist and validate against the plan schema, and no file under `<dir>` SHALL have changed yet; every non-null `local_oid` SHALL equal `HEAD`'s blob for that path.
  DoD: `merge.test.ts` "AC-26" wraps `writeMarker` to assert the plan file and `git status --porcelain -- <dir>` at the moment it is called with `"merging"`.
<!-- FACT-CHECK: True. decisions.md:780 (D-61) -->
- AC-37: If a merge start fails after it wrote the marker `merging`, the manifest SHALL keep that marker; a later start SHALL exit 1 with `choices` `["abort", "leave"]`; `--continue` SHALL exit 2; and `--abort` SHALL leave `git status --porcelain -- <dir>` showing nothing the start wrote.
  DoD: `merge.test.ts` "AC-37" makes the Conflicts step fail (a `git` shim on `PATH` that fails `update-index --index-info`) and runs all three calls.
<!-- FACT-CHECK: True. merge.mjs:253-293 (requireNoCollisions), decisions.md:808 (D-64: collision guard) -->
- AC-38: If an untracked or ignored file sits under `<dir>` at a path an action would create, or as a non-directory on that path's parent chain, the merge start and the `add` start into a `<dir>` with nothing committed SHALL exit 2 with `<dir> holds files upstream would overwrite: <paths>` and the hint `move them out of <dir>, then re-run`, and SHALL write nothing.
  DoD: `merge.test.ts`, `add.test.ts` and `sync.test.ts` "AC-38": an ignored file at an upstream-added path, on its parent chain and at a `~vendor-local` side name, `core.ignorecase` on and off, and the merge start of both actions.

### The commit

<!-- FACT-CHECK: True. decisions.md:678 (D-45) -->
- AC-27: When `--continue` succeeds, it SHALL make exactly one commit with one parent and the message `vendor-sync: <action> <dir> to <first 7 characters of target>`, containing the merge result, the stored base, the two dotfiles and the closed manifest, and nothing else; the marker SHALL be `null` and scratch gone.
  DoD: `sync.test.ts` and `add.test.ts` "AC-27": `git rev-list --count` grew by one, `git log -1 --format=%P` has one oid, `git show --name-only HEAD` lists only those paths.
<!-- FACT-CHECK: True. decisions.md:678 (D-45, condition 2), decisions.md:799 (D-64: clean index) -->
- AC-28: If the user has staged a change outside `<dir>` and the tool's paths, `--continue` SHALL exit 1 with `staged changes outside <dir>: <paths>` and the hint `commit or unstage them, then re-run`, and change nothing; once it is unstaged, `--continue` SHALL commit without it, and untracked files inside `<dir>` SHALL stay untracked and out of the commit.
  DoD: `sync.test.ts` "AC-28" with a staged `other.txt` and an untracked `<dir>/a.md.orig`.
<!-- FACT-CHECK: True. decisions.md:678 (D-45, condition 3), decisions.md:737 (D-57), decisions.md:744 (D-58), decisions.md:801 (D-64: accepted cost) -->
- AC-29: If the commit fails, `--continue` SHALL exit 1 with git's output on stderr, leave the marker open and the working tree as it was — an unstaged edit inside `<dir>` that the commit staged stays staged, with the same content — and a re-run after the cause is fixed SHALL succeed.
  DoD: `sync.test.ts` "AC-29" with a `pre-commit` hook that fails once, and once more after an unstaged edit inside `<dir>`.
<!-- FACT-CHECK: True. decisions.md:275 (D-20), decisions.md:744 (D-58) -->
- AC-30: The `synced` and `added` objects SHALL report in `files` exactly the paths under `<dir>`, `.vendor.json` aside, that the new commit changed, relative to `<dir>` and sorted, and no `outcome`.
  DoD: `sync.test.ts` "AC-30": four files resolved four ways plus one change both sides made identically list only the three the commit changed; a file outside the plan edited before `--continue` is listed; a mode-only upstream change merged with a local edit is listed; "AC-15 AC-30" a `pin_ready` with no edits gives `[]`; `add.test.ts` "AC-30 (add)": a written file deleted before `--continue` is not listed; `git.test.ts` "committedPaths".

### The abort

<!-- FACT-CHECK: True. decisions.md:355 (D-27), decisions.md:343 (F-47), decisions.md:324 (D-23) -->
- AC-31: `--abort` SHALL touch only the plan's `touched` paths: an ignored file, a local-only file and a merge tool's `*.orig` backup under `<dir>`, and any path outside `<dir>`, SHALL be unchanged, and untracked ones SHALL be listed in `left`.
  DoD: `abort.test.ts` "AC-31".
<!-- FACT-CHECK: True. merge-state.mjs:423-441 -->
- AC-32: If the plan is missing or invalid, `--abort` SHALL exit 2 with the `git restore` recovery hint and write nothing; the hint SHALL NOT contain `git clean`.
  DoD: `abort.test.ts` "AC-32".

### remove and list

<!-- FACT-CHECK: True. vendor-remove.mjs:27-48, decisions.md:737 (D-57) -->
- AC-33: When `remove` runs on a closed connection, it SHALL delete the manifest, `.vendor-sync/base/<slug>/`, the tracking ref and scratch, keep every other file, run no network command and make no commit; with an open action it SHALL exit 2.
  DoD: `remove.test.ts` "AC-33", with the consumer's remote URL pointing at a path that does not exist.
<!-- FACT-CHECK: True. vendor-list.mjs:33-84, decisions.md:737 (D-57), decisions.md:744 (D-58) -->
- AC-34: `list` SHALL report every connection with the stated fields and exit 0 even when one connection's manifest is malformed or its remote unreachable; `status` SHALL be `base_missing` when the stored base fails the check, and `local_modifications` SHALL count a tracked working-tree difference from the stored base or any untracked file under `<dir>`, manifest excluded.
  DoD: `list.test.ts` "AC-34" with one connection per status.

### Skill text

<!-- FACT-CHECK: True. decisions.md:216 (D-16), decisions.md:285 (D-22), decisions.md:744 (D-58): report wording -->
- AC-35: Every verbatim block and report template in [Verbatim blocks](#verbatim-blocks) SHALL appear byte for byte in the action file that uses it, and the report of every action that commits SHALL say the commit is local and not pushed.
  DoD: `skill-text.test.ts` "AC-35" takes every fenced block under the spec's Verbatim blocks heading, treats a `<…|…>` placeholder as a set of alternatives that must each appear, and asserts each block's text occurs byte for byte in the action file that uses it.
<!-- FACT-CHECK: True. decisions.md:733 (D-56), decisions.md:678 (D-45) -->
- AC-36: `SKILL.md`'s argument gate SHALL list exactly the forms in [SKILL.md](#skillmd), and its boundaries SHALL state that the agent never commits and that `--continue` commits on the user's word.
  DoD: `skill-text.test.ts` "AC-36".

## Boundaries

<!-- FACT-CHECK: True. decisions.md:42 (F-8), decisions.md:678 (D-45), decisions.md:711 (D-49), decisions.md:719 (D-50), decisions.md:324 (D-23), decisions.md:516 (D-38), decisions.md:667 (D-44), decisions.md:641 (D-42), decisions.md:744 (D-58): the ASK FIRST rules -->
- **ALWAYS** keep the write order of a merge start: plan, marker `merging`, files, marker `merge_staged` ([The merge](#the-merge)).
- **ALWAYS** read `merge-tree -z` output as bytes ([The merge](#the-merge), Parse).
- **ALWAYS** delete the temporary refs on every exit path ([Refs](#refs)).
- **ALWAYS** let git write the vendored files and the stored base; the scripts write only the manifest, the two `.vendor-sync/` dotfiles and the plan themselves ([The merge](#the-merge), [The commit](#the-commit-at---continue)).
- **ALWAYS** name exact paths in commands that change the index or working tree; never a repository-wide command.
- **ALWAYS** make every pathspec passed to git a literal one, `:(literal)<path>`; the one exclude is `:(exclude,literal)<dir>/.vendor.json` ([git.mjs](#gitmjs)).
- **ASK FIRST** before changing the manifest schema, the plan schema, a verbatim block, a report template, an object field or an exit code: the agent and the tests depend on them verbatim.
- **ASK FIRST** when a git command behaves differently on a supported git version from what this spec states.
- **NEVER** merge on git older than 2.40.0 ([The precondition order](#the-precondition-order)).
- **NEVER** commit outside `--continue`, commit other paths than the tool's, bypass hooks, or push ([The commit](#the-commit-at---continue)).
- **NEVER** touch, on `--abort`, anything but the plan's `touched` paths, the manifest, scratch, and — after an add — the tracking ref and an empty `<dir>` ([The abort restore](#the-abort-restore)).
- **NEVER** create a branch, a tag, or a ref other than the tracking ref and the temporary merge refs ([Refs](#refs)).
- **NEVER** write the project's root `.gitignore` or `.gitattributes` ([The stored base](#the-stored-base)).
- **NEVER** let the agent run git, edit `.vendor.json`, edit, stage or resolve a file under `<dir>` while an action is open, or touch `.vendor-sync/` ([SKILL.md](#skillmd)).

## Out of Scope

<!-- FACT-CHECK: True. decisions.md:497 (D-35), decisions.md:92 (D-2: launchers rejected), decisions.md:530 (F-73: no outward-facing writes) -->
- Reviewing every upstream change individually in the merge tool, collision or not: upstream changes that do not collide with local ones are merged and staged.
- IDE-specific launchers or integrations; the conflict state is plain git.
- Pushing, tagging, or any write to a remote.
