# list

## Inputs
None.

## Run
```
node scripts/vendor-list.mjs
```
On exit 0 follow the `state` under **Outcomes**.

## Outcomes

### listed
1. When `connections` is `[]`, say that nothing is vendored. **Done.**
2. Otherwise fill the table under **Report**, one row per connection in the order given. Show a
   `null` field as `—`. Beneath the row of a connection whose `status` is `error`, quote its
   `error` verbatim.
3. Beneath the table, add one line per status word that appears, with its clause:
   - `up_to_date: the pinned commit is the branch's tip`
   - `behind: the branch's tip moved past the pinned commit`
   - `base_missing: the stored base is missing from the last commit or does not match the pinned commit`
   - `in_progress: an unfinished action is open on it`
   - `error: the connection could not be assessed`
4. This action only reports; start nothing else.

**Done.**

## Report
The list report, filled from `listed`; the parenthesized remarks are not printed:

```
| directory | status | pinned → upstream tip | upstream commits touching it | local modifications |
|---|---|---|---|---|
| <dir> | <status> | <pinned_sha> → <upstream_tip> | <commits_behind> | <local_modifications> |
  <error, verbatim — only beneath a row whose status is error>

<status word>: <its clause>        (one line per status word that appears)
```
