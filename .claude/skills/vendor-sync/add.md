# add

## Inputs
- `<repo>` — the upstream repository: a URL or an absolute local path.
- `<path>` — the upstream directory, relative to the upstream repository's root.
- `<dir>` — the destination in this project, relative to the repository root.
- `--ref <branch>` — optional; the branch to track. Default `main`.
- `--sha <commit>` — optional; pin this commit instead of the branch's tip.

When the user asked for `add <dir> --abort`, run `node scripts/vendor-add.mjs <dir> --abort` and
follow **aborted**.

## Run
```
node scripts/vendor-add.mjs <repo> <path> <dir> [--ref <branch>] [--sha <commit>]
```
Pass `--ref` and `--sha` only when the user gave them. On exit 0 follow the `state` under
**Outcomes**.

On exit 1 with `error.data.choices` `["resume", "abort", "leave"]`, print this block, filling
`<action>` and `<target_sha>` from `error.message`:

```
An unfinished <action> is still open on `<dir>`, started against <target_sha>. There are three options going forward, decide one:

resume    keep the work as it stands and finish the <action> from here.
abort     put `<dir>` back to its last committed state. Files the <action> created are
          deleted; anything else in the directory is left alone.
leave     change nothing. The <action> stays open and `<dir>` stays as it is.

Which one?
```

On exit 1 with `error.data.choices` `["abort", "leave"]`, print this block, filling `<action>` and
`<target_sha>` from `error.message`:

```
An unfinished <action> is still open on `<dir>`, started against <target_sha>. There are two options going forward, decide one:

abort     put `<dir>` back to its last committed state. Files the <action> created are
          deleted; anything else in the directory is left alone.
leave     change nothing. The <action> stays open and `<dir>` stays as it is.

Which one?
```

Then, on the user's answer:
- `resume` → run `node scripts/vendor-add.mjs <dir> --continue` and follow the outcome it returns.
  On exit 1 with `error.data.unresolved`, continue at step 5 of **merge_staged**, which handles
  it. On any other exit 1 (the add is still open, for example because changes are staged outside
  `<dir>`), show `error.message`, `error.hint` if present and the stderr if any, wait for the
  user, and run `--continue` again when they say so.
- `abort` → run `node scripts/vendor-add.mjs <dir> --abort` and follow **aborted**.
- `leave` → say that nothing was changed. **Done.**

On exit 1 with `error.data.branches` (the branch is not on the remote) or `error.data.entries`
(the upstream path is absent), show the list and ask the user for the corrected value.

## Outcomes

### ready
`<dir>` was empty or absent; upstream's files are now written into it and staged.
1. Show `repo` · `ref` · `path` · `sha` and the `files` list: the upstream files written into
   `<dir>`.
2. Only when `skipped_submodules` is non-empty, print this note, filling `<paths>` with
   `skipped_submodules` as a comma-separated list:

```
Note: upstream's submodules are not vendored, so these folders stay absent: <paths>.
```

3. Ask the user to review the files (for example with `git diff --staged` or in their IDE), then
   to confirm vendoring them.
4. On yes run `node scripts/vendor-add.mjs <dir> --continue` and follow the outcome it returns;
   on no run `node scripts/vendor-add.mjs <dir> --abort` and follow **aborted**.
   On exit 1 from `--continue` (the add is still open, for example because a file in `<dir>` is
   unmerged, the commit failed or changes are staged outside `<dir>`), show `error.message`,
   `error.hint` if present, `error.data.unresolved` if present and the stderr if any, wait for
   the user, and run `--continue` again when they say so.

### merge_staged
`<dir>` already held content; upstream's files are now merged into it as a conflict state.
1. Relay the identity fields (`dir`, `slug`, `repo`, `path`, `ref`) and `sha`, and `files` as a
   table with the columns `path` and `presence`.
2. Only when `skipped_submodules` is non-empty, print this note, filling `<paths>` with
   `skipped_submodules` as a comma-separated list:

```
Note: upstream's submodules are not vendored, so these folders stay absent: <paths>.
```

3. Print the note:

```
Note: there is no common base. Every file both sides have that differs is a conflict, and
files upstream deleted cannot be detected, so they stay.
```

4. Print the resolve prompt, filling `<action>` with `add`:

```
Resolve the files in `<dir>` with your IDE, `git mergetool`, or an editor, and review the
staged changes. Tell me when you are finished — I will then continue the <action>.
```

   Wait for the user. Answer their direct questions, and interpret and summarize nothing.
5. When they say they are finished, run `node scripts/vendor-add.mjs <dir> --continue` and follow
   the outcome it returns. On exit 1 with `error.data.unresolved`, list those paths and print the
   resolve prompt again, then wait as in step 4. On any other exit 1 (the add is still open,
   for example because the commit failed or changes are staged outside `<dir>`), show
   `error.message`, `error.hint` if present and the stderr if any, and wait as in step 4.

### added
1. Fill the add report under **Report** from this object: in the `files` line `<n>` is the
   number of `files`, the files the commit changed in `<dir>`.
2. Print the report.

**Done.**

### aborted
1. Fill the abort report under **Report** from this object: in the `restored` line `<n>` is
   the number of `restored` paths, in the `removed` line the number of `removed` paths, and the
   `left` line lists `left`.
2. Print the report.

**Done.**

## Report
Print a template without the parenthesized remarks on its right, and keep only the lines that
apply.

The add report, filled from `added`:

```
Vendored `<dir>` (connection `<slug>`)
  from      <repo> · branch <ref> · path <path>
  pinned    <sha>
  files     <n> changed
  commit    <commit>

The commit is local and not pushed; `git reset HEAD~1` undoes it. `remove` drops the connection.
```

The abort report, filled from `aborted`:

```
Aborted the open <action> on `<dir>` (connection `<slug>`)
  restored  <n> files to their last committed state
  removed   <n> files the action had created                (only if any were removed)
  left      <path> …                                        (only if any were left)
```
