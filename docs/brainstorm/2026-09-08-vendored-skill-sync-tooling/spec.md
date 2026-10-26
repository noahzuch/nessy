# vendor-sync — Vendoring Upstream Directories with Deliberate Merges

> **Decision Journal:** `decisions.md` (same directory) records *why* each choice was made, which
> alternatives were rejected, and what evidence supported them. This specification is complete on
> its own for implementation — you need nothing from the journal to build it. Consult the journal
> when you want the rationale, or before *changing* a decision.

## Goal

`vendor-sync` is a project-local Claude Code skill that maintains locally-modified copies of
upstream git subdirectories. It vendors a subdirectory of any upstream git repository into any
local directory, records the exact upstream commit that copy was reconciled against, and — when
upstream moves — drives a merge in which both the local modifications and the upstream changes are
explained and decided one at a time with the user.

It deliberately does not apply patches. Merging is judgement, performed by the skill and confirmed
by the user. It requires no configuration file to be hand-edited and no rationale to be
hand-written: the intent behind a local modification is deduced from the diff and confirmed, never
recorded.

## Context

The immediate need is to adopt the `brainstorm` skill from `qaware-internal/agentic-marketplace`
(subpath `plugins/brainstorm/skills/brainstorm/`, five markdown files, ~630 lines) into this
repository, while permanently modifying it to resolve its output location and templates from the
harness config instead of an environment-variable ladder. Local divergence is therefore permanent
and deliberate.

That rules out git submodules — they pin a whole repository rather than a subpath, they place the
content one directory too deep for skill discovery, and their working tree is upstream's, not
yours. It also rules out git subtree, whose `--prefix` operates on the upstream root, so extracting
one subpath requires re-splitting upstream on every update.

The mechanism is not skill-specific. Nothing in it depends on the vendored content being a skill;
it vendors any subdirectory of any git repository into any local directory. "Skill" is only the
first use case.

This is repo-local maintenance tooling, not a published feature of the harness. There is no config
schema, no `nessy` subcommand, no ADR, and no public interface to keep stable.

Two constraints fix where it lives:

- The release workflow publishes the whole tree with `git add -A`, and no mechanism exists to
  exclude a subdirectory of a plugin's `skills/` from publication. Placing this in `skills/` would
  ship repo-maintenance tooling to every consumer of the plugin.
- Skills in every location are advertised to the model by default, so keeping it out of the model's
  reach requires an explicit frontmatter opt-out.

---

## Design

### 1. Placement, frontmatter, invocation

```
.claude/skills/vendor-sync/
  SKILL.md                  # frontmatter, argument handling, triage, reference index
  add.md
  sync.md
  remove.md
  merge-with-base.md
  merge-without-base.md
  exit-codes.md
  scripts/
    lib.mjs
    vendor-add.mjs
    vendor-check.mjs
    vendor-inspect.mjs
    vendor-export.mjs
    vendor-pin.mjs
    vendor-remove.mjs
    vendor-list.mjs
```

`.claude/skills/` is project-scoped and is never published as part of a plugin, so the tooling
stays private to this repository while remaining invocable inside it.

**Every file above is tracked in git and committed.** Other directories under `.claude/skills/` in
this repository are untracked scratch; this skill is not scratch and must exist for anyone working
in the repo.

Supporting files sit **flat** at the skill root. They are referenced as `./sync.md` in prose and as
`[sync.md](sync.md)` in the reference index. Scripts are referenced as
`` `scripts/vendor-check.mjs` `` with the qualifier "from this skill's directory". No file in this
skill uses `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, or an absolute path.

**SKILL.md frontmatter:**

```yaml
---
name: vendor-sync
description: >
  Vendor a subdirectory of an upstream git repository into a local directory and keep it
  synced through a reviewed merge. Use to add a vendored copy, sync one with upstream,
  list vendored directories, or remove a vendoring connection.
argument-hint: "add|sync|remove|list [args]"
disable-model-invocation: true
allowed-tools:
  - Bash(node:*)
  - Bash(mktemp:*)
  - Read
  - Write
  - Edit
  - AskUserQuestion
---
```

`disable-model-invocation: true` makes the skill user-invocable only. Vendoring is a deliberate
maintenance operation and must never auto-trigger mid-task.

`argument-hint` is **display only** — it shows a usage hint in the slash-command UI. It does not
complete, validate, or restrict values, and no harness mechanism exists to declare enumerated
argument values, so valid actions are also documented in SKILL.md prose.

Do **not** set `context: fork`. This skill is a dialogue with the user; an isolated subagent would
sever that.

Git is deliberately absent from `allowed-tools`: the skill never runs git (§5). This is enforced by
instruction, not by `disallowed-tools`.

**Arguments.** The raw argument string arrives as `$ARGUMENTS`; the skill treats the first token as
the action. The `arguments:` named-slot frontmatter field is not used, because arity varies by
action (0 for `list`, 1 for `sync`/`remove`, 3 for `add`).

**The completeness gate.** The skill proceeds only once it is certain of the intended action *and*
holds every required parameter. If either is missing, ambiguous, or the wrong arity, it asks. It
never infers an action from the shape or count of the arguments — a lone path argument means the
action was omitted, not that `sync` was intended.

**Temporary directories.** Shell variable state does not persist between separate Bash
invocations. The skill therefore either uses one compound command that creates the directory and
uses it, or reads the path `mktemp -d` printed and writes that literal path into later commands. It
never assumes a `$T` set by an earlier call is still bound.

### 2. The provenance manifest

One manifest per vendored directory, at `<local-dir>/.vendor.json`. All five fields are required:

```json
{
  "slug": "skills-brainstorming",
  "repo": "git@github.com:qaware-internal/agentic-marketplace.git",
  "path": "plugins/brainstorm/skills/brainstorm",
  "ref": "main",
  "sha": "ac7367c97bc27f3e1075c7577eee241b541cbb20"
}
```

| Field | Meaning |
|---|---|
| `slug` | Identifier for this connection's refs. Generated once at `add` and stored, never re-derived. |
| `repo` | Upstream git remote. May be a URL or a local filesystem path — git accepts either. |
| `path` | Subpath within the upstream repository that is vendored. |
| `ref` | Upstream branch tracked for updates. |
| `sha` | **The merge base** — the upstream commit this local copy was last reconciled against. |

`sha` is a claim that the directory has been reconciled against that commit. It must never be
written before that claim is true.

**Canonical serialization**: two-space indent, keys in exactly the order above, trailing newline.
`vendor-pin` rewrites the whole file in canonical form, so a read-modify-write can never reformat
it into a diff that looks like a content change.

There is no central registry. `vendor-list` discovers connections by finding `.vendor.json` files,
so adding or removing a connection requires no edit anywhere else and each directory is
self-describing.

**A vendored directory** is any directory containing a `.vendor.json`. Every script except
`vendor-list`, and except `vendor-export`'s flags-only form, operates on exactly one, named as a
required argument. No script iterates over multiple directories.

**`<local-dir>` normalization.** Before any use, the argument is resolved against the repository
root, trailing separators are stripped, and the result must lie inside the repository — otherwise
exit **1**. The slug is derived from the normalized form, so `skills/x`, `./skills/x`, `skills/x/`
and an absolute path to the same directory all yield one slug and one identity. The `dir` field in
JSON output is always this repository-root-relative form.

### 3. Refs: tracking and base

Each connection owns **two** local refs:

| Ref | Points at | Moved by |
|---|---|---|
| `refs/vendor/<slug>` | the tracked upstream branch tip | every fetch |
| `refs/vendor/<slug>-base` | the manifest's `sha` — the merge base | `vendor-add`, `vendor-pin` |

Upstream is fetched with:

```
git fetch --no-tags <repo> +refs/heads/<ref>:refs/vendor/<slug>
```

That refspec **moves** the tracking ref, so the tracking ref anchors nothing: after an upstream
history rewrite the previously recorded commit becomes unreferenced and `gc` may prune it. The
`-base` ref is the anchor, and `vendor-pin` moves it in step with the manifest so the two can never
disagree.

The anchor is **per-clone, not per-project**. A `git clone` fetches only `refs/heads/*` and
`refs/tags/*`, so `refs/vendor/*` — including `-base` — does not travel. Every fetching command
therefore recreates `-base` from the manifest's `sha` when that commit is reachable, which is the
normal case and makes a fresh clone self-heal. **That recreation is the entire mechanism**; nothing
further is done to defend the base. See the accepted residual below.

Consequences:

- **Losing ancestry does not break the merge.** Neither comparison in §4 needs the base to be an
  ancestor of the tip: both are two-point *tree* comparisons. `vendor-check` reports
  `base_is_ancestor_of_tip: false` and the skill surfaces it, but the base remains usable and the
  branch has simply diverged.
- **Exit 4 (base unreachable) fires only when the base commit object cannot be resolved**
  (`git cat-file -e <sha>^{commit}` fails). What the merge needs is the base *tree*; ancestry is
  irrelevant to it.
- **Accepted residual.** If upstream rewrites published history past the pinned commit, a clone
  that never fetched that commit cannot obtain the base tree, and drops into the no-base path
  (§11b). The clone that pinned it is unaffected, and the situation self-corrects as soon as anyone
  pins forward. This is accepted deliberately: removing it would require permanently duplicating
  the vendored content in the repository, or pushing tags to the project's own remote — a large,
  permanent cost to defend a rare event that temporarily degrades one clone.

A normal `git clone` fetches only `refs/heads/*` and `refs/tags/*`, so `refs/vendor/*` is absent in
a fresh clone. `add`, `check`, `inspect`, `export`, `pin` and `list` therefore all fetch before
evaluating anything, and a fresh clone self-heals with no bootstrap step. `vendor-remove` is the
sole exception: it performs no network operation.

`vendor-remove` deletes **both** refs.

**Slug derivation**, applied to the normalized local directory path:

1. Replace `/` with `-`.
2. Replace every character outside `[A-Za-z0-9_-]` with `-`.
3. Collapse runs of `-` into one.
4. Strip leading and trailing `-` and `.`.
5. Validate with `git check-ref-format refs/vendor/<slug>`.

Step 5 is the authority, not steps 1–4. If validation fails, or the slug is empty (a
punctuation-only path), `vendor-add` exits **1**, naming the directory and stating the recourse:
rename it. Naive derivation is insufficient — `.claude/skills/vendor-sync` would otherwise produce
`.claude-skills-vendor-sync`, which git rejects because a ref component cannot begin with `.`.

If `refs/vendor/<slug>` already exists, `vendor-add` exits **6** — except with `--adopt` (§7).
Sanitization can map two different paths onto one slug (`a.b` and `a-b` both become `a-b`); that
collision check covers it. There is no `--slug` override; the recourse in both cases is to rename
the local directory.

### 4. Evidence: with a base and without

**With a base** — three versions exist, and attribution is a fact:

```
base (manifest sha)  ──►  upstream tip      "what upstream changed"   (diff 2)
        │
        └───────────────►  local copy       "what you changed"        (diff 1)
```

| View | How it is computed |
|---|---|
| diff 1 | export the base tree to a temp directory, then `git diff --no-index <base-tmp> <local-dir>` |
| diff 2 | `git diff <sha>..refs/vendor/<slug> -- <path>` |

Diff 1 deliberately does **not** use `git diff <sha>:<path> HEAD:<local-dir>`. That form requires
the local directory to exist in `HEAD`, so it fails immediately after `add` before the first
commit, in a repository with no commits, and after a rename — and it reflects the last commit
rather than the working tree, which is not what "what did I change locally" means. The
export-and-`--no-index` form compares the working tree and needs no `HEAD`.

Neither comparison fails because a file was deleted locally or added upstream. A locally deleted
file appears explicitly as a deletion, so the two comparisons jointly encode local intent as
action. (This is a statement about *files*; the `HEAD` hazard above was a statement about the
directory path, which is why diff 1 avoids `HEAD` entirely.)

**Without a base** — only two versions exist, and a difference between them cannot be attributed
to either side: a deliberate local deletion and a later upstream addition are indistinguishable.
This occurs when adopting a directory that already has content (no `sha` was ever pinned), and in
the residual exit-4 case. These use a **different mechanism** (§11b), not the same mechanism with
less evidence.

**`git apply` is used nowhere.** It aborts atomically, so one upstream edit to a locally-deleted
file blocks an entire update; and it can exit 0 having silently mismerged, leaving locally-authored
content beneath an upstream-renamed heading. A zero exit from it is not a trustworthy signal.

### 5. The responsibility boundary

**Scripts state facts and never talk to the user. The skill makes judgements and never runs git.**

| Concern | Owner |
|---|---|
| Manifest discovery, parse, validate, write | script |
| All git invocation — fetch, refs, sha resolution, ancestry, diffs, subtree extraction, working-tree status | script |
| Slug derivation, path normalization, validation | script |
| Exit codes and remedy data | script |
| Reporting factual state | script |
| Action triage and the completeness gate | skill |
| Choosing where script output files land | skill |
| Grouping hunks into named changes and writing the totality mapping | skill |
| Deducing local intent; deducing upstream reasons | skill |
| Phase A / Phase B sequencing | skill |
| Idea inventory and synthesis when there is no base | skill |
| Offering the two paths when a target directory has content | skill |
| Authoring merged or synthesised files | skill |
| Obtaining a decision for every upstream change | skill |
| Deciding when to pin, and with which sha | skill |
| Reacting to each exit code | skill |
| The completion report | skill |
| Committing; deleting a directory after `remove` | user |

Consequence: the skill needs no git at all. Every fact it needs about the working tree is reported
by a script.

### 6. Script contract

**Output channels.**

- Bulk data goes **only** to the path given by `--out`. That file is created only on success — its
  existence is a success signal. A script removes a pre-existing `--out` file before writing, and
  creates missing parent directories.
- `vendor-check` prints a single JSON object on stdout; `vendor-list` prints a JSON array. These are
  the two outputs the skill parses.
- Every other script prints plain human-readable lines on stdout **on success**.
- **Every non-zero exit writes its message and its remedy data to stderr.** stdout carries only
  successful, informational output. There are no per-code exceptions. On exit 2, git's own stderr
  is passed through verbatim in addition to the script's message.

**Exit codes.** Uniform across all scripts.

| Code | Meaning | Remedy data (on stderr) |
|---|---|---|
| 0 | Success | — |
| 1 | Usage error: bad arguments or arity; an unsluggable directory path; a directory outside the repository; a non-empty `--out` without `--replace` | correct usage; for a slug failure, the directory and the instruction to rename it |
| 2 | Git or network failure: auth, unreachable repo, ref absent upstream, or a required commit object absent locally | git's stderr verbatim; for an absent upstream ref, the output of `git ls-remote --heads`; for an absent object, the instruction to run `add` or `check` first |
| 3 | Manifest problem: absent, malformed JSON, or missing a required field | the manifest path and the specific defect |
| 4 | Base commit object unresolvable | the pinned sha and the fetched tip |
| 5 | Upstream path absent at the resolved commit, or present but not a directory | a listing of what exists at that path level; for a non-directory, that the path is a file |
| 6 | Already vendored: `refs/vendor/<slug>` exists | the existing connection's directory and slug |
| 7 | The given `--sha` is not an ancestor of the tracked `ref` | the sha and the ref |
| 10 | **Status, not failure** — at least one directory is behind (`vendor-check`, `vendor-list`) | — (the per-directory detail is the normal stdout JSON) |

Code 10 exists so CI can distinguish "work to do" from "broken".

**Language and invocation.** All scripts are node ESM `.mjs`, invoked as
`node scripts/<name>.mjs …` from this skill's directory. Every script reads or writes JSON; node is
guaranteed by the project while `jq` is not. A shared `lib.mjs` provides manifest
discovery/parse/write, git helpers, slug derivation, path normalization, and the exit-code
constants.

### 7. The seven scripts

#### `vendor-add.mjs`

```
node scripts/vendor-add.mjs <repo> <upstream-path> <local-dir> [--ref <branch>] [--sha <commit>]
node scripts/vendor-add.mjs <repo> <upstream-path> <local-dir> --adopt --sha <commit> [--ref <branch>]
```

`--ref` defaults to `main`.

1. Normalize `<local-dir>` (§2). Outside the repository → exit **1**.
2. Derive and validate the slug (§3). Invalid or empty → exit **1**.
3. If `refs/vendor/<slug>` exists **and `--adopt` was not given** → exit **6**.
   With `--adopt` this check is skipped: the ref is *expected* to exist, having been created by the
   earlier `mode=has-content` run. Without this exemption `--adopt` could never succeed.
4. `git fetch --no-tags <repo> +refs/heads/<ref>:refs/vendor/<slug>`. Failure → exit **2**.
   The tracking ref is created here; steps 5–6 may still fail, so see step 9.
5. Resolve the target commit: `--sha` if given, else `git rev-parse refs/vendor/<slug>`. If `--sha`
   was given, verify `git merge-base --is-ancestor <sha> refs/vendor/<slug>`; not an ancestor →
   exit **7**. A commit unreachable from the tracked branch would not survive later fetches.
6. Verify the upstream path exists at that commit **and is a directory**:
   `git cat-file -t <commit>:<upstream-path>` must print `tree`. Absent, or a `blob` → exit **5**.
   (`cat-file -e` is insufficient: it succeeds for a blob, and `git archive` would then fail with
   an unmapped error.)
7. `--adopt` given: require `--sha` (missing → exit **1**). Write the canonical manifest, create or
   move `refs/vendor/<slug>-base` to that sha, and do nothing else — extract no files. Print
   `mode=adopt-finalize` and the manifest path. This is the **last** step of the guided-merge path
   (§9); `--sha` is required for the same reason `vendor-pin` requires it.
8. Otherwise branch on the destination's contents:
   - **Absent, or exists and contains zero entries** (dotfiles included): extract with
     `git archive <commit>:<upstream-path> | tar -x -C <local-dir>`, write the canonical manifest,
     and create `refs/vendor/<slug>-base` at that commit. Print `mode=materialize`, the file count,
     the pinned sha and the tracked ref.
   - **Contains any entry**: write **nothing at all**. Print `mode=has-content` with the resolved
     repo, upstream path, ref, commit and slug; a listing of the destination's existing entries;
     and `working_tree_clean` for that directory (`git status --porcelain <local-dir>` empty).
     Retain the tracking ref — the guided-merge path needs it. Exit **0**: this is a normal
     outcome, not an error.
9. **Failure cleanup**: if the script exits non-zero at or after step 5, it deletes the tracking
   ref it created in step 4. Otherwise a failed run would leave a ref that makes every later
   `vendor-add` for that directory exit 6 with no recourse.

`working_tree_clean` is reported in the has-content case because the guided-merge path overwrites
files, the skill must apply the cleanliness precondition (§10, §11), and a not-yet-vendored
directory has no manifest for `vendor-check` to read.

Leaves everything unstaged.

#### `vendor-check.mjs`

```
node scripts/vendor-check.mjs <local-dir>
```

1. Normalize `<local-dir>`. Read and validate the manifest. Absent directory or manifest problem →
   exit **3**, naming which of the two it was.
2. Fetch `+refs/heads/<ref>:refs/vendor/<slug>`, recreating the tracking ref if absent. Failure →
   exit **2**.
3. If `git cat-file -e <sha>^{commit}` fails → exit **4**, emitting the pinned sha and the fetched
   tip.
4. Recreate `refs/vendor/<slug>-base` at the manifest `sha` if it is absent and that commit
   resolves.
5. Compute diff 1 per §4 (export the base to a temp directory it owns and removes afterwards, then
   `git diff --no-index`) to determine `has_local_modifications`, and diff 2 to determine
   `upstream_changed`.
6. Emit one JSON object on stdout and exit **10** if `upstream_changed` is true, else **0**:

```json
{
  "dir": "skills/brainstorming",
  "slug": "skills-brainstorming",
  "repo": "git@github.com:...",
  "path": "plugins/brainstorm/skills/brainstorm",
  "ref": "main",
  "pinned_sha": "ac7367c...",
  "upstream_tip": "b2df2a0...",
  "upstream_changed": true,
  "commits_behind": 3,
  "base_is_ancestor_of_tip": true,
  "has_local_modifications": true,
  "working_tree_clean": true
}
```

**`upstream_changed` is the decision input, not `commits_behind`.** It is diff 2 being non-empty
(`git diff --quiet <sha>..refs/vendor/<slug> -- <path>` returning non-zero) — a two-tree
comparison, so always computable. It drives the sync branch (§10) and `vendor-list`'s exit 10.

`commits_behind` is **informational only**: `git rev-list --count <sha>..refs/vendor/<slug> --
<path>` when `base_is_ancestor_of_tip` is true, and **`null`** when it is false. A history walk is
meaningless without ancestry — after a rewrite the count can read the same in both directions — so
it must not be reported as a number there.

A commit count is the wrong decision input even with ancestry intact: it answers "how much upstream
activity touched this path", not "is there anything to reconcile". If upstream commits a change to
the vendored path and then reverts it, the count is 2 while the content is identical, and a
count-driven flow would walk the entire merge to discover there is nothing to do.

`base_is_ancestor_of_tip` is false after an upstream history rewrite. Both comparisons still work
(§3), so this is informational: the skill surfaces it rather than treating it as an error.

**Four distinct properties, easily confused:**

- `upstream_changed` — upstream's vendored content differs from the base. **Is there work to do.**
- `has_local_modifications` — the vendored content differs from the base. The **normal, healthy**
  state of a vendored copy.
- `working_tree_clean` — no uncommitted changes in the directory
  (`git status --porcelain <local-dir>` empty). The **precondition** for starting a merge.
- `base_is_ancestor_of_tip` — whether upstream's history still contains the base.

A healthy directory is usually changed upstream or not, locally modified, clean, and on intact
ancestry.

#### `vendor-inspect.mjs`

```
node scripts/vendor-inspect.mjs <local-dir> <local|upstream> --out <file>
```

1. Normalize, read and validate the manifest. Problem → exit **3**.
2. Fetch, recreating the tracking ref and the `-base` ref if absent. Failure → exit **2**. Base
   object unresolvable → exit **4**.
3. Write exactly one diff to `--out`, removing any pre-existing file at that path first:
   - `local` → export the base to a temp directory, `git diff --no-index <base-tmp> <local-dir>`,
     remove the temp directory.
   - `upstream` → `git diff <sha>..refs/vendor/<slug> -- <path>`.
4. An empty diff is success: write an empty file and exit **0**.

Writes nothing to the filesystem other than `--out` and its own temp directory. There is no `log`
kind.

#### `vendor-export.mjs`

```
node scripts/vendor-export.mjs <local-dir> --out <dest> [--sha <commit> | --ref <branch>] [--replace]
node scripts/vendor-export.mjs --repo <url|path> --path <subpath> --sha <commit> --out <dest> [--replace]
```

Materializes an upstream tree at `<dest>`. Export is a pure git operation:
`(repo, path, commit) → files at dest`. The `<local-dir>` form is sugar meaning "read `repo`,
`path` and `sha` from that directory's manifest"; `--sha`/`--ref` override the commit, which the
pristine fast path needs since it wants the tip rather than the base.

The **flags-only form requires `--sha`** — never `--ref` — and requires that commit object to be
present locally already; absent → exit **2** with the instruction to run `add` or `check` first.
This is why it needs no ref and no fetch: its only use is immediately after `vendor-add` has
fetched, in the guided-merge path where no manifest exists yet because the manifest must not be
written until reconciliation has happened.

1. Resolve coordinates from the manifest or the flags. Manifest problem → exit **3**. Neither form
   satisfied, or the flags-only form given `--ref` → exit **1**.
2. In the `<local-dir>` form, fetch (recreating the tracking ref if absent). Failure → exit **2**.
   In the flags-only form, do not fetch; verify the object is present instead.
3. Verify the path is a `tree` at that commit → else exit **5**.
4. Destination preconditions:
   - Without `--replace`: `<dest>` must not exist, or must be empty. Otherwise exit **1**.
   - With `--replace`: delete everything in `<dest>` **except `.vendor.json`**, then extract. The
     manifest is not upstream content and must survive re-materialization.
   Missing parent directories are created in both cases.
5. `git archive <commit>:<path> | tar -x -C <dest>`.
6. Print the destination, the commit, and the file count.

`--replace` is what makes the pristine fast path exact: a plain overlay would leave behind files
upstream has since deleted.

#### `vendor-pin.mjs`

```
node scripts/vendor-pin.mjs <local-dir> --sha <commit>
```

`--sha` is **required**. It must be the commit that was actually reconciled, passed explicitly —
never a freshly resolved tip, or upstream moving mid-merge would mark unreviewed commits as synced.

1. Normalize, read and validate the manifest. Problem → exit **3**. No `--sha` → exit **1**.
2. Fetch, recreating the tracking ref if absent. Failure → exit **2**. (Without this the ancestry
   check below would fail in a fresh clone with no documented recovery.)
3. Verify `git merge-base --is-ancestor <sha> refs/vendor/<slug>`. Not an ancestor → exit **7**.
   `pin` writes the base every future diff 1 depends on.
4. If the new sha differs from the stored one *and* `git status --porcelain <local-dir>` is empty,
   print to stderr: `warning: pinning a new sha but the vendored directory has no local changes`.
   This is legitimate when every upstream change was declined, so it warns and still exits **0**.
5. Write the manifest in canonical form with the new `sha`, leaving every other field's value
   untouched. Move `refs/vendor/<slug>-base` to that sha.
6. Print the old sha, the new sha, and the manifest path.

Step 4 runs before step 5, so the manifest write does not itself make the tree dirty and mask the
condition.

#### `vendor-remove.mjs`

```
node scripts/vendor-remove.mjs <local-dir>
```

Removes only the *connection*. Performs **no network operation** — fetching in order to delete
would add an offline failure mode to an operation with no other reason to fail.

1. Normalize `<local-dir>`. Derive the slug (§3) so the refs can be found even without a manifest.
2. If the manifest is absent:
   - and `refs/vendor/<slug>` is also absent → exit **3** ("not a vendored directory").
   - but `refs/vendor/<slug>` is present → delete both refs, report that an orphaned connection was
     cleaned, and exit **0**. This is the recourse for a directory left with a ref by an aborted
     `add`, or by choosing the separate-directory path after `mode=has-content`.
3. With a manifest present: print what will happen — the connection being dropped, both refs being
   deleted, and the number of files being retained.
4. Delete `<local-dir>/.vendor.json`.
5. Delete `refs/vendor/<slug>` and `refs/vendor/<slug>-base`. An already-absent ref is **not** an
   error.
6. Print confirmation: every vendored file retained, upstream objects now reclaimable by `gc`.

Every vendored file stays. "Stop tracking upstream" and "delete my directory" are different
intentions; deleting the directory is a separate `rm` the user can run.

#### `vendor-list.mjs`

```
node scripts/vendor-list.mjs
```

The **only** script that discovers anything.

1. Locate the repository root with `git rev-parse --show-toplevel`.
2. Find every `.vendor.json` beneath it, skipping `.git/` and `node_modules/`.
3. Invoke `vendor-check.mjs` as a subprocess for each directory found, capturing its exit code,
   stdout and stderr.
4. Print a JSON array of the per-directory objects. For a directory whose check exited non-zero
   and not 10, emit `{"dir": …, "error_exit_code": N, "error": "<its stderr>"}` in its place.
5. Exit code: if any check failed with a non-zero code other than 10, exit with the **highest**
   such code after reporting every directory. Otherwise exit **10** if any directory reported
   `upstream_changed: true`, else **0**.

Always fetches — via the per-directory `vendor-check`. There is no cache, no `--no-fetch`, and no
staleness window: a no-op fetch measured 0.74–1.05s and `ls-remote` 0.88s, so at the expected one
to three connections this is one to three seconds per run, dominated by round-trip. A cache would
trade a measured non-problem for a real risk of reporting stale "up to date".

### 8. Skill structure and load paths

SKILL.md contains only frontmatter, argument handling, the completeness gate, the triage decision,
the `list` action inline, and the reference index. It stays well under 500 lines.

Because the harness has **no declarative lazy-loading mechanism**, deferral works only because
nothing has read a file yet. SKILL.md must therefore contain an *explicit instruction to read* the
relevant file at the branch point that needs it. Without that, the agent proceeds from memory and
the deferred detail never arrives.

| Invocation | Files read |
|---|---|
| `list` | SKILL.md only |
| `remove <dir>` | SKILL.md → `remove.md` → `exit-codes.md` |
| `sync <dir>`, up to date | SKILL.md → `sync.md` → `exit-codes.md` |
| `sync <dir>`, pristine and behind | SKILL.md → `sync.md` → `exit-codes.md` |
| `sync <dir>`, behind with local modifications | SKILL.md → `sync.md` → `exit-codes.md` → `merge-with-base.md` |
| `sync <dir>`, base unresolvable | SKILL.md → `sync.md` → `exit-codes.md` → `merge-without-base.md` |
| `add …`, empty target | SKILL.md → `add.md` → `exit-codes.md` |
| `add …`, target has content, guided merge | SKILL.md → `add.md` → `exit-codes.md` → `merge-without-base.md` |

`exit-codes.md` is read by every action, because every action invokes scripts that can fail.
`list` is inline in SKILL.md because it modifies nothing and needs no procedure beyond "run
`vendor-list`, report the result"; it reports a non-zero exit verbatim rather than interpreting it.

### 9. Flow: add

**Skill.** Establish through dialogue, subject to the completeness gate: upstream repo, subpath,
local destination, and the ref or exact commit. Then read `add.md`.

**Script.** `vendor-add <repo> <path> <dir> [--ref] [--sha]`.

**On `mode=materialize`:** the skill reports that the folder is loaded and ready for local
modification — naming the file count, the pinned sha and the tracked ref — and **stops**. It does
not drive modifications; whether to make them manually or with an agent is the user's call.

**On `mode=has-content`:** the script has written nothing. The skill presents two paths and lets the
user choose; it does not decide.

- **Path 1 — vendor into a different, non-existent directory.** Re-run `vendor-add` against the new
  directory; that is the materialize case. The pre-existing folder is left untouched. Then run
  `vendor-remove` on the original directory to clean up the tracking ref the first run retained.
  This sidesteps the no-base problem rather than solving it, and is often the better engineering
  answer.
- **Path 2 — guided merge.** Proceed as follows:
  1. If the reported `working_tree_clean` is false, report what is dirty and **halt**. Files under
     version control are about to be overwritten; remedying it is not the skill's job.
  2. `vendor-export --repo … --path … --sha <the commit the script resolved> --out <tmp>/upstream`
     — the flags-only form, because no manifest exists yet.
  3. Read `merge-without-base.md` and follow §11b.
  4. Author the synthesised result into `<local-dir>`.
  5. `vendor-add … --adopt --sha <that same commit>` — writes the manifest and the base ref, and
     nothing else, **last**.

Step 5 is last by necessity. Were the manifest written first, abandoning would leave a manifest
whose base is the upstream tip beside a directory that was never reconciled — and the next sync's
diff 1 would report the user's entire local version as deliberate local modification. Passing the
same commit that step 2 exported is equally necessary: re-resolving the tip would pin a commit
that was never reconciled, after an interactive synthesis long enough for upstream to move.

### 10. Flow: sync

One flow. Every branch is a state the tooling *finds*, not a choice the user makes up front.

**Skill, first action:** run `vendor-check <local-dir>`. If `working_tree_clean` is false, report
what is dirty and **halt**. Remedying it is not the skill's job — the user resolves it however they
prefer and re-invokes.

This precondition does double duty: it also *catches an abandoned merge on the next run*. A merge
stopped halfway leaves the directory dirty, so the next sync refuses to start, and half-applied
edits can never be misread as local modifications.

If `base_is_ancestor_of_tip` is false, say so before proceeding: upstream rewrote history, the base
is still usable, the branch has diverged, and `commits_behind` will be `null` rather than a number.

Then branch on what `vendor-check` reported:

| State | Action |
|---|---|
| `upstream_changed == false`, `pinned_sha == upstream_tip` | Report up to date. Stop. |
| `upstream_changed == false`, `pinned_sha != upstream_tip` | Report up to date, and **offer to advance the pin** to the tip. Safe and free: upstream's content equals the base, so the base tree does not move and diff 1 is unaffected. On agreement, `vendor-pin <dir> --sha <upstream_tip>`. Arises from a commit-and-revert upstream, or a rewrite that preserved the tree. |
| `upstream_changed == true`, `has_local_modifications == false` | **Pristine fast path.** `vendor-export <dir> --sha <upstream_tip> --out <dir> --replace`, then `vendor-pin <dir> --sha <upstream_tip>`, then report. No reconciliation — there is nothing to reconcile. |
| `upstream_changed == true`, `has_local_modifications == true` | `vendor-inspect <dir> local --out <tmp>/local.diff` and `vendor-inspect <dir> upstream --out <tmp>/upstream.diff`. Read `merge-with-base.md`, follow §11a, author, `vendor-pin <dir> --sha <upstream_tip>`, report. |
| Exit **4** — base object unresolvable | Report the pinned sha and the fetched tip and explain that the base ref must have been deleted by hand. Then offer the same two paths as `add`: vendor into a separate directory, or guided synthesis via `merge-without-base.md`. Never re-pin without reconciling first. |
| Exit 2, 3 | Follow `exit-codes.md`. |

Note the pristine fast path leaves the tree dirty (`--replace` rewrote files), so `vendor-pin`'s
step-4 warning does not fire — correctly, since content did change.

**Completion report**, after pinning: the directory and slug, the sha transition, which upstream
changes were adopted, which were declined and why, and that the result awaits the user's review and
commit.

### 11. The two update paths

Both paths write into the vendored directory. Both are preceded by the cleanliness precondition,
and both author files **only after every decision is collected** — never incrementally.

#### 11a. Reconciliation with a base — `merge-with-base.md`

Two phases, in order. The order is not cosmetic: the agreed local intent is the *criterion* by which
an upstream change is judged, so establishing it is logically prior.

**Phase A — establish local intent.**

1. Read `<tmp>/local.diff`.
2. Group its hunks into named local changes and write the grouping to `<tmp>/groups-local.json`
   (schema in §11d). **Every hunk must belong to exactly one group**; any hunk that resists
   grouping goes in `unassigned`, which must be empty before proceeding. This totality guarantee is
   what makes grouping safe: "was anything buried?" becomes checkable rather than trusted.
3. For each group present: the name, what it does, the deduced intent, and the hunk reference(s)
   the deduction rests on. **Every deduced intent is presented beside the evidence it derives
   from.**
4. Ask the user to correct any wrong *deduction*, and update the file with any correction.

Phase A does **not** ask the user to re-approve these modifications. They are decisions the user
already made in an earlier session, and they have **standing**: they are preserved by default and
are not re-litigated each sync. Phase A exists to *identify* them so conflicts can be found, and to
let a mis-deduction be corrected. Without this principle every sync would re-open the user's own
past decisions and the copy would erode back toward upstream a little at a time.

**Phase B — judge upstream changes.**

1. Read `<tmp>/upstream.diff`.
2. Group its hunks into named upstream changes and write `<tmp>/groups-upstream.json`, with the same
   totality requirement.
3. For each change present: the name, what it does, the deduced reason upstream made it, its hunk
   references, whether it touches anything covered by a Phase A intent, and a recommendation with
   reasoning that refers to the agreed intents.
4. **Discuss every upstream change with the user individually and obtain a decision for each**,
   recording it in the file. There is no default adoption. A conflict with a local intent changes
   only the weight of the discussion — an intent with standing is on the other side of it — not
   whether a discussion happens.

The asymmetry between the phases is deliberate: a local intent is a decision the user already made,
so it keeps standing; an upstream change is a proposal the user has never seen, so it gets a
decision every time.

**Then author.** Apply the adopted changes to the vendored directory, obeying §11c. Then pin.

**Declines need no record.** Declining upstream change X while still pinning the new sha puts X
inside the base but absent from the local copy, so the next sync's diff 1 reports that absence as a
local modification, Phase A deduces an intent for it, and standing preserves it. Declines are
durable with no bookkeeping and no list that can drift.

#### 11b. Synthesis without a base — `merge-without-base.md`

Used when adopting a directory that already has content, and in the residual exit-4 case. This is
**idea-level synthesis, not diff-driven merging**: when versions have diverged substantially (148
local lines against 440 upstream, in the motivating case) a diff between them degenerates into
noise, and choosing a side per difference cannot produce a coherent document.

1. Obtain the upstream version on disk via `vendor-export` into a temp directory.
2. Read **both versions in full** — not a diff between them.
3. Build a **per-side inventory of named ideas**, written to `<tmp>/inventory.json` (schema in
   §11d). Each item carries the verbatim text span (file, start line, end line) that expresses it.
   The spans are the evidence for what each idea says and the anchor for staying close to source
   wording.
4. **Totality:** every part of both versions must be accounted for — claimed by an inventory item,
   or listed in `unclaimed`. `unclaimed` must be emptied by resolving each entry before proceeding;
   nothing may vanish without a decision.
5. Present both inventories. Discuss keep / drop / combine per item, recording each outcome.
6. Author the merged version, obeying §11c. Where two conflicting ideas had to be combined into new
   wording, **list each such place explicitly**, naming the two ideas and why combining them
   required new text.
7. **Present the complete synthesised result for final review.** Write files only on approval.

Step 7 is mandatory and is the correctness mechanism, not a formality. Verbatim assembly cannot be
enforced mechanically here — ideas from two sources cannot be merged by concatenating blocks,
because combining them inherently requires connective and reconciling text. Review is therefore the
control, and the itemised list from step 6 is what makes the review tractable.

#### 11c. The verbatim guideline

**Stated in full in both `merge-with-base.md` and `merge-without-base.md`.** It is duplicated
deliberately: every merge loads exactly one of those files, so stating it in both makes it
impossible to reach a merge without it, and it is short enough that duplication costs less than a
third file read.

> Preserve the wording of the two source states as closely as possible. Merge verbatim wherever
> possible. Rewrite text **only** where two conflicting changes genuinely have to be combined, and
> say so explicitly when you do.

In the with-base merge this is achievable literally: adopted changes can be taken verbatim. In
synthesis, stay as near verbatim as possible and rely on the final review.

The hazard: a model merging prose will tend to improve it, and every unrequested improvement drifts
the vendored copy away from **both** sources. It then diffs against upstream forever in ways nobody
decided, inflating diff 1 on every future sync and burying the real local modifications in noise.

#### 11d. Artifact schemas

The skill writes these so the totality guarantees are checkable rather than asserted. All live in
the temp directory alongside the diffs.

`groups-local.json` and `groups-upstream.json`:

```json
{
  "side": "local",
  "groups": [
    {
      "id": "L1",
      "name": "config-driven output location",
      "what": "replaces the four-rung resolution ladder with a single config lookup",
      "why": "path resolution is delegated to the harness config",
      "hunks": [ { "file": "SKILL.md", "start": 148, "end": 176 } ],
      "decision": null
    }
  ],
  "unassigned": []
}
```

`decision` is `null` in Phase A (local intents are not decided, they have standing) and one of
`"adopt"` / `"decline"` with a `reason` in Phase B.

`inventory.json`:

```json
{
  "sides": {
    "local": [ { "id": "l1", "name": "…", "span": { "file": "SKILL.md", "start": 1, "end": 20 } } ],
    "upstream": [ { "id": "u1", "name": "…", "span": { "file": "SKILL.md", "start": 1, "end": 14 } } ]
  },
  "unclaimed": [ { "side": "upstream", "file": "SKILL.md", "start": 400, "end": 412 } ],
  "outcomes": [ { "ids": ["l1", "u1"], "outcome": "combine", "reason": "…" } ]
}
```

### 12. Testing

The fixture upstream is a **local git repository** — git accepts a filesystem path as a remote, so
no network is needed. Tests live in `tests/skills/vendor-sync/` and run under the project's
existing vitest suite, invoking the scripts as subprocesses. The DoD one-liners in the acceptance
criteria are the **assertions**, expressed inside those tests; there is no separate shell harness.

Each test builds, in a temp directory:

- a fixture **upstream** repo: commits creating the vendored subpath, plus whatever divergence the
  case requires;
- a fixture **consumer** repo: a git repository with at least one commit, into which vendoring
  happens.

Fixture shapes required by the criteria below, each built from those two pieces:

| Fixture | Construction |
|---|---|
| up-to-date | vendor, then make no upstream commits |
| behind | vendor, then commit inside the subpath upstream |
| behind with local modifications | as above, plus edit a vendored file and commit in the consumer |
| pristine and behind | as "behind", with no local edits |
| deleted locally, edited upstream | delete a vendored file and commit; edit that file upstream |
| upstream commit outside the subpath | commit a file elsewhere in the upstream repo |
| non-ancestor commit | commit on a second upstream branch |
| bogus pinned sha | hand-edit `.vendor.json` to a 40-hex value that is not an object, and delete the `-base` ref |
| three independent upstream changes | three commits touching three separate files in the subpath |

---

## Acceptance Criteria

### Manifest, identity and discovery

- **AC-1:** The system SHALL store one manifest per vendored directory at `<dir>/.vendor.json`
  containing `slug`, `repo`, `path`, `ref` and `sha`.
  DoD: `vendor-check` against a fixture manifest missing any one of the five fields exits 3;
  against a complete one exits 0 or 10.
- **AC-2:** `vendor-list` SHALL discover vendored directories by finding `.vendor.json` files, with
  no central registry, and SHALL skip `.git/` and `node_modules/`.
  DoD: with two fixture connections, `vendor-list` reports both with no other file edited; a
  `.vendor.json` planted under `node_modules/` does not appear.
- **AC-3:** Every script SHALL require exactly one `<local-dir>` argument, except `vendor-list`
  (which takes none) and `vendor-export`'s flags-only form.
  DoD: `vendor-check`, `vendor-inspect`, `vendor-pin` and `vendor-remove` each exit 1 with no
  directory argument; `vendor-export --repo … --path … --sha … --out …` exits 0.
- **AC-4:** `<local-dir>` SHALL be normalized against the repository root, with trailing separators
  stripped, and a directory outside the repository SHALL exit 1.
  DoD: `skills/x`, `./skills/x`, `skills/x/` and the absolute path all produce the same `slug` and
  the same `dir` value in `vendor-check` output; a path outside the repo exits 1.
- **AC-5:** The manifest SHALL be written with two-space indent, the fixed key order
  `slug, repo, path, ref, sha`, and a trailing newline.
  DoD: `vendor-pin` on a canonical manifest changes exactly one line
  (`git diff --numstat` reports `1  1`).

### Slug

- **AC-6:** `vendor-add` SHALL derive the slug by replacing `/` with `-`, replacing characters
  outside `[A-Za-z0-9_-]` with `-`, collapsing repeats, and stripping leading and trailing `-` and
  `.`; and SHALL validate the result with `git check-ref-format`.
  DoD: `.claude/skills/vendor-sync` yields `claude-skills-vendor-sync`; `vendor/some.lock` yields
  `vendor-some-lock`; both pass `git check-ref-format refs/vendor/<slug>`.
- **AC-7:** If the derived slug is empty or fails `git check-ref-format`, `vendor-add` SHALL exit 1
  and write to **stderr** the directory and the instruction to rename it.
  DoD: a punctuation-only target path exits 1; stderr contains the path and the word "rename";
  stdout is empty.
- **AC-8:** If `refs/vendor/<slug>` already exists and `--adopt` was not given, `vendor-add` SHALL
  exit 6 and name the existing connection on stderr.
  DoD: run `vendor-add` twice for the same directory; the second exits 6 with the directory and
  slug on stderr.
- **AC-9:** The `slug` SHALL be stored in the manifest and never re-derived by other scripts.
  DoD: rename a vendored directory (moving its manifest with it), then `vendor-check` on the new
  path succeeds and reports the original slug.

### Refs

- **AC-10:** `vendor-add` SHALL create `refs/vendor/<slug>-base` at the pinned commit, and
  `vendor-pin` SHALL move it to the new sha.
  DoD: after `add`, `git rev-parse refs/vendor/<slug>-base` equals the manifest `sha`; after `pin`,
  it equals the new `sha`.
- **AC-11:** In a clone that already holds the base commit, an upstream history rewrite SHALL NOT
  make the base unresolvable.
  DoD: force-push a rewritten upstream branch, then in the original clone `vendor-check` exits 0 or
  10 (not 4), `base_is_ancestor_of_tip` is false, `commits_behind` is `null`, and both
  `vendor-inspect` kinds exit 0.
- **AC-12:** `vendor-check` SHALL exit 4 only when the base commit object cannot be resolved.
  DoD: on the bogus-pinned-sha fixture (with the `-base` ref deleted), exit is 4 and stderr
  contains both the pinned sha and the fetched tip.
- **AC-13:** If `vendor-add` exits non-zero at or after resolving the target commit, it SHALL delete
  the tracking ref it created.
  DoD: invoke with a bogus subpath (exits 5), then `git rev-parse --verify refs/vendor/<slug>`
  fails.
- **AC-14:** When `refs/vendor/<slug>` or `refs/vendor/<slug>-base` is absent, `vendor-check`,
  `vendor-inspect`, `vendor-export` (manifest form) and `vendor-pin` SHALL recreate it rather than
  failing — the tracking ref by fetching, the base ref from the manifest `sha` when that commit
  resolves.
  DoD: delete both refs, then each of the four exits non-2, and afterwards
  `git rev-parse --verify` succeeds for both refs. Simulating the fresh-clone case (delete both
  refs and `gc --prune=now` is NOT required — reachability from the fetched branch suffices).

### add

- **AC-15:** When the target directory is absent or contains zero entries, `vendor-add` SHALL
  extract the upstream subtree, write the manifest, create the base ref, print `mode=materialize`,
  and exit 0.
  DoD: against an empty directory, `find <dir> -type f | sort` equals the upstream file list plus
  `.vendor.json`, and stdout contains `mode=materialize`.
- **AC-16:** If the target directory contains any entry and `--adopt` was not given, `vendor-add`
  SHALL write no file whatsoever, and SHALL print `mode=has-content` with the resolved coordinates,
  the existing entries, and `working_tree_clean`, exiting 0.
  DoD: seed the directory with a committed sentinel file; afterwards the sentinel is byte-identical,
  no `.vendor.json` exists, no upstream filename is present, and stdout contains `mode=has-content`
  and `working_tree_clean`.
- **AC-17:** `--adopt` SHALL require `--sha`, SHALL skip the ref-exists check, and SHALL write only
  the manifest and the base ref.
  DoD: `--adopt` without `--sha` exits 1; with `--sha`, on a directory holding a sentinel and with
  `refs/vendor/<slug>` already present, it exits 0, leaves the sentinel byte-identical, and adds
  exactly one file, `.vendor.json`.
- **AC-18:** If `--sha` is not an ancestor of `--ref`, `vendor-add` SHALL exit 7 and write both
  values to stderr.
  DoD: invoke with a non-ancestor commit; exit 7, stderr contains the sha and the ref.
- **AC-19:** If the upstream path is absent at the resolved commit, or is a file rather than a
  directory, `vendor-add` SHALL exit 5 and list on stderr what exists at that path level.
  DoD: a bogus subpath exits 5 with at least one real sibling on stderr; a subpath naming a
  committed file also exits 5, and no `git archive` error surfaces.

### check

- **AC-20:** `vendor-check` SHALL fetch before evaluating and SHALL print one JSON object containing
  `dir`, `slug`, `repo`, `path`, `ref`, `pinned_sha`, `upstream_tip`, `upstream_changed`,
  `commits_behind`, `base_is_ancestor_of_tip`, `has_local_modifications` and `working_tree_clean`,
  exiting 10 when `upstream_changed` is true and 0 otherwise.
  DoD: parse stdout as JSON and assert all twelve keys are present; the behind fixture exits 10 and
  exits 0 after `vendor-pin`.
- **AC-21:** `upstream_changed` SHALL be true exactly when upstream's vendored content differs from
  the base, independently of how many commits touched it.
  DoD: on the up-to-date fixture, add an upstream commit inside the subpath and then a second
  reverting it — `upstream_changed` is false and the exit code is 0 while `commits_behind` is 2.
- **AC-22:** `commits_behind` SHALL count only commits touching the vendored subpath, and SHALL be
  `null` when `base_is_ancestor_of_tip` is false.
  DoD: an upstream commit outside the subpath leaves `commits_behind` at 0 and the exit code 0;
  after a force-pushed rewrite past the pin, `commits_behind` is `null` (not a number).
- **AC-23:** `working_tree_clean` SHALL report uncommitted changes, independently of
  `has_local_modifications`.
  DoD: on the behind-with-local-modifications fixture (committed), `has_local_modifications` is
  true and `working_tree_clean` is true; after appending a line to a vendored file,
  `working_tree_clean` is false while `has_local_modifications` stays true.
- **AC-24:** `has_local_modifications` SHALL be computed against the working tree without requiring
  the directory to exist in `HEAD`.
  DoD: immediately after `vendor-add` with nothing committed in the consumer repo, `vendor-check`
  exits 0 or 10 and reports `has_local_modifications: false`.
- **AC-25:** The `dir` field SHALL be the repository-root-relative normalized path.
- **AC-26:** When `upstream_changed` is false but `pinned_sha != upstream_tip`, the skill SHALL
  report up to date and offer to advance the pin rather than starting a merge.
  DoD: on the commit-and-revert fixture, the transcript reports up to date, offers the pin advance,
  and contains no `vendor-inspect` invocation.
  DoD: invoking with an absolute path yields the same `dir` value as invoking with the relative one.

### inspect

- **AC-27:** `vendor-inspect` SHALL accept exactly one of `local` or `upstream`, write that one diff
  to `--out`, and write nothing else outside its own temp directory.
  DoD: run both kinds; `git status --porcelain` in the consumer repo is unchanged, and both files
  are non-empty for the behind-with-local-modifications fixture.
- **AC-28:** The comparisons SHALL NOT fail because of files deleted locally or added upstream.
  DoD: on the deleted-locally-edited-upstream fixture, both invocations exit 0.
- **AC-29:** An empty diff SHALL be treated as success.
  DoD: on the up-to-date fixture, `vendor-inspect <dir> upstream --out f` exits 0 and `f` exists
  with size 0.
- **AC-30:** `vendor-inspect` SHALL NOT accept a `log` kind.
  DoD: `vendor-inspect <dir> log --out f` exits 1.
- **AC-31:** A pre-existing `--out` file SHALL be removed before writing, and missing parent
  directories created.
  DoD: pre-create `--out` with junk content and a missing parent path; after a successful run the
  file contains only the diff; after a failing run (bogus directory) the pre-created file no longer
  exists.

### export

- **AC-32:** `vendor-export` SHALL accept either a `<local-dir>` or `--repo`/`--path`, and SHALL
  allow the commit to be overridden with `--sha` or, in the manifest form only, `--ref`.
  DoD: both forms produce byte-identical trees for the same commit (`diff -r` reports no
  differences); the flags-only form with `--ref` exits 1.
- **AC-33:** The flags-only form SHALL require the commit object to be present locally, exiting 2
  otherwise with the instruction to run `add` or `check` first.
  DoD: in a fresh clone with no vendor refs, the flags-only form with a valid sha exits 2 and stderr
  names `add` or `check`.
- **AC-34:** Without `--replace`, `vendor-export` SHALL exit 1 if the destination exists and is
  non-empty.
  DoD: export into a directory containing one file exits 1 and that file is unchanged.
- **AC-35:** With `--replace`, `vendor-export` SHALL delete the destination's contents except
  `.vendor.json` before extracting.
  DoD: seed the destination with `.vendor.json` and a stray file; after `--replace`, `.vendor.json`
  is byte-identical, the stray file is gone, and the upstream files are present.

### pin

- **AC-36:** `vendor-pin` SHALL require `--sha` and SHALL reject a sha that is not an ancestor of
  the tracked ref.
  DoD: no `--sha` exits 1; a non-ancestor `--sha` exits 7; a valid one exits 0 and the manifest
  contains it.
- **AC-37:** If the new sha differs from the stored one while the directory has no uncommitted
  changes, `vendor-pin` SHALL warn on stderr and SHALL still exit 0.
  DoD: on a committed, unmodified vendored directory, pinning a newer sha produces stderr matching
  `/no local changes/` and exit code 0.
- **AC-38:** `vendor-pin` SHALL change only the `sha` value.
  DoD: reading both manifests with node, every key except `sha` is deeply equal before and after.

### remove

- **AC-39:** `vendor-remove` SHALL delete `.vendor.json` and both refs, SHALL retain every other
  file, and SHALL perform no network operation.
  DoD: the directory's file count decreases by exactly 1; `git rev-parse --verify` fails for both
  `refs/vendor/<slug>` and `refs/vendor/<slug>-base`; the script source contains no `fetch` or
  `ls-remote` invocation.
- **AC-40:** When a ref is already absent, `vendor-remove` SHALL still exit 0.
  DoD: delete the base ref by hand, then `vendor-remove` exits 0.
- **AC-41:** When the manifest is absent but the derived slug's tracking ref exists,
  `vendor-remove` SHALL delete both refs, report an orphaned connection, and exit 0.
  DoD: after a `mode=has-content` run, `vendor-remove` on that directory exits 0, both refs are
  gone, and the directory's files are untouched.
- **AC-42:** When both the manifest and the derived slug's ref are absent, `vendor-remove` SHALL
  exit 3.
  DoD: run against an unrelated directory; exit code is 3.

### list

- **AC-43:** `vendor-list` SHALL print a JSON array and SHALL exit with the highest non-zero,
  non-10 code encountered, else 10 if any directory is behind, else 0.
  DoD: with one behind fixture and one manifest-broken fixture, the exit code is 3 and the array
  contains an `error_exit_code` entry of 3 for the broken one and a full object for the other.

### Script contract

- **AC-44:** Every non-zero exit SHALL write its message and remedy data to stderr, leaving stdout
  empty.
  DoD: for each of exits 1, 2, 3, 4, 5, 6 and 7 reachable from the fixtures, stdout is empty and
  stderr is non-empty.
- **AC-45:** On exit 2, git's own stderr SHALL be passed through verbatim.
  DoD: with an unreachable repo, stderr contains a substring produced by git itself.

### Skill behaviour

- **AC-46:** The skill SHALL live at `.claude/skills/vendor-sync/`, SHALL be tracked in git, SHALL
  set `disable-model-invocation: true` and `argument-hint`, and SHALL NOT set `context: fork`.
  DoD: `git ls-files .claude/skills/vendor-sync/` lists SKILL.md and all six supporting files;
  SKILL.md contains `disable-model-invocation: true` and `argument-hint`; it does not contain
  `context: fork`; `git ls-files skills/` produces no path containing `vendor-sync`.
- **AC-47:** The skill SHALL NOT run git.
  DoD: `allowed-tools` contains no git entry, and no file in the skill directory instructs running
  a git command outside a fenced description of what a script does. (Reviewed, not grepped.)
- **AC-48:** The skill SHALL proceed only when the action and every required parameter are known,
  and SHALL NOT infer the action from the shape or count of arguments.
  DoD: invoked as `/vendor-sync skills/brainstorming`, the transcript shows the skill asking which
  action is intended, with no `vendor-*.mjs` invocation before that question.
- **AC-49:** The skill's first action in any flow that may modify a directory SHALL be to establish
  cleanliness — from `vendor-check` for a vendored directory, or from `vendor-add`'s
  `mode=has-content` report for a fresh adoption — halting if it is false without attempting to
  remedy it.
  DoD: with an uncommitted change present, the transcript shows the skill halting after the
  reporting script and before any Write, Edit or `vendor-inspect` call, and contains no stash,
  reset, checkout or commit instruction.
- **AC-50:** Before any write or pin, the skill SHALL echo the resolved identity — slug, repo,
  upstream path, sha and directory — from the script's reported values rather than restated from
  the user's argument.
  DoD: the echoed values match the `vendor-check` JSON field-for-field.
- **AC-51:** Phase A SHALL write `groups-local.json` in which every hunk of `local.diff` belongs to
  exactly one group and `unassigned` is empty.
  DoD: the count of `@@` hunk headers in `local.diff` equals the total number of hunk entries across
  groups, no `{file,start,end}` appears twice, and `unassigned` is `[]`.
- **AC-52:** Every deduced local intent SHALL be presented beside the hunk reference it derives
  from.
  DoD: every group in `groups-local.json` has a non-empty `why` and at least one hunk entry, and
  the presented text names both.
- **AC-53:** Phase A SHALL NOT ask the user to re-approve existing local modifications, only to
  correct mis-deductions.
  DoD: `decision` is `null` for every group in `groups-local.json`, and the Phase A prompt requests
  corrections without requesting approval to keep the modifications.
- **AC-54:** Phase B SHALL write `groups-upstream.json` with the same totality property, and every
  group SHALL carry an explicit `decision` of `adopt` or `decline` with a `reason`.
  DoD: hunk counts match as in AC-51; no group has `decision: null`.
- **AC-55:** No upstream change SHALL be adopted without an explicit user decision.
  DoD: on the three-independent-upstream-changes fixture, `groups-upstream.json` contains three
  groups each with a decision, and the transcript contains three corresponding exchanges.
- **AC-56:** The skill SHALL author files only after all decisions are collected, never
  incrementally.
  DoD: in the transcript, no Write or Edit targeting the vendored directory precedes the last
  recorded decision.
- **AC-57:** Synthesis SHALL write `inventory.json` in which every part of both versions is claimed
  by an item or listed in `unclaimed`, with `unclaimed` emptied before authoring, and each item
  carrying a verbatim span.
  DoD: the claimed spans cover every line of both files with no overlaps; `unclaimed` is `[]` at
  authoring time; every item has a `span` with `file`, `start` and `end`.
- **AC-58:** Synthesis SHALL present the complete synthesised result for review and SHALL write
  files only after approval.
  DoD: the transcript shows the full result presented, then an approval, then the Write calls, in
  that order.
- **AC-59:** Where synthesis wrote new connective or reconciling text, it SHALL list each such
  place with both source ideas and the reason.
  DoD: `inventory.json`'s `outcomes` contains a `combine` entry with a non-empty `reason` for every
  place the presented result was described as newly worded. (Reviewed against the presented list —
  a mechanical verbatim comparison is not possible here, which is why §11b step 7 is mandatory.)
- **AC-60:** After pinning, the skill SHALL report the directory and slug, the sha transition, the
  adopted changes, the declined changes with reasons, and that the result awaits review and commit.
  DoD: the reported "from" sha equals the manifest `sha` before the pin and the "to" sha equals it
  after; the reported adopted and declined sets equal the `adopt` and `decline` groups in
  `groups-upstream.json`.
- **AC-61:** SKILL.md SHALL contain an explicit instruction to read each action file, and each
  action file an explicit instruction to read `exit-codes.md` and any merge file it needs.
  DoD: SKILL.md contains a read instruction naming `add.md`, `sync.md` and `remove.md`; all three
  name `exit-codes.md`; `sync.md` names both merge files; `add.md` names `merge-without-base.md`.
- **AC-62:** SKILL.md SHALL be under 500 lines and SHALL end with a reference index listing every
  supporting file with a one-line purpose.
  DoD: `wc -l SKILL.md` < 500; the index lists all six supporting files.
- **AC-63:** The verbatim guideline SHALL appear in full in both merge files.
  DoD: the exact sentence "Merge verbatim wherever possible." occurs once in each of
  `merge-with-base.md` and `merge-without-base.md`.
- **AC-64:** `exit-codes.md` SHALL document the agent's reaction for every non-zero exit code.
  DoD: for each of 1, 2, 3, 4, 5, 6, 7 and 10, the file contains the code and a stated reaction.

---

## Boundaries

**ALWAYS**

- Fetch before evaluating upstream state in `add`, `check`, `inspect`, `pin`, `export` (manifest
  form) and `list`.
- Move `refs/vendor/<slug>-base` in step with the manifest's `sha`, never one without the other.
- Write every non-zero exit's message and remedy data to stderr.
- Delete a tracking ref the script itself created if it then fails.
- Present every deduced intent beside the hunk reference it derives from.
- Account for every hunk in exactly one named group, and write the mapping to disk.
- Obtain an individual user decision for every upstream change.
- Echo the resolved identity — slug, repo, upstream path, sha, directory — from the script's
  reported values before any write or pin.
- Pass `vendor-pin` and `vendor-add --adopt` the explicit sha that was actually reconciled.
- Print which mode `vendor-add` selected.
- Present the complete synthesised result for review before writing, in the no-base path.

**ASK FIRST**

- Exit 4 (base object unresolvable) — report both shas, explain the base ref must have been deleted
  by hand, and offer the two paths.
- Exit 5 (upstream path absent or not a directory) — show what exists and let the user choose.
- Exit 2 (auth failure, absent upstream ref, or absent object) — the user resolves it.
- A target directory that already has content — present both paths; never choose for the user.
- A local modification whose purpose cannot be deduced from diff 1 — ask rather than guess.
- Before running `vendor-remove` — confirm intent, state that files are retained, and state that
  re-adding later starts from a fresh base so accumulated modifications would then present as one
  large divergence.

**NEVER**

- Never run `git apply`, or any automatic or mechanical merge.
- Never adopt an upstream change by default.
- Never re-litigate an existing local modification; it has standing.
- Never re-pin a base without reconciling first.
- Never write the manifest before reconciliation has happened.
- Never compute diff 1 from `HEAD`; it must reflect the working tree.
- Never extract into a directory containing any entry, except via `vendor-export --replace`.
- Never delete `.vendor.json` during `--replace`.
- Never write merged files before every decision is collected.
- Never re-word a retained idea except where two conflicting ideas must be combined — and say so
  when you do.
- Never let the skill run git.
- Never place `vendor-sync` under the published `skills/` directory.
- Never perform a network operation in `vendor-remove`.
- Never delete vendored files as part of removing a connection.
- Never attempt to remedy a dirty working tree; halt and report.
- Never rely on a shell variable set by a previous Bash invocation.

---

## Out of Scope

- Publishing this as a harness feature or public CLI — no config schema, no `nessy` subcommand, no
  ADR, no versioned public interface.
- `git apply`, three-way patch application, or any hybrid fast path.
- git submodules and git subtree.
- A hand-edited exclude list, a `notes` field, or any written record of local intent.
- An `inspect log` mode, or any use of commit messages as an intent source.
- A `--slug` override. The recourse for an unsluggable path or a slug collision is to rename the
  local directory.
- `disallowed-tools` enforcement of the no-git rule; it is enforced by instruction.
- Special handling for an orphaned upstream (deleted, renamed, or access revoked). The tooling fails
  with exit 2 and the developer resolves why. `vendor-list` in CI is a gate, and a failing run is
  the wanted signal.
- Automatic or scheduled syncing. `vendor-list`'s exit 10 is what *enables* external scheduling; the
  skill never triggers on its own.
- Non-git upstreams, and vendoring anything that is not a subdirectory of a git repository.
- An `update` command. Updating is `check` → `inspect` → merge → `pin`, and its middle step is
  judgement, so no script can own it.
- Migrating the existing `skills/brainstorming/` content. That is the first *use* of this tooling,
  performed after it exists.
  **Constraint to carry into that work:** the directory and skill name `brainstorming` are not free
  to change — the skill is referenced from `skills/writing-plans/SKILL.md:26` and keyed as
  `brainstorming` in `src/shared/config.ts:29`. The upstream skill's frontmatter `name:` is
  `brainstorm`, so adopting it requires either a permanent local modification of that field or
  coordinated edits to both call sites.

---

## Errata discovered during implementation

Recorded here, briefly and neutrally, rather than edited into the text above: this specification is
the record of a design conversation, and the places below are where implementation found it
incomplete or self-contradicting. Nothing above this section was changed to produce this list.

1. **§6 / AC-44 vs. §7's `vendor-list` steps.** §6 and AC-44 state the stdout-empty-on-failure rule
   has "no per-code exceptions" (only code 10 is carved out as a status, not a failure). But §7's
   `vendor-list.mjs` steps 4–5 mandate printing the full JSON array *before* exiting with the
   highest failing per-directory code — a genuine non-zero, non-10 failure that still carries a
   stdout body. `vendor-list` is a second, deliberate exception to the stdout-empty rule, alongside
   code 10. The exception is per-script rather than per-code — `vendor-list`'s aggregate failure
   exit is itself one of codes 1–7 (a 3, in the fixture that motivated this) — so the rule as
   stated in §6 holds for every script but `vendor-list`, rather than literally universally.
2. **§10's exit-4 row never states how the recovery terminates.** The row says to offer the two
   paths from `add.md` (separate directory, or guided synthesis via `merge-without-base.md`) and to
   never re-pin without reconciling first, but does not say what happens *after* reconciliation —
   which commit to pin, or that the separate-directory path terminates differently (via
   `vendor-remove` on the original connection, with no `vendor-pin` call at all, mirroring
   `add.md`'s Path 1). Implementation resolved this by pinning the fetched tip `vendor-check`
   reported on stderr — the commit actually reconciled against.
3. **AC-57 requires no-overlap; §11b's prose does not state it.** AC-57 requires that inventory
   spans in the no-base synthesis procedure have "no overlaps", but §11b's totality description
   (step 4) only states that every part must be claimed or listed in `unclaimed`; it does not say
   two items may not claim the same span. §11a's equivalent totality check for the with-base
   procedure does state its analogous rule explicitly ("no `{file, start, end}` triple may appear
   twice"), so §11b's omission reads as a gap rather than a deliberate asymmetry.
4. **AC-51/AC-54's mechanical hunk check assumes short repo-relative filenames that diff 1, as §4
   specifies it, does not produce.** Diff 1 is `git diff --no-index <base-tmp> <local-dir>` against
   a temporary directory and an absolute local-directory path, so its file headers carry those
   temp-directory and absolute-path prefixes rather than a short name like `SKILL.md`. Diff 2's
   headers carry a different prefix — the upstream `path` from the manifest, since `git diff`
   reports paths relative to the repository root regardless of the pathspec that scoped it. Neither
   diff's raw headers match the `{file, start, end}` shape AC-51/AC-54 and the `groups-*.json`
   schema assume. The skill's `merge-with-base.md` — not this specification — now states explicitly
   that file paths must be normalized to be relative to the vendored directory before being
   recorded.
5. **The unified `exit-codes.md` was dropped in favour of per-invocation tables.** §1's file
   listing, §8's load-path table, and AC-61/AC-62/AC-64 all mandate a single `exit-codes.md` that
   every action file instructs reading. That file no longer exists. Each script invocation in the
   prose now carries its own table — exit code, the stdout shape that accompanies it, and the
   required reaction — stated at the point of invocation, so following a procedure never requires
   leaving the file to learn what a code means. The cost is deliberate duplication: the same code
   is described in several files, in the wording each caller needs.

   Concretely: AC-64 no longer applies; AC-61's `exit-codes.md` clause no longer applies (its
   clauses for the two merge files still do); AC-62's reference index lists five supporting files
   rather than six. The two properties the unified file carried globally — that every non-zero exit
   writes its message and remedy data to stderr while leaving stdout empty, and that exit 10 is a
   status rather than a failure — are stated once in `SKILL.md` instead, since they hold for every
   script and would otherwise be repeated in every row.

   The per-directory tables are pinned by a test asserting **set equality** between the codes a
   file tables and the codes its scripts can actually reach, so a table cannot silently omit a
   reachable code or accumulate an unreachable one as the scripts change.
6. **`vendor-check` no longer returns exit 10; only `vendor-list` does.** §6's code table attributes
   10 to both (`vendor-check`, `vendor-list`), §7's `vendor-check` step 6 mandates "exit **10** if
   `upstream_changed` is true, else **0**", and AC-20 states it with a DoD ("the behind fixture
   exits 10 and exits 0 after `vendor-pin`"). `vendor-check` now exits **0** whenever it printed its
   object.

   The reason is that nothing consumed it. `upstream_changed` in the emitted object is the answer to
   "is there work to do", and every consumer reads that field rather than the code: §10's branch
   table branches on the object, and `vendor-list` derives its own aggregate 10 from the reported
   `upstream_changed` values, not from any child's exit status. The only place a child's 10 appeared
   was `vendor-list`'s "did this child succeed" test, which now reads `status === EXIT.OK`. So the
   code carried no information its own stdout did not carry more precisely, while costing a
   "success may also be 10" caveat in every table and every consumer that touches `vendor-check`.

   `vendor-list` keeps 10, and the CI rationale in §6 and Out of Scope is unaffected: that text
   already attaches external scheduling to `vendor-list`'s exit 10 specifically, since `list` is the
   command whose entire output is one aggregate answer a caller may want to gate on without parsing
   JSON. A caller wanting the same signal for a single directory reads `.upstream_changed` from
   `vendor-check`'s object.

   Concretely: AC-20's exit-code clause and its DoD no longer apply; §6's table entry for 10 names
   `vendor-list` alone. AC-21's and AC-22's DoDs, which assert exit **0** for the commit-and-revert
   and outside-the-subpath fixtures, are unaffected — those were already 0.
