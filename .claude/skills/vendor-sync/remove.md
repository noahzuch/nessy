# remove

## Inputs
- `<dir>` — the vendored directory.

Before running, ask the user to confirm, stating that every file in `<dir>` stays; that only
`.vendor.json`, the stored base and the upstream tracking go; and that vendoring the directory
again later starts without a base. Run only on yes; on no say that nothing was changed. **Done.**

## Run
```
node scripts/vendor-remove.mjs <dir>
```
On exit 0 follow the `state` under **Outcomes**.

## Outcomes

### removed
1. Fill the remove report under **Report** from this object.
2. Print the report.

**Done.**

## Report
The remove report, filled from `removed`:

```
Removed the vendoring connection `<slug>` from `<dir>`.
  retained  <files_retained> files; `.vendor.json` and the stored base deleted

The deletions are uncommitted — review and commit them. Deleting the directory, if wanted, is
your separate step.
```
