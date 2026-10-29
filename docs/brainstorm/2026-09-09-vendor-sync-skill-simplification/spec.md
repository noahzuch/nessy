# vendor-sync — Simplified Skill and Script Contract

> **Decision Journal:** Rationale, rejected alternatives, and implicit knowledge
> are documented in `decisions.md` (same directory).
> On ambiguity: **check there FIRST** before choosing your own interpretation.
>
> **Predecessor:** `docs/brainstorm/2026-09-08-vendored-skill-sync-tooling/spec.md` is the original
> design. This specification replaces its script contract, verb set, flows and skill-file structure
> in full. Where this document is silent, the predecessor does **not** fill the gap — the silence is
> deliberate simplification. The merge procedures' substance (§6) is carried forward from it.

## Goal

Rewrite the `vendor-sync` skill so that an agent reading it knows exactly what to do at every point,
with nothing to infer from script internals or from a design document. Four scripts, one per action,
each called once to start and — where something is written — once more to `--continue`. Every
script prints one JSON object whose `state` names the situation; every action file has the same
skeleton and every decision the same shape; every entry ends where the agent is finished. The
special cases that made the first draft convoluted (a warning nobody acts on, an orphan ref that
needs a cleanup step, an export form and an adopt mode that exist for one path, nine exit codes) are
removed at the source rather than documented better.

## Context

The first implementation (branch `vendor-sync-skill`) works — 240 tests, seven scripts — but its
seven markdown files (764 lines) are hard for an agent to follow: exit-code tables are repeated per
call site and drift; decisions live in table cells, in headed sections and in inline prose without a
convention; the agent must hand-carry shas and temp paths across three or four script calls with a
paragraph of doctrine per carried value; and the schemas of the JSON the agent itself must write are
given as one example each.

Nothing is vendored yet (no `.vendor.json`, no `refs/vendor/*` in the repository), so the manifest
format, ref names, exit codes and stdout shape may change freely.

The rewrite is built against a fixed practice set (journal F-14, F-15): three-level progressive
disclosure organised by action; imperative voice; output formats as fill-in templates; the *why*
stated once and concisely beside the rule it justifies, never re-argued; completeness — every case
the agent can meet has a documented handling; explicit, structural termination; no half-knowledge.
No eval loop; the practices are the deliverable. No new research was needed: every git-behaviour
fact rests on the predecessor's verified facts (journal D-4), and mechanics carried forward
unchanged — slug derivation, canonical serialization, frontmatter, the completeness gate,
`commits_behind` semantics, tracking-ref cleanup — are listed in journal F-18.

## Design

### 1. Overview

```
skill (markdown)                          scripts (node .mjs)
────────────────                          ───────────────────
SKILL.md   gate · contract · dispatch     vendor-add.mjs     <repo> <path> <dir> [--ref] [--sha] | <dir> --continue
add.md     ─────────────────────────────▶ vendor-sync.mjs    <dir> | <dir> --continue
sync.md    ─────────────────────────────▶ vendor-remove.mjs  <dir>
remove.md  ─────────────────────────────▶ vendor-list.mjs
list.md    ─────────────────────────────▶ lib.mjs            shared helpers (no entry point)
merge-with-base.md      entered only from a `merge_needed` outcome
merge-without-base.md   entered only from a `base_missing` / add `merge_needed` outcome
```

The flow of every writing action is **start → decide → `--continue`**: the start call reads,
fetches, prepares scratch material and sets a marker, but never touches the user's files; the agent
shows the user what will happen (or performs the merge); `--continue` performs every write. A start
call that finds nothing to do (`up_to_date`) is complete in one call.

### 2. On-disk state

**Manifest** — `<dir>/.vendor.json`, tracked in git, canonical serialization (two-space indent, keys
in this order, trailing newline — F-18):

```json
{
  "slug": "skills-brainstorm",
  "repo": "https://github.com/org/repo.git",
  "path": "plugins/brainstorm/skills/brainstorm",
  "ref": "main",
  "sha": "a1b2c3d…",
  "in_progress": null
}
```

`in_progress` is `null` except between a start and its `--continue`, when it is
`{ "action": "add" | "sync", "state": "<the state start returned>", "target_sha": "<sha>" }`.
`sha` is the merge base: the upstream commit the local copy was last reconciled against. During an
`add`, `sha` equals `target_sha` until `--continue` confirms it.

**Refs** — two per connection, invisible to the agent:
- `refs/vendor/<slug>` — tracking ref; every start fetches `+refs/heads/<ref>` into it. It moves.
- `refs/vendor/<slug>-base` — anchors the base commit against GC after an upstream history
  rewrite. Created at `add --continue`, moved at every `sync --continue`, always equal to `sha`.
  Per-clone protection only; see journal F-17, D-11.

**Slug** — derived from the repo-relative directory path: `/` → `-`, any character outside
`[A-Za-z0-9_-]` → `-`, runs of `-` collapsed, leading/trailing `-`/`.` stripped. Must pass
`git check-ref-format refs/vendor/<slug>`; otherwise exit 1 with the hint to rename the directory
(F-18; the name is the user's input, so it is correctable — D-15).

**Scratch** — `.vendor-sync/<slug>/` at the repository root, holding during an open merge:

| Path | Written by | Content |
|---|---|---|
| `.vendor-sync/.gitignore` | every start | the single line `*` — the folder ignores itself |
| `upstream/` | add start, sync start (all but `up_to_date`, `pin_ready`) | upstream tree at `target_sha` |
| `base/` | sync start, `merge_needed` | upstream tree at the current `sha` |
| `local.diff` | sync start, `merge_needed` | base tree vs. the vendored directory |
| `upstream.diff` | sync start, `merge_needed` | base tree vs. upstream tree |
| `groups-local.json`, `groups-upstream.json` | the agent, with-base merge | §6.3 |
| `inventory.json` | the agent, without-base merge | §6.3 |

Start removes `.vendor-sync/<slug>/` entirely before writing (it only reaches this point when no
marker is open, so the leftovers always belong to a merge nobody can resume). `--continue` removes
it on success. Diff headers are rewritten to `a/<file>` / `b/<file>` **relative to the vendored
directory**; `.vendor.json` never appears in a diff.

### 3. Universal script contract

- Invocation: `node <skill-dir>/scripts/vendor-<action>.mjs …`, from any cwd inside the repository.
  `<dir>` is resolved against the repository root and must lie inside it.
- **stdout is exactly one JSON object, on every run.** Nothing else is ever written to stdout.
- **Exit 0** — the script ran. The object has `state` and the fields listed for that state.
- **Exit 1** — recoverable. The object is `{ "error": { "message", "hint"?, "data"? } }`. The input
  was wrong (the agent's call, or a value the user supplied); correct it and re-run. `data` carries
  what the correction needs (a branch list, a directory listing).
- **Exit 2** — stop. Same object shape. The agent reports `message` and `hint` to the user and takes
  no further action in this invocation. `hint` is information for the user (what the situation is,
  what would resolve it), never an instruction the agent acts on.
- stderr carries only git's own output, when a git command failed; the agent quotes it verbatim.
- A directory whose manifest has an open marker accepts only `--continue` of the recorded action.
  Every other `add`, `sync` or `remove` call on it exits 2 (§3.1); `list` reports it as
  `status: "in_progress"`.
- Scripts state facts and write files; they never talk to the user and never decide a merge.

#### 3.1 Error catalogue

| Condition | Exit | `data` | Emitted by |
|---|---|---|---|
| wrong arity, unknown flag, missing flag value | 1 | — | all |
| `<dir>` outside the repository | 1 | — | add, sync, remove |
| unsluggable directory name | 1 | — | add |
| branch `<ref>` absent on the remote | 1 | `branches: [...]` from `ls-remote --heads` | add |
| upstream path absent at the commit, or a file | 1 | `entries: [...]` at the parent level | add |
| `--sha` not an ancestor of the tracked branch (or not a well-formed revision) | 1 | — | add |
| not inside a git repository | 2 | — | all |
| fetch failed (auth, network, unreachable) | 2 | — | add, sync, list (per connection) |
| `git archive` / `tar` / `diff` / `update-ref` failed | 2 | — | add, sync |
| already vendored (`<dir>` has a manifest) — hint: `sync` | 2 | — | add |
| not a vendored directory — hint: `add` | 2 | — | sync, remove |
| manifest malformed or missing a field — never repaired | 2 | — | sync, remove |
| `<dir>` has uncommitted changes (incl. untracked files; an untracked directory counts) | 2 | — | add (non-empty dir), sync |
| an unfinished `<action>` is open, started against `<target_sha>` — hint: to discard it, revert the directory in git, manifest included; a directory a fresh `add` created holds only the manifest — delete it | 2 | — | add, sync, remove |
| `--continue` with no open marker, or a marker of the other action | 2 | — | add, sync |
| `--continue` with an incomplete merge artifact (§6.4) | 2 | — | add, sync |

### 4. The four scripts

#### 4.1 `vendor-add`

**Start** — `vendor-add <repo> <path> <dir> [--ref <branch>] [--sha <commit>]`, `--ref` defaults
to `main`. Steps: resolve `<dir>`, derive slug, refuse a directory that has a manifest (D-29); fetch the branch into
the tracking ref; resolve the commit (tip, or `--sha` checked for ancestry); verify `<path>` is a
directory at that commit; if `<dir>` has content, require it clean; wipe and rebuild scratch with the
upstream tree; write the manifest with the marker **last**.

| `state` | When | Fields |
|---|---|---|
| `ready` | `<dir>` was empty or absent (now holds only the manifest) | `dir slug repo path ref sha files scratch` |
| `merge_needed` | `<dir>` has committed content | `dir slug repo path ref sha files scratch entries` |

`files` is the list of upstream files at `sha`, relative to the directory; `entries` the top-level
names already in `<dir>`; `scratch` the absolute path of `.vendor-sync/<slug>/`.

**Continue** — `vendor-add <dir> --continue`. Requires `in_progress.action == "add"`. For state
`ready`: extract `scratch/upstream/` into `<dir>`. For state `merge_needed`: gate on
`scratch/inventory.json` (§6.4); the directory's files are the agent's authored result and are kept.
Then set `in_progress: null`, create `refs/vendor/<slug>-base` at `sha`, remove scratch.

| `state` | Fields |
|---|---|
| `added` | `dir slug repo path ref sha files decisions` |

`decisions` is present after `merge_needed`: the `outcomes` of `inventory.json`, read before scratch
is removed. On any non-zero exit of a start that created the tracking ref, the ref is deleted again
(F-18); a ref left behind by a discarded start is not a connection and is overwritten by the next
fetch (D-29).

#### 4.2 `vendor-sync`

**Start** — `vendor-sync <dir>`. Steps: load the manifest (marker open → exit 2); require a clean
directory (exit 2 before any network or write); fetch; check the base commit resolves; compute whether upstream's tree at `<path>`
differs between `sha` and the tip, and whether the directory differs from the base tree; wipe and
rebuild scratch as the state needs; write the marker last.

| `state` | When | Writes to scratch | Fields |
|---|---|---|---|
| `up_to_date` | `sha` is the tip | nothing; **no marker** | `dir slug repo path ref sha` |
| `pin_ready` | upstream's tree at `<path>` unchanged, tip moved | nothing | identity + `sha_before sha_after commits_behind` |
| `update_ready` | upstream changed, directory equals base | `upstream/` | identity + `sha_before sha_after commits_behind files` |
| `merge_needed` | upstream changed and directory differs from base | `upstream/ base/ local.diff upstream.diff` | identity + `sha_before sha_after commits_behind base_is_ancestor_of_tip scratch` |
| `base_missing` | `sha` does not resolve to a commit object | `upstream/` | identity + `sha_before sha_after scratch` |

"identity" is `dir slug repo path ref` — present in every state so the agent can show the user what
will be written without another source.

`files` (in `update_ready`) lists the files that `--continue` will add, change or delete.
`commits_behind` is `null` when `base_is_ancestor_of_tip` is false (upstream rewrote history; the
base is still usable, the count is meaningless — F-18).

**Continue** — `vendor-sync <dir> --continue`. Requires `in_progress.action == "sync"`. By recorded
state: `pin_ready` → nothing to copy; `update_ready` → delete everything in `<dir>` except
`.vendor.json`, extract `scratch/upstream/`; `merge_needed` → gate on `groups-upstream.json`;
`base_missing` → gate on `inventory.json`. Then pin: `sha = target_sha`, `in_progress: null`, move
the base ref, remove scratch.

| `state` | Fields |
|---|---|
| `synced` | identity + `sha_before sha_after files decisions` |

`decisions` is present after `merge_needed` (the `name`, `decision`, `reason` of every group in
`groups-upstream.json`) and after `base_missing` (the `outcomes` of `inventory.json`), read before
scratch is removed, so the report is filled from the object alone.

#### 4.3 `vendor-remove`

`vendor-remove <dir>` — one call, no network. Marker open → exit 2. Deletes the manifest, both
refs and any scratch for the slug; every other file in the directory is retained.

| `state` | Fields |
|---|---|
| `removed` | `dir slug files_retained` |

#### 4.4 `vendor-list`

`vendor-list` — no arguments. Walks the repository (skipping `.git`, `node_modules`,
`.vendor-sync`) for `.vendor.json`, fetches each connection and assesses it read-only, writing
nothing to the working tree, to any manifest or to scratch (its fetches move the tracking refs, as
every fetch does). A connection whose assessment fails is reported inline; it never hides the
others.

```json
{ "state": "listed",
  "connections": [
    { "dir": "…", "slug": "…", "repo": "…", "ref": "…", "pinned_sha": "…", "upstream_tip": "…",
      "status": "up_to_date" | "behind" | "base_missing" | "in_progress" | "error",
      "local_modifications": true, "commits_behind": 3, "error": "…" } ] }
```

Exit 0 whenever the walk ran. (No exit 10.)

### 5. The skill files

#### 5.1 `SKILL.md` (~60 lines)

Frontmatter: `name: vendor-sync`, a description saying what it does and when to use it,
`argument-hint: "add|sync|remove|list [args]"`, `disable-model-invocation: true` (F-18). Body, in order:

1. **What this is** — three sentences: vendored directory, manifest, the four actions.
2. **Who does what** — the agent gathers input, dispatches, relays results, and performs the merge
   dialogue; the scripts do every git operation and every file write. The skill runs no git command
   itself (D-27): every fact it needs is in a script's object, and a fact that is not there is not
   available.
3. **Argument gate** — arity per action; proceed only when the action is certain and every required
   parameter is held; never infer the action from the argument shape (F-18).
4. **Script contract** — §3 in agent-facing form: one JSON object; exit 0 → `state`; exit 1 → fix
   the input and re-run (ask the user if it was theirs, showing `data`); exit 2 → report `message`
   and `hint`, stop. Quote git's stderr verbatim.
5. **Boundaries** — the ALWAYS / ASK FIRST / NEVER rules of this spec's Boundaries section that
   apply to every action, each with its one-line reason.
6. **Dispatch** — "Read `<action>.md` and follow it. It ends where you are finished."

`SKILL.md` names no state and no action-specific step.

#### 5.2 Action files — one skeleton

```markdown
# <action>
One sentence: what this action does.

## Inputs
What must be held before running (from the gate); defaults.

## Run
node scripts/vendor-<action>.mjs <args>          ← exactly one command

## Outcomes
Branch on `state`. Each entry ends where you are finished.

### `<state>`
One sentence: what the script found and what it did.
1. …
2. Run `node scripts/vendor-<action>.mjs <dir> --continue`.
3. Report (below). **Done.**

## Report
Fill-in template.
```

Rules: an Outcome is always a `###` heading with steps beneath; the last line is **Done.**; the
fields of the object are explained inside the entry that uses them; no other action is mentioned (a
script `hint` naming one is relayed, not explained); no error table — errors are handled by
`SKILL.md`'s contract section.

**`add.md`** — Inputs: repo, upstream path, destination, branch (default `main`) or commit. Outcomes:
`ready` (show repo · branch · path · sha · file list; on the user's confirmation `--continue`; report;
Done) · `merge_needed` (show the same plus the existing entries; read `merge-without-base.md`; on
return `--continue`; report; Done) · `added` (the `--continue` result: fill the report). Report:
directory and slug, repo/branch/path, pinned sha, file count, "uncommitted — review and commit; to
undo, run `remove` and revert the directory in git (or delete it, if `add` created it)".

**`sync.md`** — Inputs: directory. Outcomes: `up_to_date` (report; Done) · `pin_ready` (explain: same
content, newer commit; confirm; `--continue`; report; Done) · `update_ready` (show `files`; confirm;
`--continue`; report; Done) · `merge_needed` (read `merge-with-base.md`; on return `--continue`;
report; Done) · `base_missing` (explain: the pinned commit no longer exists upstream, only two
versions can be compared; read `merge-without-base.md`; on return `--continue`; report; Done) ·
`synced` (fill the report). Report: directory and slug, `sha_before → sha_after`, adopted and declined
upstream changes with reasons (from `decisions` in the `synced` object; none for `pin_ready` and
`update_ready`), "uncommitted — review and commit".

**`remove.md`** — Confirm (files are retained, only the connection goes, re-adding later starts from a
fresh base); Run; `removed` (report; Done). Report: directory, slug, files retained, "deleting the
directory is your separate step".

**`list.md`** — Run; `listed` (one line per connection: dir, status, pinned → tip, commits behind,
local modifications; connections with `error` quoted; Done). This action never starts a sync.

#### 5.3 Merge files — entry and exit contract

Both files open with: "You arrive here from an Outcome entry; `scratch` holds … . When you finish,
return to that entry and run its `--continue`." They never know which action sent them. Both end
with the six-line shared block (§6.5). Rationale is one clause per rule.

### 6. Merge procedures

The substance is the predecessor's (journal D-19); only entry/exit, the script's contribution and the
writing change.

#### 6.1 `merge-with-base.md` — three versions, attribution is a fact

You have `scratch/base/`, `scratch/upstream/`, `scratch/local.diff`, `scratch/upstream.diff`, paths
already relative to the directory.

1. **Identify local intent.** Group `local.diff` into named local changes and write
   `scratch/groups-local.json`. Totality: every hunk in exactly one group or in `unassigned`, and
   `unassigned` empty before step 2 — check by counting `@@` headers against hunk entries. Present
   each group *with* the hunks its deduction rests on; ask the user only to correct wrong
   deductions. These are decisions the user already made: they keep standing and are not
   re-approved (`decision` stays `null`). A purpose that cannot be deduced is asked, never guessed.
2. **Judge upstream changes.** Same grouping for `upstream.diff` → `scratch/groups-upstream.json`.
   For each: what it does, why upstream did it, which local intent it touches, a recommendation
   grounded in step 1 (local intent is the criterion an upstream change is judged by, which is why
   it comes first). Every change gets an explicit `adopt` / `decline` with a `reason` — no default
   adoption, so the user sees everything that comes in.
3. **Author.** Only when every decision is recorded: apply adopted changes to the directory,
   verbatim from `upstream.diff`. Declines need no record — a declined change reappears as a local
   modification at the next sync and is identified there like any other.
4. Return to the entry that sent you; run `--continue`.

#### 6.2 `merge-without-base.md` — two versions, attribution is impossible

You have `scratch/upstream/` and the directory. Without a base a difference cannot be attributed to
a side, and a diff of two diverged versions is noise — read both whole.

1. **Inventory** named ideas per side with the span expressing each → `scratch/inventory.json`.
   Totality: every part of both versions claimed by an item or listed in `unclaimed`; `unclaimed`
   emptied by resolving each entry; no overlapping spans on one side.
2. **Decide** keep / drop / combine per item with the user → `outcomes`.
3. **Author** near-verbatim from the recorded spans; list every place new connective wording was
   needed and record each as a `combine` with its reason.
4. **Review**: present the complete result; write files only on approval — verbatim assembly cannot
   be checked mechanically here, so the review is the control.
5. Return to the entry that sent you; run `--continue`.

#### 6.3 Artifact schemas

Each is documented in its merge file as a field table plus one example.

`groups-local.json` / `groups-upstream.json`:

| Field | Type | Meaning |
|---|---|---|
| `side` | `"local"` \| `"upstream"` | which diff was grouped |
| `groups[].id` | string | `L1…` / `U1…` |
| `groups[].name` | string | short name of the change |
| `groups[].what` | string | what the change does |
| `groups[].why` | string | deduced intent (local) / deduced reason (upstream) |
| `groups[].hunks[]` | `{ file, start, end }` | file relative to the directory; line range in the *new* side |
| `groups[].decision` | `null` \| `"adopt"` \| `"decline"` | always `null` on the local side; set for every upstream group before `--continue` |
| `groups[].reason` | string | required when `decision` is set |
| `unassigned[]` | `{ file, start, end }` | hunks not yet grouped; must be `[]` before proceeding |

`inventory.json`:

| Field | Type | Meaning |
|---|---|---|
| `sides.local[]`, `sides.upstream[]` | `{ id, name, span: { file, start, end } }` | one named idea and the verbatim span that expresses it |
| `unclaimed[]` | `{ side, file, start, end }` | text not yet claimed; must be `[]` before authoring |
| `outcomes[]` | `{ ids: [...], outcome: "keep" \| "drop" \| "combine", reason }` | one per decision; `combine` requires `reason` |

#### 6.4 The `--continue` gate

`--continue` exits 2 unless the recorded state's artifact is complete:

- `merge_needed` (sync): `scratch/groups-upstream.json` exists, `unassigned` is `[]`, every group
  has a non-null `decision`.
- `base_missing` (sync) and `merge_needed` (add): `scratch/inventory.json` exists, `unclaimed` is
  `[]`, `outcomes` is non-empty.
- `ready`, `pin_ready`, `update_ready`: no artifact, no gate.

The gate turns "the agent says it finished" into "the record on disk is complete". It does not, and
cannot, verify that the authored files match the decisions.

#### 6.5 Shared block (both merge files, ~6 lines)

Preserve the wording of both sources; rewrite only where two changes genuinely have to be combined,
and say where — every unrequested improvement diffs against upstream forever and buries the real
local modifications. Never `git apply`, three-way merge or any mechanical merge, not even as a first
pass: it aborts atomically on one unpatchable file, and it can exit 0 having silently mismerged.

### 7. Testing

Keep the fixture infrastructure (`tests/skills/vendor-sync/_support/`: a local upstream git repo
plus a consumer repo). Suites: `add.test.ts`, `sync.test.ts`, `remove.test.ts`, `list.test.ts`,
`lib.test.ts`, `lib-git.test.ts`, `contract.test.ts`. One test per state and per error row of
§3.1; start→continue round trips asserting manifest, marker, both refs, scratch presence and
directory content; `contract.test.ts` asserts the universal contract for every script and every
outcome. No tests read the markdown.

## Acceptance Criteria

### Contract

- **AC-1**: The scripts SHALL write exactly one JSON object to stdout on every run, and nothing else.
  DoD: `contract.test.ts` runs every script through every state and every §3.1 error; `JSON.parse(stdout)` succeeds and `stdout.trim()` has no other content.
- **AC-2**: When a script exits 0, the object SHALL contain `state`; when it exits 1 or 2, the object SHALL contain `error.message` and no `state`.
  DoD: asserted for every run in `contract.test.ts`.
- **AC-3**: The scripts SHALL exit only 0, 1 or 2.
  DoD: `contract.test.ts` asserts `[0,1,2].includes(status)` for every run; `grep -E "process.exit\((3|4|5|6|7|10)|EXIT\.(MANIFEST|BASE|PATH|EXISTS|ANCESTRY|BEHIND)" scripts/*.mjs` returns 0 hits.
- **AC-4**: Each §3.1 row SHALL produce the exit code listed there.
  DoD: one test per row in the emitting script's suite.
- **AC-5**: When a git command fails, the script SHALL pass git's stderr through verbatim on stderr.
  DoD: fetch against a non-existent remote; the test asserts git's message appears in stderr.
- **AC-6**: The scripts SHALL NOT invoke a shell.
  DoD: `grep -E "shell:\s*true|execSync|exec\(" scripts/*.mjs` returns 0 hits.

### Manifest, marker, refs, scratch

- **AC-7**: When any start completes with a state other than `up_to_date`, the manifest SHALL hold `in_progress: { action, state, target_sha }` with `state` equal to the returned `state`.
  DoD: asserted after each such start in `add.test.ts` and `sync.test.ts`.
- **AC-8**: When `--continue` succeeds, the manifest SHALL hold `in_progress: null` and `sha == target_sha`, `refs/vendor/<slug>-base` SHALL equal `sha`, and `.vendor-sync/<slug>/` SHALL not exist.
  DoD: asserted after every continue in the round-trip tests.
- **AC-9**: If the manifest has an open marker, `add`, `sync` (start) and `remove` SHALL exit 2 with a message naming the action and `target_sha`.
  DoD: tests set a marker by hand and assert exit 2 and the message content for all three.
- **AC-10**: If `--continue` is called with no open marker, or with a marker of the other action, the script SHALL exit 2.
  DoD: two tests per script.
- **AC-11**: The start SHALL write the marker only after every scratch file is complete.
  DoD: unit test on the start's step order (scratch writer called before manifest writer); a fault-injection test makes the scratch export fail and asserts `in_progress` is still `null`.
- **AC-12**: When start runs with no open marker and `.vendor-sync/<slug>/` exists, it SHALL remove it before writing.
  DoD: test plants a stray file there and asserts it is gone after start.
- **AC-13**: When any start writes to `.vendor-sync/`, `.vendor-sync/.gitignore` SHALL contain `*`, and `git status --porcelain` SHALL show nothing under `.vendor-sync/`.
  DoD: asserted after each start that writes scratch.
- **AC-14**: The base ref SHALL exist and equal `sha` after `add --continue` and after every `sync --continue`.
  DoD: `git rev-parse refs/vendor/<slug>-base` compared to the manifest in the round-trip tests.
- **AC-15**: Diff headers in `local.diff` and `upstream.diff` SHALL be `a/<file>` / `b/<file>` relative to the vendored directory, and `.vendor.json` SHALL NOT appear in either.
  DoD: test asserts `^(---|\+\+\+) [ab]/` on every header line and `grep -c vendor.json` = 0.

### add

- **AC-16**: When `<dir>` is empty or absent, start SHALL return `ready`, and `<dir>` SHALL contain only `.vendor.json`.
  DoD: test asserts state and `readdir(dir)` = `[".vendor.json"]`.
- **AC-17**: When `<dir>` has committed content and is clean, start SHALL return `merge_needed`, SHALL write `scratch/upstream/`, and SHALL NOT change any pre-existing file.
  DoD: test hashes the directory before and after (excluding `.vendor.json`) and compares.
- **AC-18**: If `<dir>` has uncommitted changes or is an untracked directory, start SHALL exit 2.
  DoD: two tests (modified tracked file; untracked directory).
- **AC-19**: `add --continue` after `ready` SHALL populate `<dir>` with the upstream tree at `sha` and return `added`.
  DoD: test compares the directory tree to `git ls-tree -r <sha>:<path>`.
- **AC-20**: `add --continue` after `merge_needed` SHALL exit 2 unless `scratch/inventory.json` exists with `unclaimed == []` and non-empty `outcomes`, and SHALL NOT alter the directory's files when it succeeds.
  DoD: tests for missing file, non-empty `unclaimed`, empty `outcomes` (each exit 2), and a complete artifact (state `added`, directory hash unchanged).
- **AC-21**: If a start exits non-zero after creating `refs/vendor/<slug>`, the ref SHALL not exist afterwards (F-18); if a ref exists with no manifest, `add` SHALL proceed and overwrite it (D-29).
  DoD: test with an absent upstream path asserts `git rev-parse --verify refs/vendor/<slug>` fails; a second test pre-creates the ref, runs `add` on a manifest-less directory and asserts `ready`.
- **AC-22**: If `<dir>` is already vendored, start SHALL exit 2 with a hint naming `sync`.
  DoD: test asserts exit 2 and `/sync/` in `error.hint`.

### sync

- **AC-23**: The start SHALL return exactly one of `up_to_date`, `pin_ready`, `update_ready`, `merge_needed`, `base_missing` according to §4.2's table.
  DoD: one fixture scenario per state (tip unchanged; tip moved with same tree; upstream changed + clean copy; upstream changed + modified copy; base commit deleted after an upstream force-push) asserting the state.
- **AC-24**: While the state is `up_to_date`, the start SHALL NOT set a marker or write scratch.
  DoD: asserted in the `up_to_date` scenario.
- **AC-25**: In `update_ready`, `files` SHALL list exactly the files that differ between base and upstream trees.
  DoD: test compares `files` to `git diff --name-only <sha> <tip> -- <path>` (paths stripped of `<path>/`).
- **AC-26**: `sync --continue` after `update_ready` SHALL make `<dir>` equal to the upstream tree at `target_sha` (plus `.vendor.json`), including deletions.
  DoD: fixture deletes a file upstream; test asserts it is absent locally after continue.
- **AC-27**: `sync --continue` after `merge_needed` SHALL exit 2 unless `scratch/groups-upstream.json` exists with `unassigned == []` and every `decision` non-null.
  DoD: tests for missing file, non-empty `unassigned`, one `null` decision (each exit 2), and a complete artifact (state `synced`).
- **AC-28**: `sync --continue` after `base_missing` SHALL exit 2 unless `scratch/inventory.json` is complete as in AC-20.
  DoD: same four tests.
- **AC-29**: When `base_is_ancestor_of_tip` is false, `commits_behind` SHALL be `null`.
  DoD: force-push fixture asserts both fields.
- **AC-30**: If `<dir>` has uncommitted changes, start SHALL exit 2 before fetching or writing anything.
  DoD: test asserts exit 2 and that `.vendor-sync/<slug>/` was not created.

### remove and list

- **AC-31**: `remove` SHALL delete the manifest, both refs and any scratch for the slug, and SHALL retain every other file.
  DoD: test asserts the three deletions and an unchanged hash of the remaining files.
- **AC-32**: `remove` SHALL perform no network operation.
  DoD: test points the manifest `repo` at an unreachable URL; `remove` still returns `removed`.
- **AC-33**: `list` SHALL report every connection even when one fails, with exit 0.
  DoD: fixture with one healthy and one broken connection asserts two elements, one carrying `error`, exit 0.
- **AC-34**: `list` SHALL NOT write to the working tree, to any manifest or to `.vendor-sync/`.
  DoD: `git status --porcelain`, every manifest's content and `ls .vendor-sync/` compared before and after.

### Skill text

- **AC-35**: `SKILL.md` SHALL contain no state name and no `--continue` command.
  DoD: `grep -cE '`(ready|merge_needed|base_missing|update_ready|pin_ready|synced|added|removed|listed)`|--continue' SKILL.md` = 0 (state names appear in code font wherever they appear).
- **AC-36**: Every action file SHALL have the sections `Inputs` (except `list.md`), `Run`, `Outcomes`, `Report`, and every `###` heading under Outcomes SHALL be a state its script can return, with each state the script can return present.
  DoD: manual review against §4's state tables at the end of the rewrite (no doc test by decision D-20); the reviewer lists each file's headings beside the table.
- **AC-37**: Every Outcome entry's last line SHALL be `**Done.**` (or end with "run `--continue`" followed by a `Done.` line).
  DoD: manual review; `grep -c "Done\." <file>` equals the number of `###` headings in each action file.
- **AC-38**: No action file SHALL contain an exit-code table or mention another action except by relaying a script `hint`.
  DoD: `grep -cE "^\| *[0-9]+ *\|" add.md sync.md remove.md list.md` = 0; `grep -nE "vendor-(add|sync|remove|list)\.mjs|\b(add|sync|remove|list)\.md\b" <file>` lists, for each action file, only its own script and no other action file; every remaining hit of `grep -nwE "add|sync|remove|list" <file>` is inside a quoted `hint` or names the file's own action (reviewer walks the hit list).
- **AC-39**: Each merge file SHALL contain the field table for its artifact and SHALL end by returning to the calling entry.
  DoD: `grep -c "| Field | Type | Meaning |" merge-with-base.md merge-without-base.md` = 1 each; the last non-empty line of each file matches `--continue` (`tail -n 3 <file> | grep -c -- --continue` ≥ 1).
- **AC-40**: The seven markdown files SHOULD total under 500 lines.
  DoD: `wc -l *.md` in the skill directory.

## Boundaries

**ALWAYS**
- Print exactly one JSON object per script run; every fact the agent needs is in it (§3).
- Write the marker last, after every scratch file is complete (D-21 hygiene; AC-11).
- Write `.vendor-sync/.gitignore` = `*` before anything else in `.vendor-sync/` (D-24; AC-13).
- Keep `refs/vendor/<slug>-base` equal to the manifest's `sha` (D-11; AC-14).
- In the skill: show the resolved repo · branch · path · sha · file list to the user before running `--continue` for `ready`, `pin_ready`, `update_ready` (D-23).
- In the skill: quote a script's `message`, `hint` and git's stderr verbatim — they carry the paths, shas and listings the user needs.
- In the skill: end every Outcome entry with **Done.** (D-14).

**ASK FIRST**
- Before `--continue` in `ready`, `pin_ready`, `update_ready`: the user confirms what will be written.
- Before `remove`: the user confirms, told that files are retained and re-adding starts from a fresh base.
- In `merge-with-base.md`: a local modification whose purpose cannot be deduced is asked about, never guessed (D-19).
- Every upstream change gets an explicit decision from the user; a change with nothing against it still gets one (D-19).

**NEVER**
- The skill runs no git command, ever; every fact comes from a script's object (D-27).
- On exit 2 the agent takes no further action in that invocation — it reports and stops (D-15, D-21).
- The agent never resumes, continues or cleans up a marker it did not set in this session (D-21, D-22).
- Never run `--continue` while any group's `decision` is `null` or `unassigned`/`unclaimed` is non-empty (D-25).
- Never `git apply`, three-way merge or any mechanical merge, not even as a first pass (§6.5).
- Never adopt an upstream change by default (D-19).
- Never edit `.vendor.json` by hand or have the agent write it; only the scripts do (§3).
- Never commit; the user commits (§5.2 reports).
- Never write to the vendored directory from a start call, except the manifest marker (D-23).

## Out of Scope

- An `--abort` script or `abort` verb; discarding an unfinished merge is a git revert by the user (D-22).
- Resuming an open merge from another session (D-21).
- Tests that read the skill's markdown (D-20); a cold-run evaluation loop (D-2).
- Migration of existing vendored directories — none exist (F-16).
- Clone-independent base anchoring (committed base copy, pushed tags) — predecessor D-89 stands (D-11).
- Default adoption of uncontested upstream changes (D-19).
- Exit 10 / gating external tooling on `list`'s exit status; consumers read the JSON (D-15, D-16).
- A `--ref` override on export or any export/inspect/check/pin verb (D-7).
- Changing what the merge procedures decide or how (only their entry/exit and writing change; D-19).
