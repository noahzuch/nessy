# Decision Journal — Vendored Skill Sync Tooling

## Established Facts

F-1: [verified] Upstream `qaware-internal/agentic-marketplace` is a multi-plugin monorepo; the
     target skill lives at the subpath `plugins/brainstorm/skills/brainstorm/` — 5 markdown
     files, ~630 lines total. (Source: inspected local marketplace clone at
     ~/.claude/plugins/marketplaces/qaware-agentic-marketplace)

F-2: [verified] That subpath has exactly 1 commit in its history as of the local clone
     (HEAD ac7367c, 2026-08-14). Upstream churn on the vendored content is currently very low.
     (Source: `git rev-list --count HEAD -- plugins/brainstorm`)

F-3: [verified] Claude Code discovers plugin skills at `skills/<name>/SKILL.md`. A git
     submodule mounted at `skills/<name>/` would place the file one level too deep
     (`skills/<name>/skills/brainstorm/SKILL.md`), requiring a symlink or copy step anyway.
     (Source: plugin layout of this repo + upstream repo structure)

F-4: [verified] `git apply -3` resolves the `index <old>..<new>` blob SHAs from the patch
     header against the object store of the repo it runs in. Upstream blobs must therefore be
     present in THIS repo, not in a side clone, or three-way apply fails with "repository
     lacks the necessary blob" — losing the conflict-marker behaviour that motivates the whole
     approach. (Source: git semantics; git 2.50.1 available locally)

F-5: [verified] The local `skills/brainstorming/` skill is referenced from
     `skills/writing-plans/SKILL.md:26` and keyed as `brainstorming` in
     `src/shared/config.ts:29`, so its directory/skill name is not free to change without
     touching both. (Source: grep over repo)

F-6: [verified] Local divergence from upstream is concentrated, not smeared: frontmatter
     (`name`, `allowed-tools`), the "Output Location" section (upstream lines 148-176), two
     template-path references (upstream lines 200, 313), the terminal-state/handoff section,
     and an `extraContext` injection point. Everything else can be taken verbatim.
     (Source: diff-read of both SKILL.md files)

F-7: [verified] This repo's script convention is plain-node `scripts/*.mjs` invoked from
     npm scripts (`scripts/merge-hooks.mjs`, `scripts/bump-version.mjs`); no build-tool or
     TS involvement for maintenance scripts. (Source: package.json, scripts/)

F-8: [verified] The project has no `## Spec/Decisions Location and Format` convention section
     in CLAUDE.md, and `BRAINSTORM_OUT_LOCATION` is unset, but `docs/brainstorm/` is already in
     use (`docs/brainstorm/2026-08-13-sdlc-mode-nessy/`), matching the skill default.
     (Source: printenv, grep CLAUDE.md, ls docs/brainstorm)

F-9: [verified] `git apply -p<n>` counts the `a/` prefix that `git diff` emits, so the strip
     depth is `components(path) + 1`, NOT `components(path)`. For
     `plugins/brainstorm/skills/brainstorm` (4 components) the correct flag is `-p5`; `-p4`
     silently retargets to `skills/brainstorming/brainstorm/...` and fails with "does not exist
     in index". The script MUST derive this as components+1.
     (Source: spike, both values run against a real vendored copy)

F-10: [verified] Non-overlapping upstream changes apply fully automatically. A synthetic
     upstream v2 touching Key Principles, Step 3 wording, a new `references/*.md` file, and the
     spec template applied with exit 0, zero conflict markers, all local modification sites
     intact, and the new file created. Adds/deletes are handled (git falls back to direct
     application for new files, which is not an error). (Source: spike TEST 1)
     Scope correction: the clause "adds/deletes are handled" covers upstream ADDS only.
     Upstream edits to a LOCALLY-DELETED file are not handled — see F-14.

F-11: [verified] An overlapping upstream change — upstream restructuring the exact section that
     was locally replaced — yields exactly ONE conflict hunk, the file staged `UU`, exit 1, with
     both sides fully present between `<<<<<<< ours` / `>>>>>>> theirs`. The conflict is
     well-scoped and semantically legible: a reader sees "my config lookup" vs "their new 5-rung
     ladder + premortem.md artifact + boundary rule" and can merge it by hand in minutes. This is
     NOT the unresolvable mess the drastic-change worry assumed. (Source: spike TEST 2)

F-12: [verified] Non-conflicting lines ADJACENT to a conflict merge silently. Upstream's rename
     of the heading `## Output Location` -> `## Artifact Location` landed outside the conflict
     markers, leaving a locally-authored body under an upstream-renamed heading. A conflict
     resolution must therefore be reviewed in surrounding context, not only at the markers.
     (Source: spike TEST 2)

F-13: [verified] The F-4 remedy works: `git fetch --no-tags <repo> +refs/heads/<ref>:refs/vendor/<slug>`
     puts upstream blobs in this repo's object store and `-3` then succeeds. Additionally,
     `git diff <sha>:<upstream-path>/F HEAD:<local-path>/F` produces the "what did I change
     locally" view across the path rename (exit 0, 9 legible hunks, 19+/26- on the real modified
     skill) with no extra bookkeeping. Both diffs the merge needs are one git command each.
     (Source: spike)

F-14: [verified] `git apply` is ATOMIC: a single unpatchable file aborts the entire patch and
     nothing is applied. When upstream modifies a file that was deliberately deleted locally
     (e.g. `references/claude-md-convention.md`, dropped because harness config supersedes it),
     apply fails with "does not exist in index", exit 1, and every OTHER change in that update
     is blocked too. This recurs on every subsequent upstream touch of that file, so the pain is
     permanent, not one-off. (Source: spike CASE A)

F-15: [verified] Git pathspec exclusion solves F-14 deterministically. Adding
     `":(exclude)<path>"` to the `git diff` invocation means excluded upstream ADDS are never
     created and excluded locally-DELETED files are never resurrected, while every other
     upstream change still lands: exit 0, local modification sites intact.
     (Source: spike CASE C)

F-16: [verified] When exclusion (or an up-to-date sha) leaves the diff empty, `git apply` exits
     128 with "No valid patches in input". The script MUST detect the empty diff and skip before
     invoking apply, rather than surfacing 128 as a failure. (Source: spike CASE B)

F-17: [verified] Pathspec exclusion covers the "I never want this path" class completely and
     declaratively, but NOT the "upstream restructured a section I rewrote and I want to adopt
     part of it" class (F-11), which still needs human/model judgment on a legible one-hunk
     conflict. The two classes need different mechanisms. (Source: spike CASE A/C vs TEST 2)

F-18: [verified] Both diffs the merge needs compute with exit 0 and CANNOT fail on missing
     files, because they are pure comparisons with no working-tree mutation:
       diff 1 (local intent):    `git diff <sha>:<upstream-path> HEAD:<local-path>`
       diff 2 (upstream change): `git diff <sha>..refs/vendor/<slug> -- <upstream-path>`
     Tree-to-tree comparison across the differing paths works directly. A locally deleted file
     appears explicitly as `delete mode 100644 <file>` in diff 1. There is no atomicity trap
     (contrast F-14) because nothing is applied. (Source: spike, deleted-file state)

F-19: [verified] The two diffs JOINTLY encode local intent-as-action, which makes the pathspec
     exclude list redundant for the F-14 class: diff 1 says "I deleted this file", diff 2 says
     "upstream added 2 lines to it", and the correct resolution (stay deleted) follows from the
     evidence with no configuration. Auto-derived from git, so it can never drift out of date
     the way a hand-maintained exclude list would. (Source: spike, same run)

F-20: [verified] Under a diff-driven design the script performs no merging at all: it fetches,
     computes two diffs, and records a sha. All merge judgment moves to the skill. This makes
     "merger" a misnomer for the script. (Source: consequence of F-18/F-19)

F-21: [verified] The upstream repo is 201.02 KiB packed / 209 objects / 3 commits across 10
     plugins (markdown only), versus this repo's 409.36 KiB. A permanent `refs/vendor/<slug>`
     ref therefore pins roughly half this repo's current size — negligible, and slow-growing.
     (Source: `du -sh`, `git count-objects -vH`, `rev-list --count` on both repos)

F-22: [verified] Refs are GC roots, so a locally held `refs/vendor/<slug>` keeps the recorded
     sha's objects reachable in THIS repo permanently. Consequence: an upstream force-push or
     history rewrite cannot strand the recorded sha. (Source: git semantics)

F-23: [verified] A normal `git clone` fetches only `refs/heads/*` and `refs/tags/*`, so
     `refs/vendor/*` is absent in a fresh clone and diff 1 would have no base. Because the
     recorded sha is an ancestor of the tracked upstream branch, fetching that branch restores
     it — so if every command fetches first, a fresh clone self-heals with no bootstrap step.
     (Source: git refspec semantics)

F-24: [verified] Skill-local scripts are already an established pattern in this repo:
     `skills/subagent-driven-development/scripts/` holds `review-package`, `sdd-workspace`, and
     `task-brief` — extensionless executables, `#!/usr/bin/env bash`, `set -euo pipefail`, a
     usage string, one script per job with positional args, invoked from SKILL.md as
     `scripts/<name> ARGS` relative to the skill directory. (Source: ls + head of those files,
     grep of the SKILL.md call sites)
     Scope correction to F-7: `scripts/*.mjs` is this repo's convention for BUILD tooling at
     the repo root; skill-local tooling is extensionless bash.

F-25: [verified] `review-package` writes its output to a file and prints only the path, so a
     large diff never passes through the agent's context as command output. This is the right
     pattern for the two diffs here, which can run to hundreds of lines.
     (Source: its header comment and SKILL.md call sites)

F-26: [verified] Placing the scripts inside the skill directory does not prevent standalone or
     CI use: they remain ordinary executables addressable by path. The "keep it usable from CI"
     motivation for a repo-root CLI is therefore not a real trade-off. (Source: F-24 call
     pattern)

F-27: [verified] Nothing in the design is skill-specific. The manifest is `{repo, path, ref,
     sha}`, the local destination is an arbitrary directory, and both diffs are generic
     tree-to-tree comparisons. The mechanism vendors ANY subdirectory of ANY upstream git repo
     into ANY local directory; "skill" is only the first use case. The name should therefore not
     say "skills". (Source: review of D-1/D-3/D-5 against the verified diff commands in F-18)

F-28: [verified] The release workflow publishes the whole tree: it checks out main's sha onto
     the `release` branch and runs `git add -A` plus `git add -f dist`. Everything under
     `skills/` therefore ships to plugin consumers, and `plugin.json` carries only
     `{name, version, description}` — no skill allowlist to opt out with.
     (Source: .github/workflows/release.yml lines 34-78; .claude-plugin/plugin.json)

F-29: [verified] `.claude/skills/` already exists in this repo with 10 directories
     (`probe-marker`, `spike-*`), none of them tracked by git (`git ls-files` returns 0) and
     none gitignored — untracked local scratch from the SDLC spike work. A project-local skill
     location is therefore already in use here, just never committed.
     (Source: ls, git ls-files, git check-ignore)

F-30: [verified] SKILL.md frontmatter supports `disable-model-invocation: true`, which makes a
     skill user-invocable only — Claude cannot invoke it. The companion field
     `user-invocable: false` inverts it (model-only, hidden from the `/` menu).
     (Source: https://code.claude.com/docs/en/skills.md, "Control who invokes a skill")

F-31: [verified] `.claude/skills/` in a plugin repo is NOT published to plugin consumers. On
     install, users receive only the plugin root's `skills/` directory (namespaced
     `plugin-name:skill-name`); `.claude/` is project-scoped to people working in that repo and
     is never part of the published plugin.
     (Source: https://code.claude.com/docs/en/plugins.md, "Plugin structure overview")

F-32: [verified] There is NO supported mechanism to exclude a subdirectory of a plugin's
     `skills/` from publication — no manifest field, ignore file, or naming convention.
     `disable-model-invocation` hides a skill from the model but does not stop it shipping or
     appearing in the consumer's `/` menu. Combined with F-28, placing this skill in `skills/`
     would necessarily publish it. (Source: same docs; agent reported "not documented")

F-33: [verified] Skills in all three locations (plugin `skills/`, project `.claude/skills/`,
     user `~/.claude/skills/`) are advertised to the model BY DEFAULT. Project-local placement
     alone does not prevent the agent from auto-invoking it; that needs
     `disable-model-invocation`. The two concerns (not published / not auto-invoked) are
     orthogonal and need separate mechanisms. (Source: same docs, "Skill Visibility &
     Advertising")

F-34: [verified] `git log --oneline -- <vendored-dir>` returns the rationale for local
     modifications where commit messages carry it (observed: "drop claude-md-convention.md:
     superseded by harness config"), and `git log --diff-filter=D -- '<dir>/*'` ties a deletion
     to the commit that made it. Available at zero cost and immune to drift, but dependent on
     commit-message quality, so it is an optional accuracy hint rather than a source of truth
     (D-9). (Source: spike, real local history)

F-35: [verified] `git archive <commit>:<subpath> | tar -x -C <dir>` materializes the upstream
     subtree flattened into the destination directory — exactly what `vendor-add` needs, with no
     checkout, no branch switching, and no working-tree disturbance. Verified: 4 files extracted
     to the right depth. (Source: spike)

F-36: [verified] `git merge-base --is-ancestor <sha> refs/vendor/<slug>` validates that a
     user-supplied `--sha` is reachable from the tracked branch, which is what keeps it alive
     across future fetches (F-23). A non-ancestor commit is correctly rejected. (Source: spike)

F-37: [verified] `vendor-check` can report everything it needs from three cheap commands:
     `git rev-list --count <sha>..refs/vendor/<slug> -- <path>` (commits behind),
     `git rev-parse --short refs/vendor/<slug>` (upstream tip), and `git diff --quiet
     <sha>:<path> HEAD:<dir>` (whether local modifications exist). (Source: spike)

F-38: [verified] `package.json` sets `"type": "module"` and node v22 is present; jq 1.7.1 is
     installed but only as a machine-local coincidence, not a project dependency. Extensionless
     executables cannot reliably use ESM imports, whereas `.mjs` is unambiguously ESM.
     (Source: package.json, `command -v jq`, `node --version`)

F-39: [verified] Naive slug derivation (`/` -> `-`) produces INVALID git ref names in common
     cases. Of 7 tested paths, 4 were rejected by `git check-ref-format`:
     `.claude/skills/vendor-sync` -> `.claude-skills-vendor-sync` (leading dot),
     `vendor/some.lock` -> `vendor-some.lock` (`.lock` suffix), a path containing a space, and a
     path containing `~`. The leading-dot case is this project's OWN skill location, so the naive
     rule would fail on the first real use. (Source: spike, `git check-ref-format` on each)

F-40: [verified] A sanitizing slugifier fixes all of them: replace `/` with `-`, replace every
     character outside `[A-Za-z0-9_-]` with `-`, collapse repeated `-`, strip leading and trailing
     `-` and `.`. All 7 paths then pass `git check-ref-format`, including `@{`, `~` and `.lock`
     cases. One residual: a path of only punctuation (e.g. `...`) slugifies to the EMPTY string,
     which must fail loudly rather than produce `refs/vendor/`. (Source: spike, 8 cases)

F-41: [verified] Fetch cost is negligible, so `vendor-list` fetching every upstream on every run
     is acceptable. Against the real remote (`https://github.com/qaware-internal/agentic-marketplace.git`)
     `git ls-remote --heads` took 0.88s, and three consecutive no-op single-branch fetches took
     1.05s / 0.89s / 0.74s. At the expected 1-3 vendored directories that is roughly 1-3s per CI
     run, dominated by network round-trip rather than repo size. No caching, `--no-fetch` mode, or
     staleness window is needed. (Source: spike, timed runs from this machine)

F-42: [verified] Skills receive arguments by direct string substitution into SKILL.md before
     Claude sees it: `$ARGUMENTS` (the whole raw string), `$0`/`$1`/... (positional), and `$name`
     when declared in an `arguments:` frontmatter list. The same model applies to slash commands;
     no documented difference. (Source: https://code.claude.com/docs/en/skills.md, "String
     Substitutions")

F-43: [verified] Documented progressive-disclosure guidance: keep SKILL.md under 500 lines and
     move detail into sibling files, referenced by ordinary markdown links. There is NO
     declarative lazy-load mechanism — no frontmatter field, no conditional include. Deferral is
     therefore achieved only by the linked file not being read until something reads it, which
     means SKILL.md must explicitly instruct the agent to read a reference at the point the flow
     needs it, or the agent will improvise from memory instead.
     (Source: same docs; the absence of a mechanism was reported as "not documented")

F-44: [verified] Documented skill best practices relevant here: SKILL.md under 500 lines;
     descriptions written with the keywords a user would naturally use; `!`command`` injection for
     live data rather than static examples; `allowed-tools` to pre-approve tools without prompts;
     `disallowed-tools` to remove specific tools for the skill's turn; `disable-model-invocation:
     true` for manual-only workflows, with deployments and commits given as the example class;
     `context: fork` to run the skill in an isolated subagent. (Source: same docs)

F-45: [verified] `${CLAUDE_SKILL_DIR}` is the supported way for a skill to reference a file inside
     its own directory, alongside `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_SESSION_ID}`. Whether it
     behaves identically for project (`.claude/skills/`) and plugin skills is NOT documented, and
     whether it resolves at parse time or runtime is likewise undocumented.
     (Source: same docs, "String Substitutions"; gaps reported as not documented)

F-46: [verified] `skills/subagent-driven-development/` establishes this repo's intra-skill
     referencing convention: supporting files sit FLAT at the skill root (`implementer-prompt.md`,
     `task-reviewer-prompt.md`, not in a `references/` subdirectory); they are referenced as
     `./name.md` in prose and as `[name.md](name.md)` markdown links; scripts are referenced as
     `` `scripts/<name> ARGS` `` with the qualifier "from this skill's directory"; SKILL.md ends
     with a reference index listing each file and its one-line purpose; and there is not a single
     use of `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, or an absolute path anywhere in the
     skill. (Source: ls + grep of that skill's SKILL.md and siblings)

F-47: [verified] `argument-hint` frontmatter exists and is DISPLAY-ONLY: it shows a usage hint in
     the slash-command UI. It does not complete, suggest, validate, or restrict argument values.
     It is documented as working for `.claude/commands/*.md` and for project-level
     `.claude/skills/*/SKILL.md`, but is broken for PLUGIN skills by a known bug
     (anthropics/claude-code#46626). Separately: there is NO documented mechanism anywhere to
     declare an enumerated set of allowed argument values, and the CLI's `/` menu and
     tab-completion complete skill NAMES only, never argument values. The `arguments:` field is
     purely a substitution mechanism with no UI effect.
     (Source: https://code.claude.com/docs/en/skills.md; issues #46626 and #18364)

F-48: [verified] A fetch refspec `+refs/heads/<ref>:refs/vendor/<slug>` MOVES the local ref, so
     it does not anchor the previously recorded sha. After an upstream history rewrite the old
     commit becomes unreferenced and is prunable by `gc`. F-22's claim that the local ref makes
     the recorded sha "immune to upstream force-pushes" is therefore WRONG as stated: it holds
     only while the ref still has that commit as an ancestor. (Source: git refspec semantics;
     identified by an implementer-readiness review of the spec)

F-49: [verified] `git diff <sha>:<path> HEAD:<local-dir>` requires the local directory to exist in
     `HEAD`. It fails immediately after `add` before the first commit, in a repository with no
     commits, and after a rename — and it reflects the last commit rather than the working tree,
     so it disagrees with the working tree in exactly the dirty case a cleanliness check is meant
     to guard. F-18's "cannot fail" claim covers deleted and added FILES only, not an absent path
     in `HEAD`. (Source: git semantics; same review)

F-50: [verified] `git cat-file -e <commit>:<path>` succeeds for a blob as well as a tree, so it
     does not by itself confirm that an upstream path is a directory; `git archive` then fails
     with an unmapped error. (Source: git semantics; same review)

F-51: [verified] Shell variable state does not persist between separate Bash tool invocations, so
     a `$T` captured by one call is empty in the next. A skill must either use one compound
     command or substitute the literal path it captured. (Source: harness behaviour; same review)

F-52: [verified] `refs/vendor/*` does NOT survive a clone, but `refs/tags/*` DOES. Cloning a
     repository that held both `refs/vendor/<slug>-base` and a tag at the same commit produced a
     clone with the tag present and the `refs/vendor/*` refs absent — and because the tag came
     across, the base COMMIT OBJECT was present in the clone too. Tags are therefore the only
     ref-based mechanism by which an anchor travels. (Source: spike, real clone of the spike repo)

F-53: [verified] D-75's anchoring guarantee is PER-CLONE, not per-project. The `-base` ref keeps
     the merge base reachable only in the clone that created it. In a fresh clone the tracking ref
     self-heals on fetch and `-base` can be recreated from the manifest `sha` whenever that commit
     is still reachable from the upstream branch (the normal case) — but if upstream rewrote
     history past the pinned commit, the original clone can still sync while a fresh clone cannot,
     and the two diverge in capability until whoever holds the anchor pins forward.
     (Source: F-52 plus the fetch semantics of F-23)

F-54: [verified] A two-point tree diff does NOT require ancestry. With C not an ancestor of D,
     `git diff C..D -- <path>` exited 0 with a sensible diff, and `git cat-file -t C:<path>`
     returned `tree`, so diff 1 remains computable. What breaks is the history walk:
     `rev-list --count C..D` returned 1 AND `rev-list --count D..C` also returned 1 — "behind by
     one" in both directions, which is meaningless. The three-way merge therefore needs the base
     TREE to be available, never that the base be an ancestor of the tip.
     (Source: spike, using two non-ancestral branches of the fixture upstream)

## Decisions & Rationale

D-91: [accepted] **When upstream's content equals the base but `pinned_sha != upstream_tip`, report
     up to date and OFFER to advance the pin.** Safe and free: the base tree is unchanged, so
     diff 1 does not move. Arises from a commit-and-revert upstream, or a rewrite that preserved
     the tree. The alternative — leaving the sha stale indefinitely — accumulates a pointless gap.

D-90: [accepted] **"Behind" means upstream's vendored CONTENT differs from the base, not that
     commits exist. `upstream_changed` becomes the decision input; `commits_behind` is demoted to
     informational and is `null` when ancestry is broken.**
     - `upstream_changed` = diff 2 non-empty (`git diff --quiet <sha>..refs/vendor/<slug> --
       <path>` returns non-zero). A two-tree comparison, so always computable (F-54).
     - It drives the sync-flow branch and `vendor-list`'s exit 10.
     - `commits_behind` is a history walk and becomes meaningless after a rewrite (F-54), so
       reporting it as a plain number was a bug: it could print a fabricated figure, or even 0,
       while upstream content had in fact changed.
     - Better even with ancestry intact: a count answers "how much upstream activity touched this
       path", which is not the question. If upstream commits a change and reverts it, the count is
       2 while the content is identical — the count definition would send the user through the
       whole flow to find nothing to do.

D-89: [accepted] **No machinery to guard against an upstream history rewrite. The base ref is
     recreated from the manifest `sha` on any fetch when that commit is reachable, and that is the
     whole mechanism.** Closes the question opened by F-52/F-53; supersedes the pristine-copy and
     pushed-tag options.
     - Rejected a committed pristine base copy (`.vendor-base/<slug>/`): it would remove the gap
       entirely and make diff 1 offline, but at the cost of permanently duplicating vendored
       content in the repository, a second directory that can be edited by mistake, and a rewrite
       of it on every pin — to defend a rare event that degrades ONE clone, temporarily.
     - Rejected tagging and pushing the base: tags do travel (F-52), but the tooling would write
       to the project's own shared remote as a side effect of a local operation, that remote would
       accumulate upstream objects, and moving the tag on each pin means force-pushing tags.
     - Scope of the accepted residual: after upstream rewrites published history past the pinned
       commit, a clone that never fetched that commit cannot obtain the base tree and falls into
       the no-base synthesis path. The clone that pinned it is unaffected. It self-corrects as
       soon as anyone pins forward.
     - Note the failure is narrower than "the setup breaks": both diffs survive the loss of
       ancestry (F-54). Only OBJECT AVAILABILITY in a clone that never had it is at stake.

D-88: [accepted] **`vendor-add`'s `mode=has-content` report includes `working_tree_clean` for the
     target directory.** Extends D-57's principle to the not-yet-vendored case.
     - The problem: D-41 requires the cleanliness precondition before any flow that may modify a
       directory, and the guided-merge path overwrites files. But a fresh adoption has no
       manifest, so `vendor-check` cannot run, and D-36 forbids the skill from running git itself.
       The spec had resolved this by saying the check "does not apply" to a fresh adoption — which
       is wrong: that is precisely the case where files under version control are about to be
       overwritten.
     - `vendor-add` already has git access and is already inspecting that directory, so it reports
       the fact and the skill halts if it is false. No new script and no git in the skill.

D-87: [accepted] **The skill captures the literal temp-directory path and substitutes it into
     subsequent commands.** It never relies on a shell variable persisting between Bash calls
     (F-51). Either one compound command creates the directory and uses it, or the skill reads the
     path `mktemp -d` printed and writes it out literally in later invocations.

D-86: [accepted] **The skill's files are tracked in git and committed.** F-29 records that the
     existing `.claude/skills/` directories in this repo are untracked scratch; this skill is not
     scratch. It must be committed so it exists for anyone working in the repository.

D-85: [accepted] **Canonical manifest serialization: two-space indent, keys in the fixed order
     `slug`, `repo`, `path`, `ref`, `sha`, trailing newline.** `vendor-pin` rewrites the whole file
     in canonical form. Without this, a read-modify-write could reformat the file and produce
     noisy diffs that look like content changes.

D-84: [accepted] **`vendor-pin` fetches before its ancestry check.** Its check resolves against
     `refs/vendor/<slug>`, which is absent in a fresh clone (F-23). Without a fetch it would fail
     with no documented recovery, unlike `check` and `inspect`. `pin` joins the fetch-first set;
     `remove` remains the sole script that performs no network operation.

D-83: [accepted] **`<local-dir>` is normalized before use: resolved against the repository root,
     trailing separators stripped, and required to lie inside the repository (exit 1 otherwise).**
     The slug is derived from the normalized form, so `skills/x`, `./skills/x`, `skills/x/` and an
     absolute path to the same directory all yield one slug and one identity. Without this,
     collision behaviour and the stored slug depend on how the argument was typed.

D-82: [accepted] **Testing model: the fixture upstream is a local git repository, because git
     accepts a filesystem path as a remote. Tests live in `tests/skills/vendor-sync/` and run
     under the project's existing vitest suite, invoking the scripts as subprocesses.**
     - Each test builds, in a temp directory: a fixture UPSTREAM repo (commits creating the
       vendored subpath, plus whatever divergence the case needs) and a fixture CONSUMER repo (a
       git repo with at least one commit, into which vendoring happens).
       Required fixture shapes, named by the criteria that use them: up-to-date; behind; behind
       with local modifications; pristine and behind; a file deleted locally and edited upstream;
       an upstream commit outside the vendored subpath; a non-ancestor commit; a bogus pinned sha;
       three independent upstream changes.
     - The DoD one-liners in the acceptance criteria are ASSERTIONS, expressed inside those tests
       — not a separate shell harness. This satisfies the project rule that `npm test` runs
       everything.

D-81: [accepted] **All non-zero exits write their message AND their remedy data to stderr. stdout
     carries only successful, informational output.** Settles a contradiction between D-72's
     "errors go to stderr" and four acceptance criteria that asserted remedy data on stdout. One
     rule, no per-code exceptions.

D-80: [accepted] **The skill writes its grouping and inventory to machine-readable JSON files in
     the temp directory, with stated schemas.** This is what makes the totality guarantees of
     D-31 and D-47 checkable rather than merely asserted.
     - `groups.json`: `{ "side": "local"|"upstream", "groups": [ { "id", "name", "what",
       "why", "hunks": [ { "file", "start", "end" } ] } ], "unassigned": [ ... ] }`
     - `inventory.json`: `{ "sides": { "local": [items], "upstream": [items] }, "unclaimed":
       [spans] }` where an item is `{ "id", "name", "span": { "file", "start", "end" } }`.
     - A totality check is then a count comparison against the diff's hunk headers, or a
       line-coverage check over both documents — runnable, not a matter of reading a transcript.

D-79: [accepted] **`vendor-export`'s flags-only form requires `--sha` (never `--ref`) and requires
     that commit object to be present locally already.** If absent, exit 2 naming the remedy: run
     `add` or `check` first, which fetches. This removes the undefined "fetch into what refname?"
     problem — the flags-only form is used only immediately after `vendor-add` has fetched, so the
     object is present and no ref is needed to read it.

D-78: [accepted] **Tracking-ref lifecycle, and orphan cleanup.**
     - `vendor-add` creates `refs/vendor/<slug>` only AFTER slug validation and after confirming
       the upstream subpath exists at the resolved commit. If it exits non-zero after creating a
       ref, it deletes the ref it created.
     - On `mode=has-content` the ref is deliberately RETAINED, because the guided-merge path needs
       it. If the user then chooses the separate-directory path instead, the skill cleans up by
       running `vendor-remove` on the abandoned directory.
     - `vendor-remove` therefore becomes idempotent cleanup: manifest absent AND the derived
       slug's ref absent → exit 3; manifest absent BUT that ref present → delete the ref and exit
       0, reporting that an orphaned connection was cleaned.
     - Without this, a run that exited 5, or a Path-1 choice, left a ref behind that made every
       later `add` for that directory exit 6 with no recourse at all.

D-77: [accepted] **`--adopt` semantics.** It requires `--sha`, requires `refs/vendor/<slug>` to
     already exist, and does NOT perform the collision check. It writes only the manifest and the
     base ref.
     - `--sha` is required for the same reason `vendor-pin` requires it: the commit that was
       actually reconciled must be recorded, not a tip re-resolved after a long interactive
       synthesis.
     - Skipping the collision check is necessary, not a shortcut: the ref was created by the
       earlier `mode=has-content` run, so the check would always fire and `--adopt` could never
       succeed. This was a genuine deadlock in the flow.

D-76: [accepted] **Diff 1 is computed by exporting the base to a temporary directory and running
     `git diff --no-index <base-tmp> <local-dir>`, not by `git diff <sha>:<path> HEAD:<local-dir>`.**
     - Removes the dependency on the vendored directory existing in `HEAD` (F-49), which fails
       before the first commit, in an empty repository, and after a rename.
     - Compares the WORKING TREE, which is what "what did I change locally" actually means.
     - `vendor-inspect local` performs the export into a temp directory it owns and removes
       afterwards; `has_local_modifications` is that diff being non-empty.
     - Cost: one extra export per invocation, on a tree of a few hundred lines.

D-75: [accepted] **A second ref, `refs/vendor/<slug>-base`, anchors the merge base. `vendor-add`
     creates it and `vendor-pin` moves it, always in step with the manifest's `sha`.** Corrects
     F-22 and supersedes D-22's remedy.
     - The tracking ref moves on every fetch and therefore anchors nothing (F-48). The base ref is
       the anchor F-22 wrongly attributed to the tracking ref.
     - Exit 4 is redefined: it fires only when the base commit object cannot be resolved
       (`git cat-file -e <sha>^{commit}` fails). With the base ref present that requires the ref
       to have been deleted manually, so in practice the no-base flow is reached by ADOPTION
       rather than by pin loss.
     - An upstream history rewrite no longer destroys the base: both objects remain present, so
       both diffs still compute. `vendor-check` reports `base_is_ancestor_of_tip: false` for that
       state, and the skill surfaces it — the base is usable, the branch has simply diverged.
     - `vendor-remove` deletes both refs.



D-74: [accepted] **A slug that cannot be made into a valid ref name is a usage error (exit 1),
     not a manifest or precondition error.** The message must name the offending directory and
     state the recourse: rename the directory. This covers both `git check-ref-format` rejection
     and the empty-slug case from a punctuation-only path (F-40).

D-73: [accepted] **`vendor-export` destination preconditions, and `--replace`.**
     - Default: `--out <dest>` must not exist, or must be empty. Otherwise exit 1. This makes
       accidental overwriting impossible by default.
     - `--replace`: permitted to write into a non-empty destination. It first deletes the
       destination's contents EXCEPT `.vendor.json`, then extracts. Preserving the manifest is
       essential — the manifest is not upstream content and must survive a re-materialization.
     - `--replace` is required by the pristine fast path, which needs the local directory to
       become an exact replica of the upstream tree at the new tip. A plain overlay would leave
       behind files that upstream has since deleted.

D-72: [accepted] **Machine-read script output is JSON; human-read output is plain text.**
     - `vendor-check` prints a single JSON object; `vendor-list` prints a JSON array. These are
       the two outputs the SKILL parses, and prose parsing would be a silent-failure source.
     - Every other script prints plain human-readable lines, because their output is read by a
       person or simply confirms an action.
     - Errors and warnings go to stderr in all cases; git's stderr is passed through verbatim on
       exit 2. Bulk data goes ONLY to the path given by `--out` and that file is created only on
       success, so its existence is itself a success signal.

D-71: [accepted] **Keep the optional action arguments (D-53) and add
     `argument-hint: "add|sync|remove|list [args]"` to the frontmatter.**
     - The originally hoped-for benefit — CLI autocomplete of the action names — does NOT exist
       (F-47): no value completion, no enumerated-choice declaration, nowhere in the harness.
     - What DOES exist is a display-only hint, and it works for project-level `.claude/skills/`
       skills; the known bug affects plugin skills only. D-8 already placed this skill in
       `.claude/skills/`, so it lands on the working side of that bug incidentally.
     - Kept because the hint puts the valid actions in front of the user at the moment of
       invocation for one frontmatter line, which is most of the practical value sought. The
       arguments themselves remain a pure convenience — D-68's completeness gate is what
       guarantees correctness, so nothing depends on them being supplied or well-formed.
     - Valid values are additionally documented in SKILL.md prose, since the hint cannot enforce
       them (F-47).

D-70: [accepted] **NO default adoption. Every upstream change is discussed with the user
     individually.** Supersedes D-48's "default for an upstream change: adopted" clause and
     replaces D-62's mitigation entirely.
     - The asymmetry is deliberate and coherent: a LOCAL intent is a decision the user already
       made, so it retains standing and is preserved by default (D-48). An UPSTREAM change is a
       proposal the user has never seen, so it gets a decision every time.
     - This eliminates the D-62 failure mode at its root rather than mitigating it: if nothing is
       adopted without discussion, a grouping error can no longer convert silently into a content
       change. D-62's proposed remedy (state which intents were checked for each default adoption)
       becomes unnecessary.
     - Accepted cost: more decisions per sync. Tolerable because upstream churn on vendored
       content is very low (F-2), and because the earlier fatigue worry was about re-litigating
       the user's OWN past decisions — which D-48 still prevents.
     - Consequence: D-31's totality guarantee now does load-bearing work in a stronger way —
       every hunk must appear in exactly one named change, and every named change gets discussed,
       so nothing can reach the file without a decision.

D-69: [accepted] **Verbatim assembly is not achievable for idea-level synthesis. The guideline is
     "as close to verbatim as possible", and a FINAL REVIEW of the complete synthesised result is
     mandatory.** Corrects D-63's structural claim and D-47's "the retained verbatim spans are
     what get assembled".
     - Rationale (user): ideas from two sources cannot be merged by concatenating verbatim blocks.
       Combining them inherently requires writing connective and reconciling text.
     - What survives from D-47: the per-side inventory of named ideas with their text spans. The
       spans remain the EVIDENCE for what each idea says and the anchor for staying close to the
       source wording. They are not a construction kit for the output.
     - What replaces the structural guarantee: the synthesised result is reviewed in full by the
       user before acceptance. Since exact-verbatim cannot be enforced mechanically, review is the
       control — consistent with D-33's user-gating being the correctness mechanism rather than a
       formality.
     - D-46 still applies with full force to the WITH-BASE merge, where changes genuinely can be
       taken verbatim.

D-68: [accepted] **A single completeness gate replaces the anti-inference rule: the skill
     proceeds only once it is CERTAIN of the intended action and holds every required parameter;
     otherwise it asks.** Supersedes D-65.
     - This gate has to exist regardless of whether arguments are supplied, so expressing the
       argument risk as a separate "never infer the action" rule was redundant. One gate covers
       the omitted-action case, the wrong-arity case, and the ambiguous-argument case alike.
     - The gate is stated once in SKILL.md, where triage lives, rather than repeated per action.

D-67: [withdrawn] **D-66 (orphaned upstream has no exit) is withdrawn as out of scope.**
     - Rationale (user): if the upstream is gone the tooling fails, and the developer resolves why
       it fails. No `remove`-as-resolution suggestion is needed. A failing CI run is acceptable —
       the vendor connection is then something to fix, which is exactly the signal wanted.
     - Consequence: `exit-codes.md` describes exit 2 factually and does not propose remedies
       beyond reporting the cause. `vendor-list` in CI is a gate, not merely a report — reverting
       that part of D-66 too.

D-66: [SUPERSEDED by D-67 — withdrawn] **Pre-mortem mitigation — an orphaned upstream has no exit.**
     Failure: the upstream repo is deleted, renamed, or access is revoked. Every sync now fails
     with exit 2 forever. There is no guided way to stop tracking, so the connection rots, and
     `vendor-list` stays red in CI until somebody disables the job — taking the drift detection
     for every OTHER vendored directory down with it.
     Root cause: exit 2 was designed as a transient error (retry, check your access) with no
     branch for "permanently gone".
     Mitigation: exit-2 handling MUST present `remove` as a legitimate resolution when upstream is
     permanently gone — it keeps every vendored file (D-10), so the outcome is simply owning the
     copy outright. `vendor-list`'s CI usage MUST be documented as a REPORT rather than a gate,
     so one broken connection cannot silence the rest.
     Landed as: ASK FIRST boundary on exit 2 + `exit-codes.md` naming `remove` as a resolution +
     AC on the documented CI usage.

D-65: [superseded-by D-68] **Pre-mortem mitigation — an action inferred from argument shape.**
     Failure: the user types `/vendor-sync skills/brainstorming` with no action token. The skill
     infers "sync" because a single path argument looks like a sync — but the user meant `add`,
     or `remove`. The inferred action runs against a real directory.
     Root cause: `$ARGUMENTS` is free-form (F-42, D-53), and a path is a plausible first token.
     Mitigation: the first token MUST match a known action exactly (`add`/`sync`/`remove`/`list`).
     Anything else — including something that looks like a path — means the action was omitted,
     and the skill ASKS. It never infers an action from the shape or count of the arguments.
     Landed as: NEVER boundary (never infer the action) + AC.

D-64: [accepted] **Pre-mortem mitigation — operating on the wrong directory.**
     Failure: a mistyped or misremembered `<local-dir>` resolves to a DIFFERENT vendored
     directory. It has a valid `.vendor.json`, so every script succeeds, and the wrong upstream is
     merged into the wrong place — then pinned.
     Root cause: scripts exit 3 when no manifest exists, which catches non-vendored paths but not
     a valid path the user did not mean.
     Mitigation: before any write or any pin, the skill MUST echo the resolved identity — slug,
     repo, upstream path, pinned sha, target directory — and that echo MUST come from the
     manifest as reported by the script, never restated from the user's argument. Confirming the
     identity is what distinguishes "this directory" from "the directory I meant".
     Landed as: ALWAYS boundary (echo resolved identity from the manifest before writing) + AC.

D-63: [superseded-by D-69] **Pre-mortem mitigation — synthesis drifts despite the verbatim guideline.**
     Failure: the no-base path authors "a completely new version" (D-33) and, being generative,
     rewrites prose while assembling it. The result matches neither source. Diff 1 is permanently
     inflated with wording nobody chose, and every future sync buries the real local
     modifications in that noise.
     Root cause: D-46 is a guideline addressed to a process whose natural tendency is to rewrite.
     Mitigation: assembly MUST be built from the verbatim text spans recorded in the inventory
     (D-47). For every retained idea, the emitted text must match its recorded span. Any departure
     must be explicitly listed, naming the two conflicting ideas that forced a combination and
     why — so rewriting becomes an itemised exception rather than an invisible default.
     Landed as: NEVER boundary (never re-word a retained idea) + AC comparing emitted text against
     recorded spans.

D-62: [superseded-by D-70] **Pre-mortem mitigation — default-adopt blindness.** The failure it
     describes is removed at the root by D-70 (no default adoption), so the mitigation below is
     no longer needed.
     Failure: D-48 adopts upstream changes by default and requires an explicit decision only at
     conflicts. But conflict detection depends on the skill's own grouping (D-31) being
     SEMANTICALLY correct. A diffuse local intent — spread across several hunks, or expressed as
     an absence rather than an edit — may not be recognised as an intent at all. An upstream
     change contradicting it then registers as non-conflicting, is adopted silently, and the local
     intent is reverted without anyone deciding to.
     Root cause: D-31's totality guarantee ensures no hunk is LOST. It does not ensure the
     grouping is RIGHT, and D-48's defaults convert a grouping error directly into a silent
     content change.
     Mitigation: for every upstream change adopted by default, the skill MUST state which local
     intents it checked it against. This makes the conflict CHECK reviewable rather than only its
     conclusion — the user can see "checked against intents 1, 3" and notice that intent 2 was
     never considered.
     Landed as: ALWAYS boundary (state the intents checked for each default adoption) + AC.

D-61: [accepted] **`disallowed-tools` is NOT used. D-36's "the skill never runs git" is enforced
     by instruction, like every other rule in the skill.** Closes Q-6 by removing the dependency
     rather than by verifying it.
     - Pattern support in `disallowed-tools` (e.g. `Bash(git:*)`) is undocumented. Pattern syntax
       demonstrably works in `allowed-tools` (this repo's brainstorming skill uses
       `Bash(nessy:*)`; upstream's uses `Bash(date:*)`), but the two fields sharing a matcher is
       an inference, not a fact.
     - Rejected taking the dependency: the benefit is modest and the cost is an undocumented
       behaviour the design would rest on.
     - The benefit is modest specifically because D-57 removed the skill's last REASON to touch
       git (the pristineness check moved into `vendor-check`). With no remaining temptation, the
       gap between instruction and constraint is small.
     - If pattern support is ever confirmed, adding it is a free hardening that changes nothing
       else.

D-60: [accepted] **Deduction accuracy is accepted as good enough. We expect it to work.** Closes
     Q-2 by decision, as the user directed.
     - This is an explicit acceptance of residual risk, not a resolution of the underlying
       uncertainty: a local modification whose purpose is genuinely invisible in diff 1 can still
       receive a plausible-but-wrong deduced reason.
     - Accepted because the blast radius is bounded by two other decisions: D-21 pairs every
       deduced intent with the hunk it derives from, so a wrong deduction is visible rather than
       asserted; and D-48 preserves local intents by DEFAULT, so a wrong deduction must both
       survive review AND conflict with an upstream change before it can change any outcome.
     - Accepted also because it cannot be closed by further design. It was the deliberate
       trade-off when written intent records were rejected (D-9) in favour of zero maintenance
       cost, and it only closes empirically — by using the tool.
     - If it proves unreliable in practice, the recorded fallback is the rejected option:
       reinstating a written intent record (see Rejected Approaches).

D-59: [accepted] **Progressive disclosure is organised BY ACTION. SKILL.md contains only
     frontmatter, `$ARGUMENTS` handling, the triage decision, and the reference index. Each action
     lives in its own file, and the two update paths are shared files those action files reference
     where required.** Supersedes D-54's structure (all flows in SKILL.md plus two references).

     ```
     .claude/skills/vendor-sync/
       SKILL.md                  # frontmatter, argument parsing, triage, reference index
       add.md                    # Flow: add (materialize | two paths on non-empty)
       sync.md                   # Flow: sync (runtime branches, D-44)
       remove.md                 # Flow: remove
       merge-with-base.md        # Phase A/B reconciliation (D-31/D-32/D-48)
       merge-without-base.md     # idea inventory + synthesis (D-33/D-47)
       exit-codes.md             # exit-code table and agent reactions (D-18/D-26)
       scripts/                  # the seven .mjs scripts plus lib.mjs
     ```
     - `add.md` references `merge-without-base.md` (guided-merge path). `sync.md` references BOTH
       merge files, since which one applies is a runtime branch (D-44). All three action files
       reference `exit-codes.md`.
     - `list` stays inline in SKILL.md as the single exception: it modifies nothing and needs no
       procedure beyond "run `vendor-list`, report the result".
     - The verbatim guideline (D-46) is stated in BOTH merge files rather than in SKILL.md. Under
       this structure every merge necessarily loads one of those two files, so stating it there
       puts it in context exactly when it applies. It is short enough that duplicating it is
       cheaper than a third file read, and duplication makes it impossible to reach a merge
       without it.
     - Chosen because (user's framing): the root skill should carry only the decision of which
       action to take. This also keeps SKILL.md far below the 500-line guidance (F-43) and means a
       `remove` never loads a word of merge procedure.

D-58: [accepted] **All intra-skill references use SKILL-RELATIVE paths, with no variables.**
     Supersedes D-56, which chose repository-relative paths.
     - Verified convention in `skills/subagent-driven-development/` (F-46): prompt files as
       `./implementer-prompt.md` and as markdown links `[name.md](name.md)`; scripts as
       `` `scripts/<name> ARGS` `` accompanied by the qualifier "from this skill's directory"; no
       `${CLAUDE_SKILL_DIR}`, no `${CLAUDE_PROJECT_DIR}`, no absolute paths; supporting files flat
       at the skill root rather than in a subdirectory; and a reference index at the end of
       SKILL.md listing each file with a one-line purpose.
     - Adopting the existing convention beats both alternatives: repo-relative paths (D-56) are
       needlessly coupled to the skill's location, and `${CLAUDE_SKILL_DIR}` carries undocumented
       behaviour for project skills (F-45).

D-57: [accepted, partially superseded-by D-61] **`vendor-check` also reports whether the vendored directory's WORKING TREE is
     clean, so the skill needs no git at all.** Closes a hole in D-36.
     - D-41 requires the skill's first action to be a pristineness check, which is a git
       operation — directly contradicting D-36's rule that the skill never runs git. Moving the
       check into `vendor-check` resolves it.
     - Note this is a SECOND, distinct cleanliness question from the one `vendor-check` already
       answers. "Local modifications exist" means the vendored content differs from the pinned
       base (diff 1 non-empty). "Working tree clean" means there are no uncommitted changes. A
       directory can be clean while having local modifications — that is in fact the normal,
       healthy state.
     - Consequence: git appears nowhere in the skill's tool usage.
       SCOPE CORRECTION: the original final clause claimed this makes D-36 "mechanically
       enforceable via `disallowed-tools`". D-61 drops `disallowed-tools`; D-36 is enforced by
       instruction. The move of the cleanliness check into `vendor-check` stands and is the
       durable contribution of this entry.

D-56: [superseded-by D-58] **The skill refers to its scripts by repository-relative path
     (`.claude/skills/vendor-sync/scripts/<name>.mjs`), not via `${CLAUDE_SKILL_DIR}`.**
     - `${CLAUDE_SKILL_DIR}` is the supported general mechanism (F-45), but its behaviour for
       project skills is undocumented, and whether it resolves at parse or run time is likewise
       undocumented.
     - This skill is project-local maintenance tooling living at one fixed path in one repository
       (D-8), so a repo-relative path is stable, readable, and verifiable by inspection —
       depending on an undocumented resolution would add a failure mode for no benefit.
     - `${CLAUDE_PROJECT_DIR}` is available if an absolute path is ever needed.

D-55: [accepted, partially superseded-by D-61] **Frontmatter: `name`, `description`, `disable-model-invocation: true`,
     `allowed-tools` limited to what the skill actually needs (Bash for `node`, Read, Write, Edit,
     AskUserQuestion), and `disallowed-tools` covering git if pattern matching supports it
     (D-57). NOT `context: fork`.**
     - `disable-model-invocation: true` is confirmed as the documented mechanism for manual-only
       workflows, with deployments and commits given as the example class (F-44) — the same class
       as vendoring. Reconfirms D-8.
     - `context: fork` rejected: the entire skill is a dialogue with the user (D-32, D-48), and
       running it in an isolated subagent would sever exactly that.
     SCOPE CORRECTION: the `disallowed-tools` element is dropped by D-61. Git is simply absent
     from `allowed-tools`; D-36 is enforced by instruction. Everything else here stands.

D-54: [superseded-by D-59] **Progressive disclosure: SKILL.md carries frontmatter, argument handling,
     triage, the flows, the decision rules and the verbatim guideline, under 500 lines (F-43).
     Deferred to `references/`: the no-base synthesis procedure (D-33/D-47) and the exit-code
     reaction table (D-18/D-26).**
     - The split matches the design's own risk profile: the COMMON path (sync with an intact base)
       is the simple one and needs SKILL.md only; the RARE path (no-base idea synthesis) is by far
       the most procedurally detailed. Deferring the rare-and-detailed is exactly what progressive
       disclosure is for.
     - The verbatim guideline (D-46) stays in SKILL.md despite being short, because it applies to
       both update paths and is the rule most likely to be violated by omission rather than by
       disagreement.
     - Because there is no declarative lazy loading (F-43), SKILL.md MUST contain an explicit
       instruction to read the relevant reference file at the branch point that needs it.
       Otherwise the agent proceeds from memory and the deferred detail never arrives.

D-53: [accepted] **The skill accepts an optional action and its arguments: `sync <dir>`,
     `remove <dir>`, `add <repo> <path> <dir>`, `list`. Anything omitted is asked for, never
     guessed.**
     - Mechanism: `$ARGUMENTS` (F-42), with the skill treating the first token as the action.
       Rejected the named `arguments:` frontmatter form because arity varies by action (0 for
       `list`, 1 for `sync`/`remove`, 3 for `add`), which named single-slot arguments do not fit.
     - Narrows D-14's rationale rather than contradicting it: triage needs judgement only when the
       user has NOT said what they want. When they have, the dialogue turn is pure overhead.
     - Also makes the invocation self-documenting in shell history, which matters for tooling run
       a few times a year.

D-52: [accepted] **One `vendor-export` command; the coordinates may come from a manifest or from
     flags, and the commit may be overridden.** Clarifies D-35/D-39 rather than changing them.
     `vendor-export --out <dest> ( <local-dir> | --repo R --path P ) [--sha C | --ref B]`
     - Export is a pure git operation: `(repo, path, commit) -> files at dest`. The local
       directory was never a parameter of the operation itself; the `<local-dir>` form is sugar
       meaning "read repo/path/sha from this directory's manifest".
     - The flags-only form is needed in EXACTLY ONE scenario: the guided-merge path of `add`,
       where D-39 forbids writing the manifest until reconciliation has happened, so no manifest
       exists yet even though `vendor-add` has already fetched, created the ref, and resolved the
       sha.
     - The `--sha` / `--ref` override is needed by the pristine fast path and by pin-loss
       recovery, both of which have a manifest but need the TIP rather than the pinned sha (in
       pin-loss the pinned sha is precisely what no longer resolves).
     - Rejected alternative: give `vendor-add` an `--export-to` flag so the non-empty-directory
       case returns the report and the files in one call, removing the flags-only form. It
       overloads `add` with an export responsibility to save one parameter shape.

D-51: [accepted] **`vendor-list` fetches every upstream on every invocation. No caching, no
     `--no-fetch` mode, no staleness window.** Grounded in F-41: ~1-3s per run for the expected
     1-3 vendored directories, dominated by network round-trip. Adding a cache would trade a
     measured non-problem for a real correctness risk (reporting stale "up to date").

D-50: [accepted] **Slug derivation SANITIZES and then VALIDATES, and the slug may be overridden.**
     Corrects D-40, whose stated rule ("separators to `-`") produces invalid ref names (F-39).
     - Algorithm (F-40): replace `/` with `-`; replace every character outside `[A-Za-z0-9_-]`
       with `-`; collapse repeated `-`; strip leading and trailing `-` and `.`.
     - Then `git check-ref-format refs/vendor/<slug>` is the AUTHORITY, not the algorithm: if it
       fails — or the slug came out empty, as a punctuation-only path does — `vendor-add` exits
       rather than creating a broken ref.
     - NO `--slug` override. Rejected on the user's argument: an unsluggable path or a slug
       collision is a rare edge case, and pretty ref names are not a goal. The deeper reason is
       that an option obliges the SKILL to learn when to reach for it, growing the skill's surface
       for something that almost never happens.
     - Collision handling is unchanged from D-40: check against existing `refs/vendor/*` and exit
       6 if taken. Sanitization makes collisions slightly more likely (`a.b` and `a-b` both become
       `a-b`), which that check already covers. The recourse in both the collision and the
       unsluggable case is the same and must be stated in the failure message: rename the local
       directory. No tooling affordance is provided for it.
     - Note: this project's own `.claude/skills/vendor-sync` is one of the failing cases under the
       naive rule, so the correction is load-bearing on first use.

D-49: [accepted] **A DECLINED upstream change needs no separate record: it becomes a local
     intent automatically, and thereby inherits standing (D-48).**
     - Mechanism: declining upstream change X while still pinning the new sha (D-23) puts X inside
       the base but not in the local copy. On the next sync, diff 1 therefore reports "X is
       absent locally" as a local modification, Phase A deduces an intent for it, and D-48
       preserves it by default.
     - Consequence: declines are durable across syncs with no bookkeeping, no "declined" list in
       the manifest, and no possibility of the record drifting out of sync with reality. The pin
       plus the two diffs already remember it.
     - This validates D-23's insistence that `pin` record the sha that was actually merged: were
       the sha left behind instead, X would be re-proposed on every future sync forever.
     - Consequence for D-9/D-46: the intent deduced for such an absence is "this was declined
       upstream", which is exactly the kind of intent the diff alone cannot distinguish from a
       deliberate local deletion — but under D-48 both are preserved by default, so the
       distinction does not change the outcome.

D-48: [accepted, partially superseded-by D-70] **Presentation is TOTAL; the defaults carry the
     load; explicit decisions arise ONLY at conflicts. A local intent is a prior user decision and
     therefore has STANDING — it is not re-litigated on every sync.**
     SCOPE CORRECTION: the clauses "the defaults carry the load" and "explicit decisions arise
     ONLY at conflicts" are superseded by D-70 — every upstream change is discussed individually,
     so a decision is not confined to conflicts. What STANDS, and is the durable contribution of
     this entry: presentation is total, and a local intent has standing and is preserved by
     default rather than re-litigated each sync.
     - Every upstream change to the pinned sha is PRESENTED, whether or not a decision follows
       from it, for the purpose of transferring knowledge of what upstream did.
     - Default for a local intent: preserved. Phase A exists to IDENTIFY intents so conflicts can
       be detected, and to let the user correct a mis-DEDUCTION — not to re-approve the decision
       itself, which was made in an earlier session.
     - Default for an upstream change: adopted.
       SCOPE CORRECTION: this clause is superseded by D-70 — there is no default adoption; every
       upstream change is discussed individually. The rest of D-48 stands, including the standing
       principle for local intents and the totality of presentation.
     - Explicit decision required: where an upstream change conflicts with a preserved local
       intent. This is exactly the per-item confirmation D-21 requires, now scoped precisely.
       SCOPE CORRECTION (D-70): explicit decision is required for EVERY upstream change, not only
       conflicting ones. A conflict now changes only the weight of the discussion — a local intent
       with standing is on the other side of it — not whether a discussion happens.
     - The user may still veto any presented upstream change even absent a conflict, which is what
       keeps D-16's independence of wantedness from collision operative.
     - Evaluated: tiered-by-risk confirmation; individual confirmation for everything; everything
       by exception.
     - Rejected individual-for-everything: a twenty-change update becomes twenty prompts, which
       manufactures the very approval fatigue D-21 exists to prevent.
     - Chosen because (from the user): local intents "were decided by the user in an earlier
       version". Without the standing principle every sync re-opens the user's own past
       decisions, and a vendored copy erodes back toward upstream a little at a time.

D-47: [accepted] **The no-base synthesis begins by producing a PER-SIDE INVENTORY OF NAMED IDEAS,
     each carrying the verbatim text span that backs it. The discussion is then keep / drop /
     combine per item, and the retained verbatim spans are what get assembled.** Makes D-33
     concrete and resolves the "extract ideas and intentions" hand-wave.
     - Evaluated: per-side inventory of named ideas with verbatim spans; a side-by-side structural
       mapping of headings/sections; a prose comparison the user reacts to.
     - Rejected structural mapping: more mechanical and easier to check, but it misses ideas that
       moved between sections or that are not section-shaped — and in the real case (148 local
       lines vs 440 upstream) the structures barely correspond.
     - Rejected prose comparison: nothing anchors a claim to text, so D-46 degrades from a
       mechanism into an aspiration.
     - Chosen because: the inventory anchors every named idea to the source text that expresses
       it, so the discussion is about identified content rather than impressions.
       SCOPE CORRECTION: the original rationale claimed the retained spans would be ASSEMBLED into
       the output, enforcing D-46 by construction. D-69 corrects this — ideas from two sources
       cannot be merged by concatenating verbatim blocks. The spans are evidence and an anchor for
       staying close to source wording; the control on drift is the mandatory final review.
     - Totality guarantee, mirroring D-31: every part of BOTH versions must be accounted for —
       either claimed by an inventory item or explicitly listed as unclaimed — so no idea can
       vanish without a decision. An unclaimed span is a finding to resolve, not a default.

D-46: [accepted] **Verbatim-merge guideline: both update paths SHALL preserve the wording of the
     two source states as closely as possible. Merge verbatim wherever possible; rewrite text ONLY
     where two conflicting changes genuinely have to be combined.**
     - Applies to the with-base merge AND to the no-base synthesis (D-33), whose "author a
       completely new version" wording otherwise invites wholesale rewriting.
     - Refines D-33: what is newly authored is the ARRANGEMENT — which ideas are present and in
       what order. The TEXT of each retained idea stays as written on whichever side it came from.
     - Hazard being prevented: a model merging prose will tend to improve it, and every such
       improvement silently drifts the vendored copy away from BOTH sources. The result then
       diffs against upstream forever after in ways no one decided, inflating diff 1 on every
       future sync and making real local modifications harder to see.
     - This is stated as an explicit guideline in the skill, not left implicit.

D-45: [accepted] **The escape hatch (vendor into a separate directory) is offered on pin-loss
     too, not only on `add` into a non-empty directory.** Revises D-38, which had ruled it out.
     - Rationale accepted from the user: creating a separate vendored directory may simply be
       easier than synthesising, and leaving the user to clean up afterwards is acceptable.
     - Consequence: BOTH no-base entry points offer the same two paths, so the no-base flow is
       uniform regardless of how it was reached.

D-44: [accepted] **Sync is ONE flow with branches discovered at runtime, not separate flows
     chosen up front.** The user does not know which case applies until the scripts have reported.
     - The branches: whether the pinned base is still reachable (exit 4 or not), and whether local
       modifications exist (fast path or full reconciliation).
     - Supersedes the earlier presentation as "Flow 2 — sync, base intact" and "Flow 3 — sync,
       base lost", which implied a choice the user makes rather than a state the tooling finds.

D-43: [accepted] **`vendor-check <dir>` operates on EXACTLY ONE vendored directory, which is a
     required argument. No script contains multi-directory iteration. A separate script,
     `vendor-list`, enumerates directories containing `.vendor.json`, invokes `vendor-check` for
     each, and aggregates the results — including the exit-10 "anything behind" status for CI.**
     - Supersedes the "per connection" reporting of the earlier design (and D-27's discovery
       responsibility moves into `vendor-list` alone).
     - Chosen because: every other verb already addresses a single directory, so making `check`
       the sole exception created the "do stuff per directory" logic the user rejected. Separating
       enumeration from evaluation keeps each script single-purpose and independently testable.
     - Verb set becomes seven: add / check / inspect / pin / remove / export / list.

D-42: [accepted] **Scripts that emit bulk data take a REQUIRED output-path argument; they do not
     write data to stdout. Messages — including errors and remedy data — go to stdout/stderr.**
     Revises the mechanism of D-12 while keeping its principle.
     - `vendor-inspect <dir> <local|upstream> --out <file>`, matching `vendor-export`'s shape.
     - Hazard being fixed: with data on stdout, a shell redirect captures error text into the
       data file on failure, or leaves a truncated file that looks valid. Data and messages were
       sharing one channel and only stream discipline kept them apart.
     - D-12's principle survives intact: the SKILL still chooses the location (it passes a
       `mktemp -d` path), no location is hardcoded in any script, and bulk data still never
       passes through the agent's context. Only the delivery mechanism changes from redirect to
       argument.
     - Additional benefit: the output file is created only on success, so its existence is itself
       a success signal.

D-41: [accepted] **The skill's FIRST action in any flow that will modify a vendored directory is
     to verify the directory is pristine, and to HALT if it is not. Remedying a dirty directory
     is explicitly NOT the skill's job.** Supersedes D-37's "state the abandon command" clause;
     D-37's precondition itself stands and is strengthened.
     - The skill reports what is dirty and stops. It does not offer to stash, reset, commit, or
       otherwise fix it — the user resolves it however they prefer and re-invokes.
     - Key property (noted by the user's framing): this precondition is not only a guard before a
       merge, it is what CATCHES an abandoned merge on the next run. A half-written merge leaves
       the directory dirty, so the next sync refuses to start — meaning the D-37 poisoning can
       never reach diff 1 at all. The precondition is simultaneously the guard and the detector,
       which is why no abandon instruction is needed.

D-40: [accepted] **`slug` is a fifth manifest field, generated once at `add` time from the local
     directory path and stored, not re-derived.**
     - Evaluated: basename of the local directory; the full local path slugified; a hash of
       repo+path; a stored explicit name.
     - Rejected basename: collides whenever two vendored directories share one (e.g.
       `skills/brainstorming` and `docs/brainstorming`).
     - Rejected re-deriving from the path on every run: the ref name would go stale the moment the
       directory is moved or renamed, orphaning the old ref while the manifest travels with the
       directory.
     - Rejected a hash: unique and stable but opaque, and `refs/vendor/*` is something a human
       reads when debugging.
     - Chosen: derive at `add` time from the local path (separators to `-`), check for collision
       against existing `refs/vendor/*` and fail with exit 6 if taken, then STORE it in the
       manifest. Stable across moves, readable, and unique by construction.

D-39: [accepted] **In the guided-merge path the manifest is written LAST, and `vendor-export`
     therefore accepts explicit coordinates as well as a manifest directory.**
     - Hazard: if `vendor-add` wrote `.vendor.json` pinned at the upstream tip BEFORE the
       synthesis, abandoning would leave a manifest whose base is the tip beside a directory that
       was never reconciled. The next sync's diff 1 would then report the user's entire local
       version as deliberate local modification — the D-37 poisoning arriving through a different
       door, and worse, because the whole file is affected rather than a fragment.
     - Therefore: `vendor-add` on a non-empty directory writes NOTHING (D-34). The skill obtains
       upstream via `vendor-export`, synthesises, authors the result, and only then invokes
       `vendor-add <...> --adopt`, whose sole effect is to write the manifest.
     - Consequence: `vendor-export` must work without a manifest, so it accepts either a vendored
       directory (manifest-driven) or explicit `--repo` / `--path` / `--ref` / `--sha` coordinates.
     - General principle this instantiates: the manifest is a claim that the directory has been
       reconciled against that sha. It must never be written before that claim is true.

D-38: [accepted] **Exit 4 (pinned sha unreachable) routes into the no-base synthesis flow (D-33),
     then pins the new tip.** Completes the supersession of D-22 begun in D-30.
     - The escape hatch of D-34 (vendor into a different directory) does NOT apply here: the
       directory is already vendored and the user wants to keep it. Only the base is missing.
     - D-22's prohibition, in final form: never re-pin a lost base WITHOUT reconciling first.
       Reconciliation is the recovery, and pinning is its final step, not a shortcut around it.
     - The exit-4 report must still name the pinned sha and the fetched tip (D-18) so the user
       understands why the base is gone before agreeing to synthesise.

D-37: [accepted, partially superseded-by D-41] **The skill SHALL refuse to begin any merge unless the vendored directory is
     clean (`git status --porcelain <dir>` empty), and SHALL author all files only after every
     decision is collected.**
     - Evaluated: clean-tree precondition + author at end; precondition + incremental writes;
       stage in a temp copy and swap atomically.
     - The hazard being mitigated: a merge abandoned half-written leaves partial edits in the
       vendored directory while `pin` has not run, so the NEXT sync's diff 1 compares against the
       old base, reports those fragments as deliberate local modifications, deduces an intent for
       them, and defends them against upstream. Silent and self-reinforcing.
     - Rejected stage-and-swap: closes the window fully but adds machinery, and the result would
       be reviewed in a temp directory rather than through `git diff` in the real tree.
     - Rejected incremental: wider exposure window for the benefit of durable partial progress,
       which is worth little when re-running `inspect` is cheap and deterministic.
     - Chosen because: the precondition is what makes `git checkout -- <dir>` an unconditionally
       safe abandon. Without it, that command also destroys unrelated in-flight work — so the
       precondition, not the abandon instruction, is the actual mitigation. It additionally
       prevents merging on top of unrelated uncommitted edits, which would tangle the two
       beyond separating.
     SCOPE CORRECTION: the abandon-command clause is superseded by D-41 — the skill states no
     abandon command and does not remedy a dirty tree; it halts. D-41 also identifies the
     precondition as the DETECTOR of an abandoned merge, not merely a guard. The precondition and
     the author-at-end rule stand.

D-36: [accepted] **Responsibility split, governed by one rule: the SCRIPT states facts and never
     talks to the user; the SKILL makes judgements and never runs git directly.**
     - Script owns: manifest discovery/parse/validate/write; ALL git invocation (fetch, refs, sha
       resolution, ancestry checks, diff computation, subtree extraction); slug and path
       derivation; exit codes and remedy data; reporting factual state.
     - Skill owns: action triage (D-14); choosing where script output lands (D-12); grouping hunks
       into semantic changes and stating the totality mapping (D-31); deducing local intent with
       evidence (D-9, D-21); deducing upstream reasons and judging wantedness (D-16); Phase A/B
       sequencing (D-32); idea extraction and synthesis with no base (D-33); offering the two
       paths on a non-empty `add` (D-34); authoring files; per-item confirmation before writing
       (D-21); deciding when to pin and with which sha (D-23); reacting to exit codes (D-18);
       the completion report (D-17).
     - User owns: committing, and deleting a directory after `remove` (D-10).
     - Chosen because: the earlier design merged these two responsibilities, which is what left
       the skill undesigned (Q-3) — every flow was written as a sequence of script invocations.
       The rule also gives a test boundary: anything the script owns is unit-testable, anything
       the skill owns is reviewable prose with an observable DoD.

D-35: [accepted] **Add a sixth verb: `vendor-export <dir> <dest> [--sha <commit>]`, which
     materializes the upstream tree at the pinned (or given) sha into `<dest>` for reading.**
     Extends D-5's verb set to add / check / inspect / pin / remove / export.
     - Evaluated: a new `export` verb; the skill running `git archive` itself; extending
       `inspect` with a tree kind.
     - Rejected skill-runs-git: puts sha, path and ref derivation into untestable skill prose —
       the same objection that killed the minimal-script option in D-5 — and violates D-36's rule.
     - Rejected extending `inspect`: every other `inspect` kind writes one diff to stdout; a kind
       that writes files to a path breaks that contract for no gain.
     - Needed by: D-33 synthesis (the skill must read upstream's full files), the pristine
       fast-path re-materialization (D-3), and `vendor-add`'s own materialize mode, which can now
       be implemented in terms of it.

D-34: [accepted] **When `vendor-add` targets a directory that already has content, the script
     STOPS and reports; the skill then offers the user two paths. It does not auto-proceed into
     a merge.** Refines D-15, whose "adopt" mode auto-detected and proceeded.
     - **Path 1 — vendor into a different, non-existent local directory.** The upstream copy
       lands clean with a base pinned from the start, and the pre-existing folder is left
       untouched. This SIDESTEPS the no-base problem entirely rather than solving it.
     - **Path 2 — guided merge** (D-33).
     - Chosen because: the escape hatch is often the better engineering answer and costs nothing
       to offer, whereas silently entering the hardest flow in the design because a directory
       happened to be non-empty is a poor default. The user picks; the script never decides.

D-33: [accepted] **Reconciliation WITHOUT a base is idea-level synthesis, not diff-driven
     merging.** Resolves Q-4.
     - The skill reads BOTH versions in full — not a diff between them — extracts the ideas and
       intentions present on each side, discusses with the user which ideas to keep from which
       side, and authors a COMPLETELY NEW version as the result.
     - Evaluated: per-difference content choice ("what should this be?"); asking the user to
       attribute each difference; heuristic attribution by the skill; idea-level synthesis with
       an escape hatch (chosen, proposed by the user).
     - Rejected all three difference-based options: they presuppose that a diff between the two
       versions is meaningful. When the versions have diverged substantially — the actual case
       here, 148 local lines against 440 upstream — a diff degenerates into noise, and picking a
       side per difference cannot produce a coherent document.
     - Explicitly accepted as fallible: synthesis may get things wrong, which is precisely why it
       is user-gated per D-21. The gate is not a formality here; it is the correctness mechanism.
     - Consequence: the WITH-base and WITHOUT-base flows use genuinely different mechanisms
       (diff-driven semantic changes vs. full-content idea synthesis), not one mechanism with
       less evidence. D-30's "two shapes" framing stands, but the shapes are not variations of a
       single procedure.
     - Consequence: the skill must be able to READ the upstream version's files, so something must
       materialize the upstream tree at a readable path. Diff 1 is not computable without a base
       and is not used in this flow.

D-32: [accepted] **The reconciliation dialogue has two phases: local intent is established and
     corrected BEFORE any upstream change is judged.**
     - Phase A: the skill presents each deduced local intent with the hunk it derives from; the
       user corrects. Usually a formality — local modifications barely change between syncs — so
       it is presented compactly enough to answer with one "yes".
     - Phase B: the skill presents each upstream change with a deduced reason and an
       adopt/decline recommendation justified against the NOW-AGREED local intent.
     - Evaluated: two phases; a single combined pass; upstream-first.
     - Rejected the combined pass: every recommendation would rest on an unconfirmed local
       intent, so a wrong deduction and a wrong recommendation arrive fused together and the user
       has to untangle which of the two is actually wrong.
     - Rejected upstream-first: structurally reintroduces the assumption D-16 rejected, that a
       non-colliding upstream change needs no reference to local direction.
     - Chosen because: under D-16 the local intent IS the criterion for wantedness, so
       establishing it is logically prior, not merely tidier.

D-31: [accepted] **The unit of decision is the SEMANTIC CHANGE, with a totality guarantee: the
     skill groups hunks into named changes and MUST account for every hunk in exactly one group,
     stating that mapping.**
     - Evaluated: per semantic change with totality; per file; per hunk.
     - Rejected per file: a file holding both a wanted and an unwanted change cannot be split, so
       those files degrade into manual editing — the exact work the skill exists to do.
     - Rejected per hunk: 1:1 with git output so nothing can hide, but hunks split mid-thought,
       so the user judges fragments stripped of the context that gives them meaning, and a
       twenty-hunk update becomes twenty decisions.
     - Chosen because: grouping gives a human-sized unit, and the totality guarantee is what makes
       grouping SAFE — "was anything buried inside a change I accepted?" becomes a checkable
       property (every hunk maps to exactly one named group) instead of a matter of trust. Without
       totality, grouping is the skill's unverifiable judgement.

D-30: [accepted] **There are only TWO merge shapes, and three situations map onto them.**
     - **Three-way** — a usable base exists. Evidence is diff 1 (local vs base) and diff 2
       (base vs upstream tip), as in F-18.
     - **Two-way** — no usable base. Evidence is a single comparison of the local version against
       the upstream version, with no common ancestor to appeal to and therefore no way to
       attribute a difference to "someone changed this".
     - Situation mapping: a normal sync with a valid pin is three-way; `add` into a non-empty
       directory (adopt, D-15) is two-way; and a pinned sha that is unreachable after fetch
       (exit 4) is ALSO two-way.
     - Supersedes D-22's remedy: exit 4 is no longer "terminal, ask and stop". The recovery is the
       two-way reconciliation followed by pinning the new sha. D-22's actual concern — that a
       SILENT re-pin presents the user's accumulated local divergence as though it were an
       upstream change — is satisfied, because in two-way mode that divergence is exactly what is
       deliberately reviewed rather than assumed away. D-22's prohibition narrows from "never
       re-pin" to "never re-pin without reconciling first".
     - Chosen because: it removes a special case rather than adding a handler for it. One
       protocol serves both adopt and pin-loss, and only the presence of a base distinguishes the
       two shapes. Noted by the user: an unreachable sha leaves the same two-sided situation as
       add.

D-29: [accepted] **`vendor-remove` is preceded by an explicit confirmation, and the skill states
     that re-adding later starts from a fresh pin.**
     - The script prints what will happen (connection dropped, ref deleted, N files retained)
       before acting, and the skill confirms intent with the user first.
     - The skill must also state the one-way consequence: re-adding works, but against a new
       pin, so accumulated local modifications would then present as one large divergence
       rather than a tracked lineage — because the old merge base is no longer recorded anywhere
       (the manifest is gone and the ref is deleted).
     - Chosen because: `remove` is the only action that discards state which cannot be
       reconstructed, and D-10 deliberately made it non-destructive to files — which risks it
       reading as harmless when its provenance loss is permanent.

D-28: [accepted] **`vendor-pin` validates that the supplied `--sha` is reachable from the tracked
     ref, rejecting a non-ancestor with exit 7 — the same ancestry check `vendor-add` applies.**
     - Extends the F-36 / D-11 ancestry rule from `add` to `pin`. D-23 required `pin` to take an
       explicit `--sha` but did not say it must be validated.
     - Chosen because: `pin` writes the merge base that every future diff 1 depends on. An
       unreachable sha recorded there produces exactly the F-23 / D-22 failure — a pin that
       cannot be resolved on the next sync — so the cheap check belongs at the moment of writing,
       not at the moment of discovery.

D-27: [accepted] **Connections are discovered by globbing the repository for `.vendor.json`
     files; there is no central registry.**
     - Evaluated: glob for manifests; a single top-level registry file listing all connections.
     - Rejected the registry: it is a second place to keep in sync, it must be hand-edited to add
       a connection (the objection that killed the exclude list), and it can disagree with what
       is actually on disk.
     - Chosen because: the manifest already sits in the vendored directory, so the directory is
       self-describing; adding or removing a connection requires no edit anywhere else, which is
       what makes `add` and `remove` single-step operations.

D-26: [accepted] **Exit code table refinement of D-18: add `7` = "`--sha` is not an ancestor of
     `--ref`".** D-18 folded this into `6` (precondition conflict) alongside "already vendored",
     giving one code two distinct meanings and two distinct agent reactions. Splitting them keeps
     each code actionable: `6` means stop and choose sync-or-remove, `7` means the requested
     commit is unreachable from the tracked branch and a different ref or commit is needed.
     Final table: 0 ok / 1 usage / 2 git-network / 3 manifest / 4 pin unreachable / 5 upstream
     subpath missing / 6 already vendored / 7 sha not an ancestor / 10 check-status "behind".

D-25: [accepted] **Pre-mortem mitigation — vendored copy drifts because nobody runs `check`.**
     Failure: upstream improves for a year, nobody remembers to sync, the vendored copy silently
     rots. Root cause: the whole mechanism depends on a human remembering to invoke it, with no
     trigger.
     Mitigation: `vendor-check` exits `10` when any connection is behind, specifically so it can
     be wired into CI or a periodic `/loop` and surface drift without anyone remembering.
     Landed as: AC on `vendor-check` exit codes.

D-24: [accepted] **Pre-mortem mitigation — materialize mode clobbers real local work.**
     Failure: mode detection misjudges a directory as empty and `tar` overwrites existing
     content. Root cause: an "emptiness" heuristic deciding a destructive action.
     Mitigation: materialize ONLY when the directory is absent or contains zero entries
     (dotfiles included). If it contains anything at all, adopt mode is used instead — and adopt
     mode writes no files beyond the manifest, so neither branch can clobber.
     Landed as: NEVER boundary (never extract into a directory containing any entry) + AC.

D-23: [accepted] **Pre-mortem mitigation — upstream changes marked synced but never applied.**
     Failure: `pin` records a sha while the merge was abandoned or never written, so those
     upstream changes are permanently invisible to every future sync — silently lost, with no
     mechanism that would ever resurface them. Root cause: `pin` is the sole record of what was
     synced, and it is decoupled from the file writes.
     Mitigation: `pin` SHALL take the explicit `--sha` that `inspect` used (never a re-resolved
     tip), SHALL run only after merged files are written, and SHALL warn when the vendored
     directory has no working-tree modifications while diff 2 was non-empty. That state is
     legitimate when every upstream change was declined, so it warns rather than refuses — and
     D-17's completion report MUST state which upstream changes were declined, making
     "nothing changed" an explicitly reported outcome rather than an accident.
     Landed as: ALWAYS boundary on explicit `--sha` + AC on the warning + AC on the report.

D-22: [superseded-by D-30, D-38, D-75] **Pre-mortem mitigation — silent re-pin destroys the diff-1 base.**
     Failure: upstream force-pushes, the pinned sha becomes unreachable, and the agent "helpfully"
     re-pins to the current tip. Every subsequent diff 1 then presents the user's entire
     accumulated local divergence as though it were a change to review, and the real merge base
     is gone for good. Root cause: treating an unrecoverable state as a recoverable one.
     Mitigation: exit `4` is terminal. The agent SHALL report the pinned sha and the fetched tip
     and SHALL NOT re-pin without an explicit instruction from the user.
     Landed as: NEVER boundary (never re-pin on exit 4 unprompted) + ASK FIRST + AC.

D-21: [accepted] **Pre-mortem mitigation — a wrong deduction is nodded through (resolves Q-2).**
     Failure: the skill infers a plausible-but-wrong reason for a local modification, the user
     skims a long list and approves, and the merge silently reverts the local intent. Root cause:
     deductions presented as conclusions rather than as claims needing verification, plus
     approval fatigue on a bulk list.
     Mitigation: every deduced intent SHALL be presented with its evidence — the specific diff
     hunk — inline beside the claim, and each local modification that an upstream change touches
     SHALL be confirmed individually rather than by bulk approval.
     Landed as: ALWAYS boundary (cite the hunk for every deduced intent) + NEVER boundary
     (never write merged files before per-item confirmation) + AC.

D-20: [accepted] **Drop `inspect log`; `vendor-inspect` emits only `local` and `upstream`.**
     Supersedes the optional-hint clause of D-9; D-9's core decision (deduce, do not record)
     stands, as does F-34 as a recorded fact about what the log can provide.
     - Chosen because: this repo's last five commit subjects are `updates`, `updates`, `updates`,
       `small fixes`, `writing documentation` — four of five would contribute nothing to a
       deduction, and a bundled "updates" commit spanning unrelated changes can actively mislead
       it. The two diffs are always informative; the log is not. Trivial to reinstate if commit
       hygiene changes. (Source: `git log` of this repo)

D-19: [accepted] **A missing `refs/vendor/<slug>` is recovered by refetching in `check`/`inspect`,
     but is a silent no-op in `remove`.**
     - Chosen because: sync-side commands fetch first regardless (D-4), so a fresh clone with no
       `refs/vendor/*` (F-23) self-heals with no special case. `remove` needs no network at all,
       and fetching in order to delete would add an offline failure mode to an operation that has
       no other reason to fail.
     - Critical distinction: refetching restores the ref at the CURRENT tip, which makes the
       pinned sha reachable only if it is still an ancestor. If upstream rewrote history the pin
       is genuinely unrecoverable, and that MUST surface as a distinct loud error (exit 4), never
       as a silent re-pin to a new base — a silent re-pin would destroy the diff-1 base and
       present the user's entire accumulated local divergence as if it were an upstream change.

D-18: [accepted] **Explicit error model: distinct exit codes per failure class; every script
     prints the cause AND the data needed to act on it; the agent never retries blindly.**
     Exit codes: `0` success; `1` usage error; `2` git/network failure (auth, unreachable repo,
     missing ref upstream) with git's stderr passed through verbatim; `3` manifest problem
     (absent, malformed JSON, missing field); `4` pinned sha unreachable after fetch; `5`
     upstream subpath absent at the resolved commit; `6` precondition conflict (slug or ref
     already exists). `vendor-check` additionally uses `10` as a STATUS code meaning "at least
     one connection is behind", so CI can distinguish "work to do" (10) from "broken" (2/3/4).
     - Scripts must emit remedy data, not just a message: on `2` for a missing upstream ref,
       list `git ls-remote --heads`; on `5`, list what DOES exist at that path level; on `4`,
       state the pinned sha and the fetched tip.
     - Agent reactions: `2` report verbatim and ask about access or ref choice, never retry; `3`
       offer to repair the manifest or re-add; `4` explain that re-pinning loses the diff base and
       ask before doing anything; `5` show the available paths and ask; `6` explain the directory
       is already vendored and offer sync or remove.
     - Chosen because: a skill that only describes the happy path leaves the agent improvising at
       exactly the moment improvisation is most costly.

D-17: [accepted] **After `pin`, the skill reports what it did and states explicitly that the
     sync is finished** — which connection, from which sha to which, which upstream changes were
     adopted, which were declined and why, and that the result is staged for the user to review
     and commit. Mirrors the "Closing: Report Completion" pattern of the brainstorm skill itself.

D-16: [accepted] **Deduction is symmetric and wantedness is independent of collision.** The
     skill infers and presents intent for BOTH sides: for each local change what it does and why,
     and for each upstream change what it does and why upstream made it. Every upstream change is
     then assessed for whether it is WANTED given the local direction — a judgement entirely
     separate from whether it textually collides.
     - Supersedes the earlier three-bucket classification (clean / collides / touches-deleted),
       which wrongly treated "does not collide" as "adopt verbatim".
     - Chosen because: an upstream change can be unwanted while colliding with nothing at all —
       a new reference file, or a new section, that cuts against the local direction. The
       locally-deleted-file case (F-14) is just one instance of that general class, not a special
       case. The merge has two sides, each with changes and reasons.

D-15: [accepted, partially superseded-by D-34, D-39] **`vendor-add` has two modes, selected by whether the local directory already
     has content.**
     - **Materialize** (directory absent or empty): fetch, `git archive`/`tar` the subtree in
       (F-35), write `.vendor.json`, and STOP. Report that the folder is loaded and ready for
       local modification; the user then decides whether to modify it manually or with an agent.
       The skill does NOT drive modifications here.
     - **Adopt** (directory exists and is non-empty): do NOT extract anything — the `tar` step
       would clobber existing local content.
       SCOPE CORRECTION: this mode originally wrote `.vendor.json` before reconciling. D-34 makes
       the script write NOTHING and hand the choice of two paths to the skill; D-39 requires the
       manifest to be written LAST, after reconciliation. The no-clobber principle stands.
     - Adopt mode is inherently non-destructive (it writes no files beyond the manifest), so
       auto-detecting the mode is safe; the script must print which mode it chose.
     - Note: in adopt mode there is no upstream CHANGE set, so it is a two-way reconciliation of
       local-vs-upstream rather than the three-way shape of a sync.

D-14: [accepted] **The skill covers all three lifecycle actions — add, sync, remove — not just
     sync.** `/vendor-sync` first establishes which action is wanted, then follows that flow.
     - Chosen because: each action needs judgment the scripts cannot supply (what to modify
       after adding; how to merge; whether removing is really what is meant), and a single
       entry point means the user never has to remember five script paths.

D-13: [accepted] **All scripts are node `.mjs` (ESM) invoked as
     `node .claude/skills/vendor-sync/scripts/<name>.mjs`, sharing a `lib.mjs`.**
     - Evaluated: extensionless bash matching the F-24 precedent; bash + jq; node `.mjs`.
     - Rejected bash + jq: every script reads or writes `.vendor.json`, and jq is not a project
       dependency (F-38) — it happens to be installed on this machine only.
     - Rejected extensionless executables: cannot reliably use ESM imports (F-38), which the
       shared `lib.mjs` requires. This knowingly departs from the F-24 call convention.
     - Chosen because: node is guaranteed by the project, JSON is native to it, and `.mjs`
       matches the existing `scripts/*.mjs` files.

D-12: [accepted] **Scripts write their output to stdout; the SKILL decides where it lands,
     redirecting into a `mktemp -d` directory. No location is hardcoded in any script, and
     nothing is written into the working tree.**
     - Evaluated: scripts write to a fixed self-ignoring `.vendor-sync/` workspace in the
       working tree (the `sdd-workspace` precedent); scripts write to stdout and the skill
       redirects to a temp dir; scripts write to stdout and the skill redirects into the working
       tree.
     - Rejected the fixed workspace: hardcodes policy into the scripts, and needs a
       self-ignoring `.gitignore` to avoid polluting `git status` for artifacts that are
       worthless the moment the merge is committed.
     - Chosen because: stdout keeps the scripts composable and testable, the redirect happens in
       the shell so a large diff still never enters the agent's context (preserving the F-25
       benefit), and a temp dir needs no cleanup or gitignore. Re-running `inspect` is cheap and
       deterministic if the artifacts are lost.
     - Consequence: `vendor-inspect <dir> <local|upstream|log>` takes the artifact kind as an
       argument and emits ONE stream, so each can be redirected to its own file, rather than
       emitting a combined stream the skill would have to split.
     Scope correction: the `log` kind in that signature is superseded by D-20; the accepted
     signature is `vendor-inspect <dir> <local|upstream>`. The one-stream-per-invocation
     consequence itself stands.

D-11: [accepted] **`vendor-add <repo> <upstream-path> <local-dir> [--ref <branch>] [--sha
     <commit>]`.** `--ref` selects the tracked branch (default `main`); `--sha` pins a specific
     commit instead of the branch tip, validated as an ancestor of `--ref` (F-36) so future
     fetches keep it reachable. Materializes via `git archive` (F-35) and leaves everything
     unstaged for review.

D-10: [accepted] **`vendor-remove <dir>` removes only the vendored CONNECTION — it deletes
     `.vendor.json` and the `refs/vendor/<slug>` ref, and RETAINS every vendored file.**
     - Evaluated: delete the connection and the directory; delete only the connection.
     - Rejected deleting the directory: conflates "stop tracking upstream" with "delete my
       skill". The common reason to remove a connection is that the local copy has diverged
       enough to own outright.
     - Chosen because: after removal the files are simply local files the user owns, which is
       the desired end state; deleting the directory is a separate `rm` the user can run.

D-9: [accepted] **No written intent record of any kind. The skill DEDUCES the reason for each
     local modification from diff 1, presents its deductions to the user for correction, and only
     then proposes the merge. Resolves Q-1.**
     - Evaluated: deduce-and-confirm (chosen); commit messages as the intent record with
       `inspect` emitting the local log; an optional `notes` field in the manifest; a tracked
       `LOCAL-CHANGES.md` in the vendored dir.
     - Rejected all three written forms: each imposes ongoing maintenance effort on the vendored
       copy, and the manifest variant is the hand-edited config already rejected (see Rejected
       Approaches). The goal is minimal effort to keep a vendored copy alive.
     - Chosen because: diff 1 is usually self-explanatory (a config lookup visibly replacing a
       resolution ladder; a deleted reference file), so intent is recoverable without being
       recorded. Making the deduction an explicit review checkpoint is strictly better than an
       unreviewed assumption, and costs the user only a glance.
     - The local commit log (F-34) remains an OPTIONAL accuracy hint the skill may read when
       present; nothing depends on it, and the user is never required to write it.

D-8: [accepted] **Place the skill at `.claude/skills/vendor-sync/` (project-local, tracked in
     git) and set `disable-model-invocation: true` in its frontmatter.**
     - Evaluated: `skills/vendor-sync/` alongside the published skills; `.claude/skills/`
       project-local; a non-skill `tools/` directory.
     - Rejected `skills/`: the release workflow ships the whole tree with no allowlist (F-28)
       and no per-subdirectory exclusion exists (F-32), so it would be published to every nessy
       consumer — for whom repo-maintenance vendoring is meaningless.
     - Rejected `tools/`: not a skill, so not invocable, which defeats D-3.
     - Chosen because: `.claude/skills/` is confirmed unpublished (F-31) while still invocable
       when working in this repo, and it is already an in-use location here (F-29).
     - `disable-model-invocation: true` is additionally required because project-local skills are
       still advertised to the model by default (F-33). Vendoring is a deliberate maintenance
       operation that must never auto-trigger mid-task; explicit `/vendor-sync` only.

D-7: [accepted] **Name it `vendor-sync`.**
     - Evaluated: `vendoring-upstream`, `managing-vendored-copies`, `syncing-upstream-copies`,
       `vendor-sync`; earlier skill-specific candidates (`vendoring-skills`,
       `syncing-vendored-skills`, `skill-merger`) were dropped once F-27 established the
       mechanism is not skill-specific.
     - Rejected `skill-merger`: names only the merge step and wrongly implies skill-only scope.
     - Chosen because: generic, short, and says both halves (vendoring + syncing). It breaks the
       repo's gerund convention for skill names, which is acceptable here because that convention
       governs published skills in `skills/` (F-24) and this one is project-local (D-8).

D-6: [accepted] **The tooling lives inside the skill's own directory as extensionless bash
     scripts (`skills/<skill>/scripts/*`), not as a standalone repo-root CLI. The skill, not the
     CLI, is the named unit.** This overrides D-2's `scripts/*.mjs` detail; D-2's actual
     decision (repo-local, not a shipped feature) still stands.
     Scope correction: two details of this entry were later changed. The language "extensionless
     bash" is superseded by D-13 (node `.mjs`, because every script handles JSON and jq is not a
     project dependency). The path `skills/<skill>/scripts/*` is superseded by D-8
     (`.claude/skills/vendor-sync/scripts/*`, because `skills/` would publish it). D-6's actual
     decision — the tooling lives inside the skill directory and the skill is the named unit —
     stands.
     - Evaluated: move the tooling into the skill directory; keep a standalone repo-root CLI and
       reinstate `git apply` so it has standalone value.
     - Rejected the standalone CLI: with merging moved to the skill (D-3), no command is useful
       on its own except `check` — and skill-local scripts remain path-addressable from CI
       anyway (F-26), so the trade-off is illusory. Reinstating `git apply` purely to justify the
       CLI's shape would revive a mechanism rejected on evidence (F-12).
     - Chosen because: it matches the established skill-local precedent (F-24), keeps the
       vendoring machinery next to the only thing that uses it, and makes the skill the single
       named unit.

D-5: [accepted] **Verb set: `add`, `check`, `inspect`, `pin`, `remove`. The skill orchestrates
     an update as check -> inspect -> merge -> pin. There is no `update` command.**
     - Evaluated: primitives with skill orchestration; keeping `add`/`check`/`update`/`remove`
       with `update` writing a merge-request file; a minimal `add`/`check`/`remove` with the
       skill running raw git itself.
     - Rejected the four-verb shape: `update` cannot exist as a script command because its
       middle step is judgment (D-3); it would only write an intermediate report artifact.
     - Rejected minimal: pushes manifest parsing and path derivation into untestable skill prose.
     - Chosen because: `pin` as an explicit final step makes an abandoned merge safe — the sha
       stays where it was, so nothing is silently marked synced. `check` is independently useful
       by hand, in CI, or in a `/loop`.

D-4: [accepted] **Keep `refs/vendor/<slug>` as a permanent local ref; every command fetches
     before doing anything; `remove` deletes both the skill directory and the ref.**
     Scope correction: the clause "`remove` deletes both the skill directory and the ref" was
     wrong and is superseded by D-10 (connection only, files retained). The clause "every command
     fetches before doing anything" is narrowed by D-19 to the sync-side commands only —
     `remove` performs no network operation. D-4's actual decision (a permanent local ref) stands.
     - Evaluated: permanent local ref; fetch-to-temp-ref-then-delete; tracking a pristine
       upstream copy as a second directory in this repo so no upstream objects are needed.
     - Rejected temp ref: deleting it makes the previously recorded sha's objects unreachable
       and GC-able, breaking diff 1 on the NEXT sync. Would require re-fetching an exact sha,
       which not every server permits.
     - Rejected pristine-copy directory: self-contained and inspectable, but duplicates the
       vendored files in-repo and adds a second thing that can be edited by mistake. Its main
       benefit (no dependence on upstream objects) is not needed given F-21/F-22.
     - Chosen because: the storage cost is ~200 KiB (F-21), it makes the recorded sha immune to
       upstream history rewrites (F-22), and fetch-first makes fresh clones self-healing (F-23).

D-3: [accepted] **The skill owns all merging; the script never runs `git apply`. The script
     fetches, computes the two diffs, and records the sha. A pristine vendored skill (empty
     diff 1) is a straight overwrite needing no judgment.**
     - Evaluated: skill merges with no `git apply`; hybrid (`git apply -3` first, skill as
       fallback); skill merges unconditionally including the no-local-modifications case.
     - Rejected hybrid: two merge paths to maintain, and F-12 shows `git apply` can exit 0 while
       producing a semantically wrong result (locally-authored body under an upstream-renamed
       heading), so a zero exit is not a trustworthy "merged correctly" signal — which was the
       entire justification for a fast path.
     - Rejected unconditional: spends model judgment on a case that is provably a file copy.
     - Chosen because: the two diffs cannot fail (F-18), jointly encode local intent (F-19), and
       need no configuration — which dissolves the exclude-list problem rather than fixing it.
       Vendored content is ~630 lines with very low churn (F-1, F-2), so always-reason costs
       little, while a silently wrong merge is a corrupted skill that goes unnoticed for months.

D-2: [accepted] **Build this as repo-local maintenance tooling (`scripts/*.mjs` + npm scripts)
     for the nessy repo only, not as a shipped feature or a standalone tool.**
     - Evaluated: repo-local tooling; shipped harness feature (CLI subcommand family + bundled
       skill, public contract, Zod config, tests, ADR); standalone tool in its own repo.
     - Rejected shipped feature: multiplies the work while the design is unproven, and freezes a
       public interface before a single real merge has been run.
     - Rejected standalone tool: a third artifact to version and maintain for one present need.
     - Chosen because: the present need is one skill from one upstream (F-1). The hard part (git
       plumbing) is identical in all three, so promotion stays cheap and open. Follows the
       existing maintenance-script convention (F-7).

D-1: [accepted] **Vendor upstream skills into this repo as ordinary tracked files, with a
     per-skill provenance manifest — not as git submodules or git subtree.**
     - Evaluated: git submodule; git subtree; vendored copy + recorded upstream SHA; no
       vendoring at all (just consume the installed upstream plugin).
     - Rejected submodule: pins a whole repo not a subpath (F-1), wrong path depth (F-3), and
       fundamentally read-only w.r.t. local edits — which are the entire point here (F-6).
     - Rejected subtree: `--prefix` also operates on the upstream root, so extracting one
       subpath needs a `git subtree split` against an upstream clone on every update, plus the
       same path remapping. Heavy machinery for ~630 lines of prose (F-1).
     - Rejected no-vendoring: cannot carry the local config-feature integration, and leaves two
       competing brainstorm skills triggering against each other.
     - Chosen because: it is the only option that supports permanent local modification while
       still allowing upstream deltas to be replayed onto the modified copy as a three-way
       merge.

## Rejected Approaches

git submodule: whole-repo granularity, wrong skill path depth, read-only working tree. Would
  only be reconsidered if upstream published the skill as its own standalone repo AND local
  modification were dropped.

git subtree: viable but requires re-splitting the upstream subpath on every update. Would be
  reconsidered if upstream's repo root ever became the vendored unit.

Pathspec `exclude` list in the manifest: proposed to fix F-14 (upstream editing a
  locally-deleted file atomically aborting the sync), and proven to work (F-15). Rejected
  because it requires the user to hand-edit a config file correctly before the tooling is
  usable, and because it is redundant under a diff-driven design: the local diff already states
  the deletion as evidence (F-19), auto-derived and immune to drift. Would only be reconsidered
  if `git apply` were reinstated as the primary merge mechanism.

Per-modification intent notes in the manifest: proposed to carry the "why" behind local edits
  into conflict resolution. Superseded in part by F-19 — diff 1 conveys WHAT was changed
  locally, auto-derived. Status update: fully rejected by D-9, which resolved Q-1 in favour of
  deducing intent and confirming it with the user. It will NOT return as an optional field; the
  "may return" clause above is superseded. Would only be reconsidered if deduction proved
  unreliable in practice (the residual risk accepted in D-60, which closed Q-2).

Commit messages as the intent record, with an `inspect log` mode: proposed as the zero-cost
  carrier of WHY (F-34). Rejected by D-20 — this repo's recent commit subjects are `updates`,
  `updates`, `updates`, `small fixes`, so four of five would contribute nothing and a bundled
  commit can actively mislead a deduction. Would be reconsidered if commit hygiene changed.

## Open Questions / Assumptions

Q-1: [resolved by D-9] How does the "why" behind a local modification reach the merge, given
     that diff 1 conveys only WHAT changed (F-19)?
     - Resolution: it is deduced from the diff and confirmed by the user, not recorded.

Q-6: [closed by D-61] Does `disallowed-tools` support a pattern such as `Bash(git:*)` rather
     than only whole tool names?
     - Closure: the question is moot because the design no longer depends on the answer. D-61
       drops `disallowed-tools` entirely; D-36 is enforced by instruction like every other rule.

Q-3: [resolved by D-31, D-32, D-36, D-48, D-53..D-59] The skill itself is undesigned. Everything
     decided so far specifies the SCRIPT layer. Unresolved at the time: what the skill asks and in
     what order; what the unit of decision is; how both sides are presented; how a decision
     becomes a file write; where script responsibility ends and skill responsibility begins.
     - Resolution: decision unit is the semantic change with a totality guarantee (D-31);
       ordering is two-phase, local intent before upstream judgement (D-32); the
       script/skill boundary is "scripts state facts and never talk to the user, the skill judges
       and never runs git" (D-36, hole closed by D-57); presentation is total and local
       intents have standing (D-48), with a decision required for every upstream change (D-70); writes happen once all decisions
       are collected, behind a pristineness precondition (D-37, D-41); and the skill's own
       structure, arguments and disclosure are D-53..D-59.

Q-4: [resolved by D-33, D-47] The no-base protocol was specified only as an outcome, not a
     procedure. Adopt mode and pin-loss recovery both depend on it.
     - Resolution: it is idea-level synthesis rather than diff-driven merging (D-33), beginning
       with a per-side inventory of named ideas carrying verbatim text spans, with a totality
       guarantee over both documents (D-47). An escape hatch is offered at both entry points
       (D-34, D-45).

Q-5: [closed by D-62..D-66] The pre-mortem recorded as D-21..D-25 examined only the script
     layer, because that was the whole of the design at the time.
     - Closure: re-run across the skill layer, yielding five further failure modes (D-62..D-66):
       default-adopt blindness, synthesis drift, operating on the wrong directory, an action
       inferred from argument shape, and an orphaned upstream with no exit.
     - Of that batch only D-64 survives as written: D-62 was replaced by D-70 (remove the default
       rather than report around it), D-63 by D-69 (verbatim assembly is unachievable), D-65 by
       D-68 (one completeness gate), and D-66 withdrawn by D-67 (out of scope).
     - D-21..D-25 survive unchanged as script-layer mitigations. A THIRD pass, driven by an
       implementer-readiness review of the spec, produced D-75..D-87.

Q-2: [closed by D-60] Deduced intent is accurate enough that the user will catch the cases
     where it is wrong.
     - Current assumption: local modifications are visible enough in diff 1 that a wrong
       deduction is obvious when presented.
     - Impact if wrong: a subtle local modification whose purpose is NOT evident from the diff
       (e.g. a deliberately weakened instruction that reads like a typo fix, or a deletion that
       looks incidental) gets a plausible-but-wrong deduced reason, the user nods it through, and
       the merge silently reverts the local intent. This is the primary residual risk of D-9.
     - Mitigation: D-21 — every deduced intent is presented beside the diff hunk it derives from,
       and each local modification an upstream change touches is confirmed individually rather
       than by bulk approval. D-48 narrows it further: intents are preserved by default, so a
       wrong deduction must both survive review AND conflict with an upstream change before it
       changes any outcome.
     - Closure: D-60 accepts the residual risk explicitly — we expect deduction to be good
       enough. It cannot be closed by further design and only closes empirically.
