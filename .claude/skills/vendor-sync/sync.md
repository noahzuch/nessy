# sync

## Inputs
- `<dir>` — the vendored directory. Repository, branch and upstream path come from its
  `.vendor.json`.

When the user asked for `sync <dir> --abort`, run `node scripts/vendor-sync.mjs <dir> --abort` and
follow **aborted**.

## Run
```
node scripts/vendor-sync.mjs <dir>
```
On exit 0 follow the `state` under **Outcomes**.

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
- `resume` → run `node scripts/vendor-sync.mjs <dir> --continue` and follow the outcome it
  returns. On exit 1 with `error.data.unresolved`,
  continue at step 5 of **merge_staged**, which handles it. On any other exit 1 (the sync is still
  open, for example because changes are staged outside `<dir>`), show `error.message`,
  `error.hint` if present and the stderr if any, wait for the user, and run `--continue` again
  when they say so.
- `abort` → run `node scripts/vendor-sync.mjs <dir> --abort` and follow **aborted**.
- `leave` → say that nothing was changed. **Done.**

On exit 1 with `error.data.choices` `["base_from_pin", "leave"]`, print this block:

```
The stored base for `<dir>` <is missing from your last commit | does not match the pinned upstream commit <sha>>. There are two options going forward, decide one:

base_from_pin   use the pinned commit as the base; it is still available upstream.
leave           change nothing; the sync stops and `<dir>` stays as it is.

Which one?
```

On exit 1 with `error.data.choices` `["without_base", "leave"]`, print this block:

```
The stored base for `<dir>` <is missing from your last commit | does not match the pinned upstream commit <sha>>.
The pinned commit is no longer available upstream. There are two options going forward, decide one:

without_base    merge without a base: every file both sides have that differs becomes a
                conflict.
leave           change nothing; the sync stops and `<dir>` stays as it is.

Which one?
```

In either block, keep only the alternative of the first line that matches `error.message`:
`is missing from your last commit` when it says the stored base is missing from HEAD, or
`does not match the pinned upstream commit <sha>` when it says the stored base does not match,
with `<sha>` taken from `error.message`. Then, on the user's answer:
- `base_from_pin` → run `node scripts/vendor-sync.mjs <dir> --base-from-pin`.
- `without_base` → run `node scripts/vendor-sync.mjs <dir> --without-base`.
- `leave` → say that the sync stopped and nothing was written. **Done.**

If `--base-from-pin` exits 1 because the pinned commit is not available, show `error.message` and
ask the user whether to run `node scripts/vendor-sync.mjs <dir> --without-base` instead.

## Outcomes

### up_to_date
1. Fill the sync report under **Report** from this object: the `pinned` line shows `sha` on both
   sides, the `changes` line reads `changes   none: already up to date`, and the `commit` line is
   omitted.
2. Print the report.

**Done.**

### pin_ready
1. Explain that upstream moved but its files are identical, so only the pinned commit changes,
   from `sha_before` to `sha_after`.
2. Only when `skipped_submodules` is non-empty, print this note, filling `<paths>` with
   `skipped_submodules` as a comma-separated list:

```
Note: upstream's submodules are not vendored, so these folders stay absent: <paths>.
```

3. Ask the user to confirm.
4. On yes run `node scripts/vendor-sync.mjs <dir> --continue` and follow the outcome it returns;
   on no run `node scripts/vendor-sync.mjs <dir> --abort` and follow **aborted**.
   On exit 1 from `--continue` (the sync is still open, for example because a file in `<dir>` is
   unmerged, the commit failed or changes are staged outside `<dir>`), show `error.message`,
   `error.hint` if present, `error.data.unresolved` if present and the stderr if any, wait for
   the user, and run `--continue` again when they say so.

### merge_staged
Upstream's changes are now merged into `<dir>` as a conflict state.
1. Relay the identity fields (`dir`, `slug`, `repo`, `path`, `ref`), `base`, `sha_before` →
   `sha_after` and `commits_behind`, and `files` as a table: with the columns `path`,
   `upstream_changes` and `local_changes`, or, when `base` is `null`, `path` and `presence`.
2. Only when `skipped_submodules` is non-empty, print this note, filling `<paths>` with
   `skipped_submodules` as a comma-separated list:

```
Note: upstream's submodules are not vendored, so these folders stay absent: <paths>.
```

3. Only when `notes` holds `no_base`, print the note:

```
Note: there is no common base. Every file both sides have that differs is a conflict, and
files upstream deleted cannot be detected, so they stay.
```

4. Print the resolve prompt, filling `<action>` with `sync`:

```
Resolve the files in `<dir>` with your IDE, `git mergetool`, or an editor, and review the
staged changes. Tell me when you are finished — I will then continue the <action>.
```

   Wait for the user. Answer their direct questions, and interpret and summarize nothing.
5. When they say they are finished, run `node scripts/vendor-sync.mjs <dir> --continue` and follow
   the outcome it returns. On exit 1 with `error.data.unresolved`, list those paths and print the
   resolve prompt again, then wait as in step 4. On any other exit 1 (the sync is still open,
   for example because the commit failed or changes are staged outside `<dir>`), show
   `error.message`, `error.hint` if present and the stderr if any, and wait as in step 4.

### synced
1. Fill the sync report under **Report** from this object. When `files` is `[]`, use the line
   `changes   none: pin only` instead of the `files` line. Otherwise use the `files` line, with
   `<n>` the number of `files`, the files the commit changed in `<dir>`.
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

The sync report, filled from `synced` or `up_to_date`:

```
Synced `<dir>` (connection `<slug>`)
  from      <repo> · branch <ref> · path <path>
  pinned    <sha_before> → <sha_after>
  files     <n> changed
  changes   none: pin only | none: already up to date      (instead of the files line)
  commit    <commit>                                        (omit when already up to date)

The commit is local and not pushed; `git reset HEAD~1` undoes it.
```

The abort report, filled from `aborted`:

```
Aborted the open <action> on `<dir>` (connection `<slug>`)
  restored  <n> files to their last committed state
  removed   <n> files the action had created                (only if any were removed)
  left      <path> …                                        (only if any were left)
```
