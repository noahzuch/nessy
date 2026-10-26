// The merge layer: what each side changed, git's merge-tree output, and the plan an open
// action keeps in scratch.

import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ensureScratch,
  identityOf,
  loadConnection,
  MANIFEST_NAME,
  requireAnyMarker,
  requireMarker,
  requireNothingStagedForCommit,
  resetScratch,
  scratchDir,
  writeManifest,
} from "./connection.mjs";
import { EXIT, fail, HEX40, isPlainObject, ScriptError } from "./contract.mjs";
import {
  commitTree,
  deleteRef,
  diffTreeNames,
  gitOrFail,
  ignoresCase,
  indexEntries,
  literal,
  literalExclude,
  mergeTree,
  nulRecords,
  prefixedTree,
  requireNoGitOperation,
  restoreTree,
  setRef,
  trackingRef,
  treeOid,
  unmergedFiles,
  untrackedFiles,
  updateIndexInfo,
} from "./git.mjs";

export const MERGE_REFS = Object.freeze({
  base: "refs/vendor-base",
  local: "refs/vendor-local",
  upstream: "refs/vendor-upstream",
});
export const PLAN_NAME = "plan.json";
export const PLAN_VERSION = 1;

const STAGE_LINE = /^\d{6} [0-9a-f]{40} [123]\t.+$/s;
const ACTIONS = ["add", "sync"];

// Plain byte comparison of the UTF-8 `path`, never a locale's collation: JS `<` compares
// UTF-16 code units, which order a character above U+FFFF before one in U+E000-U+FFFF.
function byPath(a, b) {
  return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
}

// ---- the change description ----

// Two entries are the same file when blob and mode agree: an executable bit that upstream
// alone flipped is a change the merge must carry.
function same(x, y) {
  return x.oid === y.oid && x.mode === y.mode;
}

export function describeChanges(base, upstream, local) {
  const files =
    base === null ? describeNoBase(upstream, local) : describeWithBase(base, upstream, local);
  return files.sort(byPath);
}

function describeWithBase(base, upstream, local) {
  const files = [];
  const paths = new Set([...base.keys(), ...upstream.keys()]);
  for (const path of paths) {
    if (path === MANIFEST_NAME) continue;
    const b = base.get(path);
    const u = upstream.get(path);
    const l = local.get(path);
    let upstream_changes;
    let local_changes;
    if (b && u) {
      if (same(b, u)) continue;
      upstream_changes = "modified";
      local_changes = !l ? "deleted" : same(l, b) ? "unchanged" : "modified";
    } else if (u) {
      if (l && same(l, u)) continue;
      upstream_changes = "added";
      local_changes = l ? "modified" : "absent";
    } else {
      if (!l) continue;
      upstream_changes = "deleted";
      local_changes = same(l, b) ? "unchanged" : "modified";
    }
    files.push({ path, upstream_changes, local_changes });
  }
  return files;
}

function describeNoBase(upstream, local) {
  const files = [];
  for (const [path, u] of upstream) {
    if (path === MANIFEST_NAME) continue;
    const l = local.get(path);
    if (l && same(l, u)) continue;
    files.push({ path, presence: l ? "both" : "upstream" });
  }
  return files;
}

export function noteIds(base) {
  return base === null ? ["no_base"] : [];
}

// ---- merge-tree output ----

// The output is split on the NUL byte and each record decoded on its own: decoding the
// whole output as text would lose the record boundaries and with them the conflicts.
export function parseMergeTreeOutput(stdout) {
  const [tree, ...rest] = nulRecords(stdout);
  if (!HEX40.test(tree ?? "")) fail(EXIT.STOP, `unexpected merge-tree output: ${tree}`);
  const end = rest.indexOf("");
  const stageLines = end === -1 ? rest : rest.slice(0, end);
  const messages = end === -1 ? [] : rest.slice(end + 1).filter((r) => r !== "");
  for (const line of stageLines) {
    if (!STAGE_LINE.test(line)) fail(EXIT.STOP, `unexpected merge-tree stage line: ${line}`);
  }
  return { tree, stageLines, messages };
}

// ---- the merge ----

const STAGE_ZERO_REMOVAL = `0 ${"0".repeat(40)}\t`;

// One git merge over the prefixed base, local and upstream trees, turned into the plan, the
// working tree and the index, in the order plan, marker `merging`, files, marker `stagedState`.
// The local side is `<rel>` at HEAD unless `localTree` says otherwise: the `ready` start of an
// add passes the empty tree, so the merge writes upstream's files as they are.
export function stageMerge({
  root,
  rel,
  abs,
  slug,
  action,
  base,
  baseTree,
  target,
  upstreamTree,
  writeMarker,
  localTree = treeOid("HEAD", rel, root),
  stagedState = "merge_staged",
}) {
  // Prefix, Name, Merge, Unname
  const { localP, stdout } = mergeSides(baseTree, localTree, upstreamTree, rel, root);
  // Parse
  const { tree: merged, stageLines } = parseMergeTreeOutput(stdout);
  const stagesByPath = groupStagesByPath(stageLines);
  // Plan
  const touched = touchedEntries(localP, merged, stagesByPath, rel, root);
  requireNoCollisions(
    rel,
    abs,
    touched.filter((t) => t.local_oid === null).map((t) => t.path),
    new Set(touched.filter((t) => t.local_oid !== null).map((t) => t.path)),
    root,
  );
  writePlan(ensureScratch(root, slug), {
    version: PLAN_VERSION,
    action,
    base,
    target,
    touched,
  });
  // Open
  writeMarker("merging");
  // Materialize
  materialize(merged, touched, rel, root);
  // Conflicts
  writeConflictStages(stagesByPath, root);
  // Staged
  writeMarker(stagedState);
}

// Prefix, Name, Merge, Unname: every path in the merge is already a repository path, and the
// refs label the conflict markers and never outlive the merge.
function mergeSides(baseTree, localTree, upstreamTree, rel, root) {
  const baseP = prefixedTree(baseTree, rel, root, { omitManifest: true });
  const localP = prefixedTree(localTree, rel, root, { keepGitlinks: true });
  const upstreamP = prefixedTree(upstreamTree, rel, root, { omitManifest: true });
  try {
    setRef(MERGE_REFS.base, commitTree(baseP, root), root);
    setRef(MERGE_REFS.local, commitTree(localP, root), root);
    setRef(MERGE_REFS.upstream, commitTree(upstreamP, root), root);
    const { stdout } = mergeTree("vendor-base", "vendor-local", "vendor-upstream", root);
    return { localP, stdout };
  } finally {
    for (const ref of Object.values(MERGE_REFS)) deleteRef(ref, root);
  }
}

function groupStagesByPath(stageLines) {
  const stagesByPath = new Map();
  for (const line of stageLines) {
    const path = line.slice(line.indexOf("\t") + 1);
    if (!stagesByPath.has(path)) stagesByPath.set(path, []);
    stagesByPath.get(path).push(line);
  }
  return stagesByPath;
}

// Every path the merge writes, as `{ path, local_oid }` with its pre-merge blob.
function touchedEntries(localP, merged, stagesByPath, rel, root) {
  const repoPaths = new Set([...diffTreeNames(localP, merged, root), ...stagesByPath.keys()]);
  const local = indexEntries(rel, root);
  return [...repoPaths]
    .map((repoPath) => repoPath.slice(rel.length + 1))
    .filter((path) => path !== MANIFEST_NAME)
    .map((path) => ({ path, local_oid: local.get(path)?.oid ?? null }))
    .sort(byPath);
}

// The manifest is excluded so the `merging` marker survives.
function materialize(merged, touched, rel, root) {
  restoreTree(merged, [literal(rel), literalExclude(`${rel}/${MANIFEST_NAME}`)], root);
  rewriteCaseTwins(touched, rel, root);
}

// Without the stage-0 removal line git would show a plain modification.
function writeConflictStages(stagesByPath, root) {
  const lines = [];
  for (const [path, stages] of stagesByPath) lines.push(STAGE_ZERO_REMOVAL + path, ...stages);
  updateIndexInfo(lines, root);
}

// Paths that differ only in case (a case-only rename) are one file on a case-insensitive
// filesystem, and git restore may delete it after writing it, so those are checked out from
// the index once more.
function rewriteCaseTwins(touched, rel, root) {
  const byLower = new Map();
  for (const { path } of touched) {
    const key = path.toLowerCase();
    byLower.set(key, [...(byLower.get(key) ?? []), path]);
  }
  const twins = [...byLower.values()].filter((group) => group.length > 1).flat();
  if (twins.length === 0) return;
  const index = indexEntries(rel, root);
  const present = twins.filter((path) => index.has(path));
  if (present.length === 0) return;
  gitOrFail(
    ["checkout-index", "-f", "--", ...present.map((path) => `${rel}/${path}`)],
    `cannot write ${present.join(", ")}`,
    root,
  );
}

// Nothing may already sit at a path an action creates under <rel>: git restore overwrites it
// without a word, and --abort would then clean it away. `paths` are the paths the action
// creates (relative to <rel>); `tracked` holds the paths tracked at HEAD that the action
// replaces, which the clean tree guarantees equal HEAD. A path collides with an on-disk entry
// whose name matches it, and with a non-directory on its parent chain, unless that entry is
// tracked. When git ignores case (core.ignorecase), names match up to case, as the filesystem
// would write through them, and an entry that matches a tracked path up to case is tracked.
// A directory that holds tracked paths (upstream replaced it with a file) is no collision
// itself, but every untracked or ignored entry inside it is: git restore deletes those with it.
export function requireNoCollisions(rel, abs, paths, tracked, root) {
  const fold = ignoresCase(root) ? (name) => name.toLowerCase() : (name) => name;
  const trackedFolded = new Set([...tracked].map(fold));
  const isTracked = (path) => trackedFolded.has(fold(path));
  const holdsTracked = (dir) => [...trackedFolded].some((t) => t.startsWith(fold(dir) + "/"));
  const onDisk = entriesMatching(abs, fold);
  const collisions = new Set();
  for (const path of paths) {
    for (const entry of onDisk(path)) {
      if (isTracked(entry.path)) continue;
      if (!entry.dir || !holdsTracked(entry.path)) {
        collisions.add(entry.path);
        continue;
      }
      for (const inner of filesUnder(abs, entry.path)) {
        if (!isTracked(inner)) collisions.add(inner);
      }
    }
    for (let d = dirname(path); d !== "."; d = dirname(d)) {
      for (const entry of onDisk(d)) {
        if (!entry.dir && !isTracked(entry.path)) collisions.add(entry.path);
      }
    }
  }
  if (collisions.size > 0) {
    fail(
      EXIT.STOP,
      `${rel} holds files upstream would overwrite: ${[...collisions].sort().join(", ")}`,
      { hint: `move them out of ${rel}, then re-run` },
    );
  }
}

// path -> the entries under `abs` whose every segment matches it once `fold`ed, with their
// names as they are on disk. Listings are read once per directory.
function entriesMatching(abs, fold) {
  const listings = new Map();
  const listing = (dir) => {
    if (!listings.has(dir)) listings.set(dir, readdirOrEmpty(join(abs, dir)));
    return listings.get(dir);
  };
  const memo = new Map([[".", [{ path: ".", dir: true }]]]);
  const match = (path) => {
    if (memo.has(path)) return memo.get(path);
    const name = fold(basename(path));
    const found = [];
    for (const parent of match(dirname(path))) {
      if (!parent.dir) continue;
      for (const e of listing(parent.path)) {
        if (fold(e.name) !== name) continue;
        const actual = parent.path === "." ? e.name : `${parent.path}/${e.name}`;
        found.push({ path: actual, dir: e.isDirectory() });
      }
    }
    memo.set(path, found);
    return found;
  };
  return match;
}

// Every non-directory entry beneath `dir` (relative to `abs`), as paths relative to `abs`.
function filesUnder(abs, dir) {
  const out = [];
  for (const e of readdirOrEmpty(join(abs, dir))) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...filesUnder(abs, path));
    else out.push(path);
  }
  return out;
}

function readdirOrEmpty(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
    throw err;
  }
}

// ---- the plan ----

export function writePlan(scratch, plan) {
  writeFileSync(join(scratch, PLAN_NAME), JSON.stringify(plan, null, 2) + "\n");
}

export function readPlan(scratch) {
  const path = join(scratch, PLAN_NAME);
  let plan;
  try {
    plan = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    plan = undefined;
  }
  if (!validPlan(plan)) fail(EXIT.STOP, `scratch is missing: ${path}`);
  return plan;
}

function validTouched(list) {
  return (
    Array.isArray(list) &&
    list.every(
      (entry) =>
        isPlainObject(entry) &&
        typeof entry.path === "string" &&
        (entry.local_oid === null || typeof entry.local_oid === "string"),
    )
  );
}

function validPlan(plan) {
  return (
    isPlainObject(plan) &&
    plan.version === PLAN_VERSION &&
    ACTIONS.includes(plan.action) &&
    (plan.base === null || (typeof plan.base === "string" && HEX40.test(plan.base))) &&
    typeof plan.target === "string" &&
    HEX40.test(plan.target) &&
    validTouched(plan.touched)
  );
}

// Every state but `pin_ready` wrote files at its start and keeps their plan in scratch.
function hasPlan(marker) {
  return marker.state !== "pin_ready";
}

// --continue in any state: no file in <rel> unmerged, then, for a state with a plan, the plan
// for the marker's target, which this returns; null for `pin_ready`.
export function requireResolvedPlan({ root, rel, manifest, marker }) {
  const unresolved = unmergedFiles(rel, root);
  if (unresolved.length > 0) {
    fail(EXIT.FIX, `${unresolved.length} files in ${rel} are still unmerged`, {
      data: { unresolved },
    });
  }
  if (!hasPlan(marker)) return null;
  const plan = readPlan(scratchDir(root, manifest.slug));
  const target = marker.target_sha;
  if (plan.target !== target) {
    fail(
      EXIT.STOP,
      `plan.json targets ${plan.target}, but the open ${marker.action} targets ${target}`,
      { hint: "discard it with --abort" },
    );
  }
  return plan;
}

// ---- the abort ----

// Puts back exactly the plan's `touched` paths; every command names those paths and no others.
export function abortMerge({ root, rel, plan }) {
  const full = (t) => literal(`${rel}/${t.path}`);
  const all = plan.touched.map(full);
  const existing = plan.touched.filter((t) => t.local_oid !== null);
  const created = plan.touched.filter((t) => t.local_oid === null);
  if (all.length) gitOrFail(["reset", "-q", "--", ...all], "cannot unstage the merge", root);
  // A created path that differs from a restored one only in case may be that same file on
  // disk, under the created name; git checkout would keep that name, so it goes first.
  const restoredLower = new Set(existing.map((t) => t.path.toLowerCase()));
  for (const t of created) {
    if (!restoredLower.has(t.path.toLowerCase())) continue;
    try {
      rmSync(join(root, rel, t.path), { force: true });
    } catch {
      // not a file: git checkout and git clean deal with it as before
    }
  }
  if (existing.length) {
    gitOrFail(["checkout", "--", ...existing.map(full)], "cannot restore the merged files", root);
  }
  if (created.length) {
    gitOrFail(
      ["clean", "-fxq", "--", ...created.map(full)],
      "cannot remove the created files",
      root,
    );
    removeEmptiedDirs(created, rel, root);
  }
  return {
    restored: existing.map((t) => t.path).sort(),
    removed: created.map((t) => t.path).sort(),
    left: leftovers({ root, rel, touched: plan.touched }),
  };
}

// git clean removes a created file but not the folders written for it. Each folder on a created
// path's parent chain goes once it is empty, deepest first so a parent is empty once its
// children are gone; one that holds anything else stays. Best effort: a failure keeps it.
function removeEmptiedDirs(created, rel, root) {
  const dirs = new Set();
  for (const t of created) {
    for (let d = dirname(t.path); d !== "."; d = dirname(d)) dirs.add(d);
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(join(root, rel, dir));
    } catch {
      // not empty, not a directory, or already gone: keep it
    }
  }
}

// The untracked files under <dir> no script wrote: reported, never removed.
export function leftovers({ root, rel, touched }) {
  const written = new Set(touched.map((t) => t.path));
  return untrackedFiles(rel, root).filter((path) => path !== MANIFEST_NAME && !written.has(path));
}

// The whole of --abort, for an open add or sync alike.
export function abortAction({ root, rel, abs, manifest }) {
  const marker = requireAnyMarker(manifest, rel);
  const { slug } = manifest;
  let result;
  if (hasPlan(marker)) {
    result = abortMerge({ root, rel, plan: readPlanForAbort(root, rel, slug) });
  } else {
    result = { restored: [], removed: [], left: leftovers({ root, rel, touched: [] }) };
  }
  if (marker.action === "sync") {
    // The sync did not create the manifest, so `sha` stays where it was.
    writeManifest(abs, { ...manifest, in_progress: null });
  } else {
    // A discarded add leaves the same trace as one that never ran.
    rmSync(join(abs, MANIFEST_NAME), { force: true });
    if (existsSync(abs) && readdirSync(abs).length === 0) rmdirSync(abs);
    deleteRef(trackingRef(slug), root);
  }
  resetScratch(root, slug);
  return result;
}

// The checks of --continue, for either action and every state, in their order: the open
// `action`, no git operation, nothing unmerged and the plan, nothing staged outside the tool's
// paths. Returns the connection with its marker, the marker's target and the plan (null for
// `pin_ready`).
export function openForContinue(dirArg, action, root) {
  const { abs, rel, manifest } = loadConnection(dirArg, root);
  const marker = requireMarker(manifest, action, rel);
  requireNoGitOperation(root);
  const plan = requireResolvedPlan({ root, rel, manifest, marker });
  requireNothingStagedForCommit(rel, manifest.slug, root);
  return { root, abs, rel, manifest, marker, target: marker.target_sha, plan };
}

// --abort of either script: whatever action is open on <dir>.
export function abortOpenAction(dirArg, root) {
  const { abs, rel, manifest } = loadConnection(dirArg, root);
  const { restored, removed, left } = abortAction({ root, rel, abs, manifest });
  return { state: "aborted", ...identityOf(rel, manifest), restored, removed, left };
}

// Without the plan the scripts cannot tell which paths they wrote, so the recovery is the
// user's: the hint restores tracked files only and never deletes an untracked one.
function readPlanForAbort(root, rel, slug) {
  try {
    return readPlan(scratchDir(root, slug));
  } catch (err) {
    if (!(err instanceof ScriptError)) throw err;
    fail(EXIT.STOP, err.message, {
      hint:
        `\`git restore --source=HEAD --staged --worktree -- ${rel}\` puts every tracked file back; ` +
        `review the untracked files \`git status -- ${rel}\` then lists before deleting any — ` +
        "only the plan knew which of them the merge created.",
    });
  }
}
