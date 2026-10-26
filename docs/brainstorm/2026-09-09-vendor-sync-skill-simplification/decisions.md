# Decision Journal — vendor-sync skill simplification (rewrite of skill docs + script contract)

Predecessor: `docs/brainstorm/2026-09-08-vendored-skill-sync-tooling/` (the original design). This
journal covers the *second pass*: restructuring the skill's instructions and simplifying the
script contract so the agent can grasp exactly what to do. Decisions here that change the
predecessor's design supersede it; the predecessor is not edited.

## Established Facts
<!-- F-N: [status] <fact> (Source: <how verified>)
     status = verified | assumed | REFUTED -->

F-1: [verified] The current skill is 7 markdown files, 764 lines: SKILL.md 89, add.md 139,
sync.md 151, remove.md 61, list.md 19, merge-with-base.md 157, merge-without-base.md 148.
Scripts are 8 `.mjs` files, 1342 lines (lib.mjs 511). Tests: 240 `it(` blocks across 10 files
under `tests/skills/vendor-sync/`. (Source: `wc -l`, `grep -c "it("`, 2026-09-09)

F-2: [verified] Exit-code tables are repeated per invocation site, not per script: `vendor-remove`
is tabled in remove.md AND inside add.md Path 1; `vendor-export` is tabled in add.md (flags form),
sync.md (manifest form) AND merge-without-base.md (both forms); `vendor-pin` in sync.md only but
referenced from three branches. Rows are near-duplicates with wording drift between copies.
(Source: read of all seven files)

F-3: [verified] Decision logic lives in three different shapes in the current docs: (a) tables
whose "Your reaction" cell holds multi-sentence procedures (sync.md branch table, add.md exit
table); (b) headed sections (`## Exit 4 — base commit unresolvable`, `## The cleanliness
precondition`); (c) inline prose conditionals ("If it is `false`, report … and halt"). No single
convention. (Source: read of sync.md, add.md)

F-4: [verified] The exit-code set is {0,1,2,3,4,5,6,7,10}. Code 10 (BEHIND) is emitted only by
`vendor-list`. Code 4 (BASE) by check/inspect only. Code 6 (EXISTS) by add only. Code 7
(ANCESTRY) by add/pin only. Every script's table then has to enumerate which codes it "never"
emits (remove.md: "never exits 4, 5, 6 or 10"; add.md: "never exits 3"; "never exits 6 here").
(Source: lib.mjs EXIT, all script sources, all doc tables)

F-5: [verified] `vendor-pin` emits a stderr *warning* ("pinning a new sha but the vendored
directory has no local changes") that the docs then have to explain away twice in sync.md
("That is not a failure… Pass it on as a note", and again "correctly does *not* fire after the
pristine fast path"). The agent takes no action on it. (Source: vendor-pin.mjs step 4, sync.md)

F-6: [verified] Script stdout formats are mixed: `vendor-check` and `vendor-list` print JSON;
`vendor-add`, `vendor-export`, `vendor-inspect`, `vendor-pin`, `vendor-remove` print `key=value`
lines; `vendor-add` additionally prefixes a `mode=` discriminator. The predecessor's D-72 chose
"machine-read output is JSON; human-read is plain text", but the agent is the only reader of both.
(Source: script sources; predecessor decisions.md D-72)

F-7: [verified] `vendor-add` on a non-empty destination (`mode=has-content`) writes nothing to the
directory but DOES leave `refs/vendor/<slug>` behind. Consequence: add.md Path 1 (vendor into a
different directory) ends with a mandatory `vendor-remove` against the *original* directory to
clean the orphaned ref, with its own exit table; and `vendor-remove` grows an "orphaned=true"
branch that remove.md spends a paragraph explaining. (Source: vendor-add.mjs steps 4/8/9,
vendor-remove.mjs step 2, add.md, remove.md)

F-8: [verified] The guided-merge path in `add` requires three script invocations with hand-carried
state: `vendor-add` (has-content) → `vendor-export --repo --path --sha` (flags-only form, exists
only for this path) → `vendor-add --adopt --sha` (exists only for this path). The doc devotes a
paragraph to why `--adopt` must be last and why the sha must be the one from step 2. (Source:
add.md Path 2; vendor-export.mjs header comment; vendor-add.mjs step 7)

F-9: [verified] `vendor-export` has two forms (manifest form with `--ref`/`--sha` overrides
including a temp-ref dance for an alternate `--ref`; flags-only form). The flags-only form exists
only for add Path 2. The alternate-`--ref` override is used by no documented flow. (Source:
vendor-export.mjs; grep of docs for `--ref` on export calls: none)

F-10: [verified] Custom output schemas the agent must produce (`groups-local.json`,
`groups-upstream.json`, `inventory.json`) are specified by a single JSON example each, embedded
mid-procedure, with field semantics scattered in surrounding prose (e.g. "`decision` stays `null`
throughout Phase A"). No field-by-field schema. (Source: merge-with-base.md, merge-without-base.md)

F-11: [verified] Both merge files carry ~40 lines of identical text: "The verbatim guideline",
"The hazard", and "No mechanical merge" blocks are duplicated verbatim (predecessor D-46 chose
duplication deliberately). (Source: diff of the two files' tail sections)

F-12: [verified] The skill's `tests/skills/vendor-sync/` suite tests scripts only; skill-doc
specs were dropped in commit b986579. So restructuring the markdown breaks no tests; changing
exit codes or stdout formats breaks `contract.test.ts` (20 tests) and the per-script suites.
(Source: git log, contract.test.ts)

F-13: [verified] The house style for skills in this repo (`skills/subagent-driven-development/
SKILL.md`) uses: one-paragraph purpose, `**Core principle:**`, dot-digraph decision diagrams for
"when to use" and "the process", and sibling `*-prompt.md` files loaded by relative path.
(Source: skills/subagent-driven-development/SKILL.md)

F-14: [verified] skill-creator's writing guidance (the "Skill Writing Guide", "Writing Style" and
"How to think about improvements" sections of its SKILL.md) reduces to these practices:
  1. Three-level progressive disclosure: metadata (always loaded) → SKILL.md body (<500 lines,
     loaded on trigger) → bundled resources loaded only as needed; scripts execute without being
     loaded. Reference files are pointed to from SKILL.md *with guidance on when to read them*.
  2. Organise by variant so the agent reads only the file for the case at hand (`cloud-deploy/
     references/aws.md|gcp.md|azure.md`).
  3. Imperative form.
  4. Output formats: give an exact template the agent fills in, not a description of one.
  5. Examples: Input → Output pairs.
  6. Explain *why* instead of heavy-handed MUSTs; ALWAYS/NEVER in caps and rigid structures are a
     yellow flag — reframe with the reasoning so the model can generalise.
  7. Theory of mind: write for a smart reader; keep general, don't overfit to one example.
  8. Keep it lean: remove anything not pulling its weight; read transcripts to find waste.
  9. Repeated multi-step work → bundle a script and tell the skill to use it.
  10. Draft, then re-read with fresh eyes.
  All "when to use" information goes in the frontmatter description, not the body.
  (Source: claude-plugins-official/skill-creator/skills/skill-creator/SKILL.md lines 62–139,
  296–306; read 2026-09-09)

F-15: [verified] The user's own additional practices for this skill (stated 2026-09-09):
  A. **Completeness** — every error case the agent can encounter has a documented handling; an
     undocumented case leaves the agent free to take the wrong action.
  B. **Progressive disclosure per action** — the agent doing `add` learns nothing about `sync`;
     scripts are explained only where the current action needs them.
  C. **Explicit termination** — tell the agent when it is finished; better, structure the
     decisions so that "finished" follows from the structure itself.
  D. **No half-knowledge** — never give an instruction that can only be understood by knowing the
     script's internals or the design spec; the skill text must be self-sufficient.
  The user does not want the skill-creator's eval loop (red/green runs); the practices are the
  deliverable, not the process. (Source: user message)

F-16: [verified] Nothing is vendored yet: no `.vendor.json` exists in the repository and no
`refs/vendor/*` refs exist. The `brainstorm` skill the predecessor was motivated by is still an
ordinary tracked copy at `skills/brainstorming/`. So there is no migration or compatibility
constraint on the manifest format, ref names, exit codes or stdout shape — the contract can change
freely. (Source: `find . -name .vendor.json`, `git for-each-ref refs/vendor`, 2026-09-09)

F-17: [verified] The base ref's justification is unchanged by this redesign. Predecessor F-48: the
fetch refspec `+refs/heads/<ref>:refs/vendor/<slug>` MOVES the tracking ref, so after an upstream
force-push the old base commit is unreferenced and prunable by `git gc`. Predecessor F-54: a
two-point tree diff needs no ancestry, so with the base commit still present an upstream rewrite
leaves the with-base merge fully functional (`base_is_ancestor_of_tip: false`, informational).
Without the base ref the same event degrades to base-missing → no-base synthesis, in which every
accumulated local modification loses its attribution. This redesign still fetches into a moving
tracking ref and its scratch copy of the base tree is transient (removed at `--continue`), so
between syncs the refs are the only GC roots. Refetching cannot recover a rewritten-away base
(predecessor D-19). (Source: predecessor decisions.md F-48, F-52–F-54, D-19, D-75, D-89; re-read
2026-09-10)

F-18: [verified] Mechanics carried forward unchanged from the current implementation, each verified
in the current scripts/skill and decided in the predecessor journal: slug derivation (`lib.mjs`
`deriveSlug`, then `git check-ref-format`; predecessor F-39/F-40/D-50); canonical manifest
serialization — two-space indent, fixed key order, trailing newline (`lib.mjs`
`serializeManifest`; predecessor D-85); frontmatter `disable-model-invocation: true` and the
completeness gate including "never infer the action from the argument shape" (current SKILL.md;
predecessor D-55/D-68); `commits_behind` reported as `null` when the base is not an ancestor of
the tip (`vendor-check.mjs`; predecessor D-91); a start that fails after creating the tracking ref
deletes it again (`vendor-add.mjs` step 9; predecessor D-78). (Source: current sources read
2026-09-09; predecessor decisions.md)

## Decisions & Rationale
<!-- D-N: [status] **<decision summary>**
     status = accepted | superseded-by D-M
     - Evaluated / Rejected / Chosen because -->

D-1: [accepted] **Scope: everything is open — skill markdown, script CLI/exit/stdout contract,
verb set, AND the predecessor design's invariants.** Tests are rewritten to match whatever the
new contract is.
- Evaluated: docs only; docs + minimal script fixes; docs + script contract (invariants fixed);
  docs + contract + invariants.
- Rejected docs-only / minimal fixes: the mess in the docs is partly *caused* by script-side
  special cases (F-5, F-7, F-8, F-9); documenting them better would still leave them.
- Rejected contract-with-fixed-invariants: user chose to let invariants (base ref, "skill never
  runs git", merge-procedure substance) be re-examined rather than inherited unquestioned.
- Chosen because: user decision, 2026-09-09. Any invariant kept must be kept on its own merits and
  re-recorded here, not by reference to the predecessor.

D-2: [accepted] **The rewrite is built against the practice set F-14 + F-15, not against the
skill-creator's test-and-iterate loop.** No eval harness, no baseline runs.
- Evaluated: run skill-creator's eval loop; adopt its writing practices only; invent our own
  checklist.
- Rejected eval loop: user explicitly declined ("I don't want to follow the skills process with
  red green development").
- Chosen because: the practices are concrete enough to design and review against by reading.

D-3: [accepted] **"Explain why" and "lean" are not in tension: every instruction may carry its
reason, stated concisely and without chattiness.** The test is not word count but whether the
reason is stated once, in the sentence it belongs to, and not re-argued elsewhere.
- Evaluated: one-clause-per-rule cap; why only at deviation points; keep current depth.
- Rejected a hard clause cap: user rejected the framing as a trade-off — the failure mode in the
  current docs is *chattiness and repetition* (the same rationale re-argued in several places,
  F-5, F-11), not the presence of reasons.
- Chosen because: user decision, 2026-09-09.

D-4: [accepted] **No new research phase.** Every git-behaviour fact this redesign rests on was
verified in the predecessor journal (its F-13 fetch-into-ref, F-22 refs as GC roots, F-35
archive|tar extraction, F-36 ancestry check, F-52/F-53 refs do not survive clone, F-54 two-point
tree diff needs no ancestry) and the skill-writing guidance is F-14. The remaining questions are
design choices, not knowledge gaps.

D-5: [accepted] **Every script prints exactly one JSON object on stdout, for every outcome.**
Supersedes the predecessor's D-72 (JSON for machine-read, plain text for human-read).
- Evaluated: JSON always; key=value always; keep the current mix.
- Rejected key=value: nested data (`vendor-list`'s per-connection objects) needs an ad-hoc prefix
  convention, i.e. a second grammar anyway.
- Rejected the mix: two grammars plus a `mode=` discriminator line for the agent to know (F-6);
  there is no human reader to justify the plain-text half.
- Chosen because: one parsing rule; field meanings can be documented once in the action file that
  consumes them (F-15 D). User decision, 2026-09-09.

D-6: [superseded-by D-15] **Error model: exit 0 = ran, exit 1 = error. On exit 1 the JSON object is
`{ error: { recovery: "fixable" | "abort", message, hint, data? } }`. The two handlings are written
once in SKILL.md; no action file carries an error table.** Supersedes the predecessor's D-18/D-26
(one exit code per failure class) and D-81 (message on stderr, stdout empty).
- Inventory that motivated it: every existing exit code sorts into three buckets — success/report;
  the agent can fix it and re-run (its own call was wrong, OR the user's input needs correcting,
  with a listing supplied by the script); stop this action (hard failures, dirty tree, and the
  redirects: already vendored / not vendored / base unresolvable / unsluggable name — each with a
  named recourse in `hint`).
- Evaluated: three values retry/ask/abort; two values fixable/abort; keep numbered codes.
- Rejected three values: user preferred a single `fixable` bucket; the agent tells from `message`
  whether it can correct the call itself or must ask the user for corrected input.
- Rejected numbered codes: the per-action tables and the "never emits 4, 5, 6" footnotes (F-4)
  are exactly the mess being removed; a number requires the spec to interpret (F-15 D).
- Chosen because: user decision, 2026-09-09. `fixable` = correct the input (yours or the user's)
  and re-run; `abort` = report `message` + `hint`, the action is finished (structural termination,
  F-15 C). stderr carries only git's raw output, when relevant, for quoting.

D-7: [accepted] **Flow model: one script per action (`vendor-add`, `vendor-sync`, `vendor-remove`,
`vendor-list`). `add` and `sync` are called once to *start*; the returned object names the situation;
the agent decides and acts; `--continue` finalizes; `--abort` cancels. Progress is recorded as an
`in_progress` marker (action + target sha) in the manifest, in the manner of `git rebase --continue`.**
`vendor-check`, `vendor-inspect`, `vendor-export` and `vendor-pin` cease to exist as scripts.
Supersedes the predecessor's D-5/D-20/D-35/D-39/D-77 (verb set, export, adopt-finalize).
- Mapping verified against every current branch (list; remove; add empty / add has-content; sync
  up_to_date / pin_only / pristine_update / merge_needed / base-unresolvable / dirty / already
  in_progress): each is one start, at most one continue, and continue is offline and deterministic
  (no fetch, no second decision).
- What it removes structurally: the "pin the same sha you exported" doctrine (start records
  `target_sha`, continue pins it); the "manifest written last" invariant and `--adopt` (an
  `in_progress` marker is a *better* abandoned-merge signal than an absent manifest — every script
  sees and names it); the temp-directory/shell-variable section (fixed scratch paths; a merge
  survives context loss because re-running start reports `in_progress` with the paths).
- Evaluated: adopt; adopt but keep `pin` as a verb; revise.
- Rejected keeping `pin`: one more script to document for no behavioural difference — continue IS
  the pin.
- Chosen because: user's proposal, confirmed 2026-09-10 after the critique below (Q-1, D-8..).

D-8: [accepted] **Scratch lives at the repository root, `.vendor-sync/<slug>/` (upstream tree, base
tree, `local.diff`, `upstream.diff`), gitignored as one folder. The vendored directory keeps only the
small tracked manifest, which now also carries the `in_progress` marker.**
- Evaluated: repo-root scratch; in-directory `<dir>/.vendor-sync/` (user's original sketch);
  in-directory after spiking Q-1.
- Rejected in-directory: scratch copies of the content inside the directory being diffed
  contaminate `local.diff` unless the scripts obey an ordering rule (compute diffs before writing
  scratch; `list` skips diffs while in_progress) and self-gitignore; and Q-1's skill-discovery
  hazard would need verifying.
- Chosen because: no contamination rule, no discovery hazard, one gitignore line. Closes Q-1 as
  moot. User decision, 2026-09-10.

D-9: [superseded-by D-23] **A start call writes to the vendored directory whenever no merge is needed;
`--continue` exists only for the two merge states.** Concretely: `add` into an empty/absent
directory materializes files and manifest at once (state `added`); `sync` with identical content
but a moved sha pins at once (state `pinned`); `sync` with no local modifications replaces the
files and pins at once (state `updated`). `merge_needed` (with base) and `base_missing`/has-content
(without base) prepare scratch, set the `in_progress` marker, and wait for `--continue`.
- Evaluated: start never writes (uniform, one extra call, structural pre-write confirmation);
  start writes when no merge is needed; start writes for add only.
- Rejected never-writes: user judged the extra call and confirmation step not worth it for cases
  where nothing of the user's can be lost.
- Consequence to carry into the skill text: the user sees the resolved repo/path/sha *after* the
  write, in the report; a wrong `--ref`/path is recoverable with `remove` (files are ordinary
  working-tree changes). The report must therefore state the identity plainly.
- Chosen because: user decision, 2026-09-10. Supersedes the predecessor's "echo identity before
  any write" rule (its D-64) for these states.

D-10: [superseded-by D-22] **`--abort` clears the marker, removes the scratch folder, and restores the
vendored directory to its committed state (tracked files reset to HEAD, untracked files under the
directory removed).** For a directory not yet known to git (an aborted `add` into an existing,
never-committed directory) files are left untouched — there is no committed state to restore.
- Safety argument: start refuses to begin on a dirty tree, so HEAD is exactly the pre-merge state;
  restoring it loses only work authored during the aborted merge.
- Skill-side consequence: the agent confirms with the user before running `--abort`, naming that
  authored changes will be discarded (ASK FIRST boundary).
- Evaluated: restore committed state; bookkeeping only; no abort.
- Rejected bookkeeping-only: leaves a half-merged directory indistinguishable from deliberate local
  edits at the next sync.
- Rejected no-abort: the only recovery would be hand-editing the manifest, which the design forbids.
- Chosen because: user decision, 2026-09-10.

D-11: [accepted] **Keep `refs/vendor/<slug>-base`, created at add and moved at every pin, in step
with the manifest's `sha`.** Carries the predecessor's D-75 forward on its own merits (F-17).
- Evaluated: drop (one ref, less code); keep.
- Rejected drop: the "lands in base_missing anyway" argument understated the cost — base_missing
  is the degraded no-base path, not an equivalent fallback; the base ref is what keeps an upstream
  force-push from forcing it in the clone that pinned. Zero agent-visible surface, ~10 lines.
- Chosen because: evidence in F-17; the user asked to be sure before removing, 2026-09-10.
- Reconfirmed with the per-clone limit on the table (predecessor F-52/F-53: `refs/vendor/*` do not
  survive `git clone`, so `-base` defends only the clone that pinned). Also evaluated: drop and
  accept the residual in every clone; a committed base copy (`.vendor-sync/<slug>/base/` tracked)
  for clone-independent coverage. Rejected the committed copy for the predecessor D-89 reasons —
  permanent duplicate of every vendored directory, editable by mistake, rewritten on each pin.
  Accepted residual: after an upstream history rewrite, clones other than the pinning one take
  the no-base path until someone pins forward. User decision, 2026-09-10.

D-12: [accepted] **Manifest stays one file, `<dir>/.vendor.json`, tracked. Fields: `slug`, `repo`,
`path`, `ref`, `sha`, and `in_progress` — `null` normally, `{ action: "add" | "sync", target_sha }`
while a merge is open.** Scratch paths are not stored: they are derived (`.vendor-sync/<slug>/`).
- Evaluated: single file with marker; `.vendor-sync/manifest.json` folder; two files (identity +
  gitignored progress file).
- Rejected the folder: a folder for one file, since scratch lives at the repo root (D-8).
- Rejected two files: a second schema to document; the marker being committed mid-merge is
  harmless (the skill tells the user to commit only after continue) and even informative.
- Chosen because: one file, one schema, documented once. User decision, 2026-09-10.

D-13: [accepted] **On exit 0 every script names the situation in a `state` field, and reports the
facts it derived it from alongside.** Follows from D-7 ("the returned object names the situation");
recorded separately because it replaces the predecessor's truth table of four booleans in sync.md.
State vocabularies are fixed per script in the design step. The agent branches on `state` only;
the facts (shas, counts, file lists) feed the report.

D-14: [accepted] **Every action file has the same skeleton — `Inputs` → `Run` (one command) →
`Outcomes` → `Report` — and every Outcome is a `### <state>` heading with numbered steps beneath,
whose last line is always either **Done** or "run `--continue`, report, Done".** No procedures in
table cells; no inline conditionals as the sole home of a decision.
- Evaluated: heading per state; one table with short cells (+ subsections for merges); dot digraph
  + prose (house style of subagent-driven-development); headings plus a summary table.
- Rejected table: multi-step states spill into subsections, so two shapes coexist (the current
  problem, F-3). Rejected digraph: the graph and the prose say the same thing twice, and a second
  notation to read. Rejected headings+table: duplication for a glance the `###` scan already gives.
- Chosen because: one shape for simple and multi-step states alike; termination is structural —
  the last line of every entry (F-15 C). User decision, 2026-09-10.

D-15: [accepted] **Error model, corrected: three exit codes. 0 = ran, JSON has `state`. 1 =
recoverable, JSON is `{ error: { message, hint, data? } }` — correct the input (yours or the
user's) and re-run. 2 = abort, same error object — report `message` + `hint`, the action is
finished.** Replaces D-6, whose "two values fixable/abort" the user had understood as two exit
codes (the `recovery` field is redundant once the exit code carries the bucket).
- Bucket assignment stays as inventoried under D-6: usage, dir outside repo, absent branch (with
  `data.branches`), absent path / path is a file (with `data.entries`), `--sha` not an ancestor →
  exit 1. Already vendored, not vendored, manifest malformed, uncommitted changes, open marker,
  not a git repo, fetch/extract/diff failures → exit 2, each with a `hint` naming the recourse.
- The two handlings are written once in SKILL.md; no action file carries an error table.
- Chosen because: user clarification, 2026-09-10.
- Addendum (review, 2026-09-10): "unsluggable directory name" moves from D-6's stop bucket to
  exit 1 — the directory name is the user's input and choosing another one is exactly "correct the
  input and re-run". "Already vendored" stays exit 2: the recourse is a different action, not a
  corrected input.

D-16: [accepted] **Design section 1 — script contract and the four scripts.** Universal contract:
one JSON object on stdout; exit 0 carries `state` + facts, exit 1/2 carry `error: { message, hint?,
data? }` (D-15); stderr only for git's own output; a directory with an open `in_progress` marker
accepts only `--continue`/`--abort` of the recorded action, every other script reports it and stops.
- `vendor-add <repo> <path> <dir> [--ref] [--sha]`: states `added` (dir empty/absent; files,
  manifest, base ref written) and `merge_needed` (dir has *committed* content; manifest written
  with marker, upstream exported to `.vendor-sync/<slug>/upstream/`, nothing else touched).
  `--continue` → `added`; `--abort` → restore HEAD, remove manifest, scratch, tracking ref →
  `aborted`. Refines D-10: `add` into a non-empty directory requires it to be clean in git (an
  untracked directory counts as dirty), so `--abort` can always restore and the "directory not yet
  known to git" case disappears.
- `vendor-sync <dir>`: states `up_to_date`, `pinned`, `updated`, `merge_needed` (base + upstream
  trees and `local.diff`/`upstream.diff` in scratch, marker set), `base_missing` (upstream tip in
  scratch, marker set), `in_progress`. `--continue` → pins recorded `target_sha` → `synced`;
  `--abort` → restore HEAD → `aborted`. Diff headers normalized by the script to `a/<file>
  b/<file>` relative to the vendored directory (removes the path-normalization paragraph, F-10).
- `vendor-remove <dir>`: one shot after agent-side confirmation → `removed`; open marker → exit 2.
  No orphan-ref case remains.
- `vendor-list`: no args; `{ state: "listed", connections: [{ dir, slug, repo, ref, pinned_sha,
  upstream_tip, status, local_modifications, commits_behind, error? }] }`, `status ∈ up_to_date |
  behind | base_missing | in_progress | error`; exit 0 whenever it ran. Exit 10 dropped (D-15).
- Errors, exit 1: usage, dir outside repo, absent branch (`data.branches`), absent path / is a file
  (`data.entries`), `--sha` not an ancestor. Exit 2: already vendored (hint: sync), not vendored
  (hint: add), manifest malformed, uncommitted changes, open marker, not a git repo, fetch/extract/
  diff failure.
- Confirmed by user 2026-09-10.

D-17: [accepted] **The agent-written merge artifacts stay as they are: `groups-local.json` and
`groups-upstream.json` for the with-base procedure, `inventory.json` for the without-base
procedure** (predecessor D-80 carried forward on its merits: totality is checkable, decisions are
collected before authoring, the report reads from them). Changes from today: they live in the
scratch folder at fixed names (`.vendor-sync/<slug>/…`) so an interrupted merge resumes from disk
and `--continue`/`--abort` clean them up; and each schema is documented as a field-by-field table
plus one example (fixes F-10).
- Evaluated: keep both as they are; one unified schema for both procedures; drop; decisions-only.
- Rejected unified schema: the two procedures group different things (hunks vs. idea spans) and are
  never loaded together, so unification buys nothing the agent would see.
- Rejected drop / decisions-only: totality would become a claim rather than a check.
- Chosen because: user decision, 2026-09-10.

D-18: [accepted] **Design section 2 — skill files.** Layout: `SKILL.md`, `add.md`, `sync.md`,
`remove.md`, `list.md`, `merge-with-base.md`, `merge-without-base.md`, `scripts/{vendor-add,
vendor-sync,vendor-remove,vendor-list,lib}.mjs`. Disclosure rules: SKILL.md holds only what applies
to every action (JSON/exit contract, the two error handlings, the `in_progress` rule, boundaries
with one-line reasons, dispatch) and names no state — target ~60 lines; an action file mentions no
other action (a script `hint` naming one is relayed, not explained); object fields are documented
inside the Outcome entry that consumes them; merge files are entered only from `merge_needed` /
`base_missing` entries and end with "return to the entry that sent you here and run `--continue`".
Shared merge text (verbatim guideline, no mechanical merge) is duplicated in both merge files, cut
to ~6 lines each with reason (cheaper than a third file to load; each file self-sufficient). Each
action file ends with a fill-in report template. Estimated ~420 lines total vs. 764 today (F-1).
- Confirmed by user 2026-09-10.

D-19: [accepted] **Design section 3 — merge procedures.** Substance carried forward from the
predecessor (D-31/D-32/D-33/D-46/D-47/D-49/D-70): two-phase with-base procedure (identify local
intent — standing, corrections only — then judge every upstream change with an explicit
adopt/decline, no default adoption; author verbatim from `upstream.diff`; declines need no record),
and the idea-level synthesis without a base (inventory per side, totality via `unclaimed`,
keep/drop/combine, near-verbatim authoring, full-result review before writing). Changes: both files
open with an entry contract ("you arrive with `scratch` containing …; when done return to the entry
that sent you and run `--continue`") and never know their caller; the export step and the
path-normalization paragraph are gone (the script provides the trees and normalized diffs, D-16);
rationale is one clause per rule (D-3); artifacts per D-17 with field tables.
- No-default-adoption re-evaluated and kept: the alternative (adopt uncontested changes silently)
  means the user never sees what came in — the predecessor's pre-mortem finding stands.
- Confirmed by user 2026-09-10.

D-20: [accepted] **Design section 4 — testing.** Keep the fixture infrastructure (local upstream
git repo + consumer repo, `tests/skills/vendor-sync/_support/`). Rewrite suites to the four scripts:
one test per state and per error; start→continue and start→abort round trips asserting manifest,
marker, both refs, scratch presence, and that abort restores HEAD; a contract suite (exactly one
JSON object on stdout for every run, exit 0 ↔ `state`, exit 1/2 ↔ `error.message`, no shell, stderr
only for git output). **No doc tests**: the state-completeness check (headings ↔ script states) was
offered and declined; completeness of the markdown is verified by review.
- Rejected doc↔script state test: user preferred not to couple tests to markdown structure.
- Confirmed by user 2026-09-10.

D-21: [accepted] **An open `in_progress` marker is never resumed. `sync` or `add` on such a
directory exits 2: message names the unfinished action and its `target_sha`; hint: "run `--abort`
to discard it and start again; use `--continue` only if you know the merge was completed and the
directory holds the result".** Narrows D-7 and D-16: `sync` has no `in_progress` state; the
"resuming" entries in `add.md`/`sync.md` do not exist.
- Reason (user, 2026-09-10): an agent that did not set the marker cannot know where the merge
  stopped — which decisions were applied, which files were authored — so "resume" would be a guess
  presented as a continuation. Only the user may know; the exit-2 hint hands the choice to them.
- Consequences: every action file's Outcome entries are strictly linear; pre-mortem failure mode 1
  (start dies half-way, marker open with partial scratch) cannot lead to a merge against partial
  diffs — the only exit is `--abort`. Start still writes the marker last and wipes
  `.vendor-sync/<slug>/` when no marker is open, as script hygiene only.
- Artifacts (D-17) lose the "resume from disk" benefit; totality check and report source remain.

D-22: [accepted] **No `--abort`. An unfinished merge is discarded by the user reverting the
vendored directory in git (IDE rollback or `git checkout`), which restores the tracked manifest
(marker back to `null`) and every tracked file; start overwrites any existing `.vendor-sync/<slug>/`
when no marker is open.** Supersedes D-10; amends D-16 (no `--abort` flag, no `aborted` state) and
D-21 (the exit-2 message is user-directed information: what is open, since which sha, and that
reverting the directory including the manifest discards it — the agent still only stops).
- Why it holds: start requires a clean tree, so HEAD is exactly the pre-merge state and a plain
  revert reaches it. Left-behind untracked files (authored during the merge; for `add`, the new
  manifest itself) make the next start refuse with "uncommitted changes" until removed — the
  correct answer, self-explaining. A tracking ref left by an abandoned `add` is tolerated: the next
  fetch overwrites it; at worst a small GC root.
- Scratch overwrite is safe because start reaches it only when no marker is open, i.e. the
  leftovers always belong to a merge nobody can resume (D-21).
- Evaluated: `--abort` restoring HEAD (D-10); `--abort` with a dry-run preview of `changed_files`;
  a user-invocable `abort` verb; `remove` doubling as abort; no abort (chosen).
- Rejected all abort variants: the design already forbids the skill from acting on a merge it did
  not start (D-21), and git already owns "discard my uncommitted changes" — a script for it would
  duplicate git with a smaller safety margin.
- Chosen because: user proposal, 2026-09-10. Pre-mortem failure mode 2 (abort discards unrelated
  work) is void — no script discards anything.

D-23: [accepted] **Two-phase everywhere: a start call never writes into the vendored directory
except the manifest marker; every write to the user's files happens in `--continue`, after the agent
has shown what it will do.** Supersedes D-9; amends D-16's state vocabularies:
- `vendor-add`: `ready` (dir empty/absent; scratch has the upstream tree, `<dir>/.vendor.json`
  written with `in_progress: {action: "add", target_sha}`, directory created if needed) and
  `merge_needed` (dir has committed content). Both carry `dir slug repo path ref sha files scratch`.
  `--continue` → extracts files (ready) or keeps the authored result (merge_needed), finalizes the
  manifest, sets the base ref, removes scratch → `added`.
- `vendor-sync`: `up_to_date` (one call, nothing to write); `pin_ready` (content equal, sha moved);
  `update_ready` (no local modifications; carries `files` that would change); `merge_needed`;
  `base_missing`. All but `up_to_date` set the marker. `--continue` → pins `target_sha`, and for
  `update_ready` replaces the files first → `synced` with `sha_before sha_after files`.
- Reason: pre-mortem failure mode 3 — a wrong `--ref`/path that names something real writes files
  before anyone looks — exists only because of D-9's exception, which saved one call. The uniform
  rule restores the predecessor's "confirm identity before any write" structurally.
- Discarding an unfinished start: revert the directory (D-22); for a fresh `add`, delete the
  directory holding only the manifest.
- Chosen because: user decision, 2026-09-10.

D-24: [accepted] **Pre-mortem mitigation — scratch committed by accident.** Start writes
`.vendor-sync/.gitignore` containing `*` (a self-ignoring folder) before writing anything else into
`.vendor-sync/`. No entry in the project's `.gitignore` is required; `git status` never shows the
folder, so it cannot trip the clean-tree check either. Lands as an ALWAYS boundary and an
acceptance criterion (after any start, `git status --porcelain` shows nothing under
`.vendor-sync/`). Confirmed by user 2026-09-10.

D-25: [accepted] **Pre-mortem mitigation — `--continue` before the merge happened.** `--continue`
is gated on the merge artifacts (D-17): for a with-base merge, `scratch/groups-upstream.json` must
exist with `unassigned` empty and every group's `decision` non-null; for a without-base merge
(`base_missing`, `add`'s `merge_needed`), `scratch/inventory.json` must exist with `unclaimed` empty
and `outcomes` non-empty. Otherwise exit 2. `ready`/`pin_ready`/`update_ready` have no procedure
and no gate. Turns "the agent says it finished" into "the record on disk is complete"; cannot verify
the authored files match the decisions, and does not claim to. Lands as acceptance criteria on
`--continue` and a NEVER boundary (never run `--continue` with a decision still open). Confirmed by
user 2026-09-10.

Pre-mortem summary (Step 6): five failure modes examined. (1) start dies half-way with the marker
open → void under D-21/D-22 (no resume exists; marker-last and scratch-wipe kept as hygiene, D-21).
(2) abort discards unrelated work → void under D-22 (no script discards anything). (3) files written
before anyone looks → D-23. (4) scratch committed → D-24. (5) continue before the merge → D-25.

D-26: [accepted] **The marker records the started state: `in_progress: { action: "add" | "sync",
state: <the state start returned>, target_sha }`.** Refines D-12. `--continue` reads `state` to know
what to do (extract / replace / pin only) and which artifact gate (D-25) applies, instead of
re-deriving the situation — re-deriving would be wrong after the agent authored files. Derived
during spec writing, 2026-09-10.

D-27: [accepted] **The skill runs no git command itself, ever — re-recorded on its own merits.**
Every fact the agent acts on comes from a script's JSON object (D-5, D-13); a fact obtained by
running git ad hoc would bypass the `state` model, the marker rule (D-21) and the error buckets
(D-15), and reintroduce the half-knowledge the rewrite removes (F-15 D). The one thing the agent
writes outside the scripts is the merge artifacts in scratch (D-17). Confirmed as part of the
Section 2 boundaries the user accepted (D-18); made explicit here because D-1 requires kept
invariants to be re-recorded rather than inherited.

D-28: [accepted] **`--continue` after a merge state returns the decisions it gated on:** `synced`
and `added` carry `decisions` — from `groups-upstream.json` (`name`, `decision`, `reason` per
group) or from `inventory.json` (`outcomes`) — read before scratch is removed. The completion
report is filled from the object, so the report's data source still exists when the report is
written (review finding: scratch is gone after `--continue`). Consistent with D-5/D-13: everything
the agent reports is in the object.

D-29: [accepted] **"Already vendored" means the directory has a manifest — nothing else.** An
existing `refs/vendor/<slug>` without a manifest is not a connection: the next start's fetch
overwrites it (`+` refspec), as D-22 tolerates. A start that fails after creating the tracking ref
still deletes it (F-18) as hygiene, so leftovers arise only from a discarded fresh `add` (D-23),
which must remain re-addable. Resolves the review contradiction between the spec's ref-existence
clause and D-22.

Grounded review (Step 8, 2026-09-10): a fresh subagent reviewed both files cold; 21 failures,
0 leaked rejects, notation clean. Resolved: unsluggable-name bucket → D-15 addendum; "already
vendored" ref clause vs D-22 → D-29; "skill runs no git" grounding → D-27; report data source after
scratch removal → D-28; ungrounded carried-forward mechanics → F-18 cited in spec §2/§5.1;
fresh-add discard path, `lib.mjs` in overview, D-4 mention, `up_to_date` condition, sync start step
order (clean check before fetch), identity fields on every sync state, §3 "every other call" scope,
`list` fetch vs "writes nothing" (AC-34 reworded to working tree/manifests/scratch), AC-35/38/39
DoDs made executable — all edited in spec.md. No finding left as an open question.

## Rejected Approaches

Separate facts-only scripts per git operation (check / inspect / export / pin), the predecessor's
D-5/D-36 shape: the agent had to carry state (shas, temp paths) across three or four calls, and
every hand-carried value needed a paragraph of doctrine (add.md Path 2, sync.md exit-4). Replaced
by D-7's start/continue with the state recorded in the manifest. Reconsider only if a flow appears
that needs two decisions between writes.
<!-- <Approach name>: <why rejected, what would have to change to reconsider> -->

## Open Questions / Assumptions
<!-- Q-N: [assumption] <unresolved question> -->

Q-1: [closed by D-8 — moot] Does Claude Code's skill discovery walk into dot-directories? If scratch copies
(`.vendor-sync/upstream/SKILL.md`, `.vendor-sync/base/SKILL.md`) live inside a vendored skill
directory, a mid-merge second registration of the skill would be the consequence.
- Current assumption: unknown; treated as a hazard of in-directory scratch placement.
- Impact if wrong (i.e. discovery does descend): in-directory scratch is unsafe for vendored
  skills, the primary use case; scratch must live outside the vendored directory.
