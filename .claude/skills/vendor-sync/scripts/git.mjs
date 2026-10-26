// The git layer: every git command the scripts run goes through this module.
//
// `git` and `gitBuffer` never throw; `gitOrFail` and the helpers that need a result
// turn a failure into a `ScriptError` carrying git's stderr. Text output goes through
// `git`; file bytes and every `-z` output go through `gitBuffer`, because a string
// decode would corrupt bytes and drop NULs.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import { EXIT, fail } from "./contract.mjs";

export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// `merge-tree --merge-base` needs git 2.40.
export const MIN_GIT_VERSION = "2.40.0";
// Must equal connection.mjs's MANIFEST_NAME, which this module cannot import.
const MANIFEST_FILE = ".vendor.json";

// ---- processes ----

export function git(args, root, { env } = {}) {
  const res = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  const raw = res.stdout ?? "";
  return { status: res.status ?? -1, stdout: raw.trim(), raw, stderr: res.stderr ?? "" };
}

export function gitBuffer(args, root, { input, env } = {}) {
  const res = spawnSync("git", args, {
    cwd: root,
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: res.stderr ? res.stderr.toString("utf8") : "",
  };
}

// A pathspec that matches exactly `path`: without the magic, git reads `[`, `*` and `?` as
// glob characters.
export function literal(path) {
  return `:(literal)${path}`;
}

export function literalExclude(path) {
  return `:(exclude,literal)${path}`;
}

export function gitOrFail(args, message, root, { env } = {}) {
  const res = git(args, root, { env });
  if (res.status !== 0) fail(EXIT.STOP, message, { gitStderr: res.stderr });
  return res;
}

// A query whose exit 1 is an answer (`rev-parse --verify -q`: absent; `config --get`: unset);
// any other non-zero status, such as 128 for a fatal error, fails 2.
function gitQuery(args, message, root) {
  const res = git(args, root);
  if (res.status !== 0 && res.status !== 1) fail(EXIT.STOP, message, { gitStderr: res.stderr });
  return res;
}

// `rev-parse --verify -q <spec>`: the oid, or null when absent (exit 1).
function verifyOrNull(spec, message, root) {
  const res = gitQuery(["rev-parse", "--verify", "-q", spec], message, root);
  return res.status === 0 ? res.stdout : null;
}

// ---- repository ----

function tempIndexPath(root) {
  return join(gitDir(root), `vendor-sync-index-${process.pid}-${Date.now()}`);
}

export function repoRoot(cwd) {
  const res = git(["rev-parse", "--show-toplevel"], cwd);
  if (res.status !== 0) {
    fail(EXIT.STOP, "not inside a git repository", { gitStderr: res.stderr });
  }
  return realpathSync(res.stdout);
}

export function gitDir(root) {
  return gitOrFail(["rev-parse", "--absolute-git-dir"], "cannot locate the git directory", root)
    .stdout;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function requireGitVersion(root) {
  const out = git(["--version"], root).stdout;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  const min = MIN_GIT_VERSION.split(".").map(Number);
  if (m && compareVersions([m[1], m[2], m[3]].map(Number), min) >= 0) return;
  const found = m ? m[0] : out || "unknown";
  fail(EXIT.STOP, `vendor-sync needs git ${MIN_GIT_VERSION} or newer; found ${found}`, {
    hint: "upgrade git, then re-run",
  });
}

// The repository around `cwd`, on a git new enough for the scripts.
export function requireRepository(cwd) {
  const root = repoRoot(cwd);
  requireGitVersion(root);
  return root;
}

const GIT_OPERATIONS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

export function requireNoGitOperation(root) {
  const dir = gitDir(root);
  for (const name of GIT_OPERATIONS) {
    if (existsSync(join(dir, name))) {
      fail(EXIT.STOP, `another git operation is in progress: ${name}`, {
        hint: "finish or abort it, then re-run",
      });
    }
  }
}

// Whether git treats names that differ only in case as one file (set by `git init` on a
// case-insensitive filesystem).
export function ignoresCase(root) {
  const args = ["config", "--get", "--type=bool", "core.ignorecase"];
  return gitQuery(args, "cannot read core.ignorecase", root).stdout === "true";
}

// The repository-relative paths under `rel` that `git status` reports — staged, unstaged and
// untracked, whatever `status.showUntrackedFiles` says; ignored files do not count. Sorted;
// empty means clean. `--no-renames` gives a rename as its two paths, one record each.
export function uncommittedPaths(rel, root) {
  const args = ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"];
  const res = gitBuffer([...args, "--", literal(rel)], root);
  if (res.status !== 0) fail(EXIT.STOP, "git status failed", { gitStderr: res.stderr });
  return nulRecords(res.stdout)
    .map((record) => record.slice(3))
    .sort();
}

// Repository-relative paths that differ between HEAD (the empty tree on an unborn HEAD) and
// the index. `--ignore-submodules=none`: a config that ignores submodules would hide a staged
// gitlink, which a commit of the index still records.
export function stagedPaths(root) {
  const res = gitBuffer(
    ["diff", "--cached", "--name-only", "-z", "--no-renames", "--ignore-submodules=none"],
    root,
  );
  if (res.status !== 0) fail(EXIT.STOP, "cannot list the staged paths", { gitStderr: res.stderr });
  return nulRecords(res.stdout).sort();
}

// ---- refs ----

export function trackingRef(slug) {
  return `refs/vendor/${slug}`;
}

export function readRef(ref, root) {
  return verifyOrNull(ref, `cannot read ${ref}`, root);
}

export function setRef(ref, oid, root) {
  gitOrFail(["update-ref", ref, oid], `cannot set ${ref}`, root);
}

export function deleteRef(ref, root) {
  git(["update-ref", "-d", ref], root);
}

// ---- remote ----

export function fetchTracking(repo, ref, slug, root) {
  const res = git(["fetch", "--no-tags", repo, `+refs/heads/${ref}:${trackingRef(slug)}`], root);
  if (res.status !== 0) {
    fail(EXIT.STOP, `fetch failed: repo=${repo} ref=${ref}`, { gitStderr: res.stderr });
  }
}

export function listRemoteBranches(repo, root) {
  const res = git(["ls-remote", "--heads", repo], root);
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.split("\t")[1])
    .filter((name) => name?.startsWith("refs/heads/"))
    .map((name) => name.slice("refs/heads/".length))
    .sort();
}

// ---- commits ----

export function commitExists(sha, root) {
  return resolveCommit(sha, root) !== null;
}

export function resolveCommit(rev, root) {
  const spec = `${rev}^{commit}`;
  return verifyOrNull(spec, `cannot resolve ${spec}`, root);
}

// `rev` is the user's input, read right after a successful fetch, so any non-zero status
// (`HEAD@{99}` exits 128) means the input is not well-formed.
export function isWellFormedRev(rev, root) {
  return git(["rev-parse", "--verify", "-q", rev], root).status === 0;
}

// git exits 128 both for a commit missing from the object store and for a real failure. The
// first is an answer, `false`: after upstream rewrites its history the pinned commit is gone.
export function isAncestor(sha, ref, root) {
  const res = git(["merge-base", "--is-ancestor", sha, ref], root);
  if (res.status === 0 || res.status === 1) return res.status === 0;
  if (!commitExists(sha, root)) return false;
  fail(EXIT.STOP, `cannot tell whether ${sha} is an ancestor of ${ref}`, {
    gitStderr: res.stderr,
  });
}

export function commitsBehind(sha, tip, path, root) {
  const res = gitOrFail(
    ["rev-list", "--count", `${sha}..${tip}`, "--", literal(path)],
    `cannot count the commits from ${sha} to ${tip}`,
    root,
  );
  return Number(res.stdout);
}

// ---- paths in a commit ----

// `path` is the user's input, read right after a successful fetch, so any non-zero status of
// the first rev-parse (`../x` exits 128) means the path does not resolve.
export function pathKind(rev, path, root) {
  const spec = `${rev}:${path}`;
  const oid = git(["rev-parse", "--verify", "-q", spec], root);
  if (oid.status !== 0) return null;
  const res = git(["cat-file", "-t", oid.stdout], root);
  if (res.status === 0) return res.stdout === "tree" || res.stdout === "blob" ? res.stdout : null;
  // A submodule entry names a commit the store lacks; it is neither a tree nor a blob.
  const entry = gitBuffer(["ls-tree", "-z", rev, "--", literal(path)], root);
  if (entry.status === 0 && entry.stdout.toString("utf8").startsWith("160000 ")) return null;
  fail(EXIT.STOP, `cannot read the type of ${spec}`, { gitStderr: res.stderr });
}

export function siblingListing(rev, path, root) {
  const parent = posix.dirname(path);
  const spec = parent === "." ? `${rev}:` : `${rev}:${parent}`;
  return lsTreeNames(["ls-tree", "-z", "--name-only", spec], root);
}

export function treeOid(rev, path, root) {
  const spec = treeSpec(rev, path);
  return verifyOrNull(spec, `cannot resolve ${spec}`, root);
}

// The tree at `path` in `rev`; `path` "" is the whole tree.
function treeSpec(rev, path) {
  return path === "" ? `${rev}^{tree}` : `${rev}:${path}`;
}

// `-z` gives exact names; without it git C-quotes unusual ones.
function lsTreeNames(args, root) {
  const res = gitBuffer(args, root);
  if (res.status !== 0) return [];
  return nulRecords(res.stdout).filter((name) => name !== "");
}

// Splits a `-z` Buffer on NUL and decodes each record on its own; empty records in the middle
// stay, the trailing empty record is dropped.
export function nulRecords(buf) {
  const out = [];
  let start = 0;
  for (let i = buf.indexOf(0, start); i !== -1; i = buf.indexOf(0, start)) {
    out.push(buf.subarray(start, i).toString("utf8"));
    start = i + 1;
  }
  if (start < buf.length) out.push(buf.subarray(start).toString("utf8"));
  return out;
}

function stripRel(path, rel) {
  return path.startsWith(rel + "/") ? path.slice(rel.length + 1) : path;
}

// ---- trees ----

const LS_TREE_RECORD = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/s;

// `git ls-tree -r -z <spec>` as records; a non-zero status fails 2 with `message`.
function lsTreeRecords(spec, message, root) {
  const res = gitBuffer(["ls-tree", "-r", "-z", spec], root);
  if (res.status !== 0) fail(EXIT.STOP, message, { gitStderr: res.stderr });
  const out = [];
  for (const record of nulRecords(res.stdout)) {
    const m = LS_TREE_RECORD.exec(record);
    if (m) out.push({ mode: m[1], type: m[2], oid: m[3], file: m[4] });
  }
  return out;
}

// The message names the tree, not upstream: callers also read HEAD and the stored base, and
// one that must report a missing upstream path checks for it first.
export function treeEntries(rev, path, root) {
  const spec = treeSpec(rev, path);
  const entries = new Map();
  for (const { mode, type, oid, file } of lsTreeRecords(
    spec,
    `cannot list the tree ${spec}`,
    root,
  )) {
    if (type !== "blob" || file === MANIFEST_FILE) continue;
    entries.set(file, { mode, oid });
  }
  return entries;
}

// The submodule entries (gitlinks) under `path`, relative to it and byte-sorted: what
// treeEntries and prefixedTree leave out.
export function gitlinkPaths(rev, path, root) {
  return lsTreeRecords(treeSpec(rev, path), "git ls-tree failed", root)
    .filter(({ mode }) => mode === GITLINK_MODE)
    .map(({ file }) => file)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

// `read-tree --prefix` into the real index fails when `prefix` is tracked, so the tree is
// assembled in a temporary index file; one that does not exist yet starts empty. `rm -f`:
// without it git refuses when the working tree's manifest differs from the temporary entry.
// Submodule entries (gitlinks) are dropped, as treeEntries drops them: neither the merge nor
// the stored base can write one, and a commit cannot take one without its checkout.
// `keepGitlinks` is for the local side: a gitlink the user tracks inside <dir> stays in HEAD.
export function prefixedTree(
  tree,
  prefix,
  root,
  { omitManifest = false, keepGitlinks = false } = {},
) {
  const index = tempIndexPath(root);
  const env = { GIT_INDEX_FILE: index };
  try {
    gitOrFail(["read-tree", `--prefix=${prefix}/`, tree], `cannot read tree ${tree}`, root, {
      env,
    });
    const drop = keepGitlinks
      ? []
      : indexRecords(["ls-files", "-s", "-z"], root, { env })
          .filter(({ mode }) => mode === GITLINK_MODE)
          .map(({ path }) => literal(path));
    if (omitManifest) drop.push(literal(`${prefix}/${MANIFEST_FILE}`));
    if (drop.length > 0) {
      gitOrFail(
        ["rm", "--cached", "-f", "-q", "--ignore-unmatch", "--", ...drop],
        "cannot drop the manifest and submodule entries",
        root,
        { env },
      );
    }
    return gitOrFail(["write-tree"], "cannot write tree", root, { env }).stdout;
  } finally {
    rmSync(index, { force: true });
  }
}

export function commitTree(tree, root) {
  return gitOrFail(
    ["commit-tree", tree, "-m", "vendor-sync merge side"],
    `cannot commit tree ${tree}`,
    root,
  ).stdout;
}

// The output stays bytes: a text decode would drop the NULs that separate the stage records.
export function mergeTree(base, local, upstream, root) {
  const res = gitBuffer(
    [
      "-c",
      "merge.conflictStyle=zdiff3",
      "merge-tree",
      "--write-tree",
      "-z",
      `--merge-base=${base}`,
      local,
      upstream,
    ],
    root,
  );
  if (res.status === 0) return { conflicted: false, stdout: res.stdout };
  if (res.status === 1) return { conflicted: true, stdout: res.stdout };
  fail(EXIT.STOP, "git merge-tree failed", { gitStderr: res.stderr });
}

export function diffTreeNames(treeA, treeB, root) {
  const res = gitBuffer(
    ["diff-tree", "-r", "--name-only", "--no-renames", "-z", treeA, treeB],
    root,
  );
  if (res.status !== 0) {
    fail(EXIT.STOP, `cannot compare ${treeA} with ${treeB}`, { gitStderr: res.stderr });
  }
  return nulRecords(res.stdout).sort();
}

// The paths under `rel` that the commit at HEAD changed (against the empty tree for a root
// commit), relative to `rel`, without its `.vendor.json`, byte-sorted.
export function committedPaths(rel, root) {
  const res = gitBuffer(
    [
      "diff-tree",
      "--no-commit-id",
      "--root",
      "-r",
      "--name-only",
      "--no-renames",
      "-z",
      "HEAD",
      "--",
      literal(rel),
    ],
    root,
  );
  if (res.status !== 0) {
    fail(EXIT.STOP, `cannot list the paths HEAD changed in ${rel}`, { gitStderr: res.stderr });
  }
  return nulRecords(res.stdout)
    .map((path) => stripRel(path, rel))
    .filter((path) => path !== MANIFEST_FILE)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

// ---- working tree and commits ----

// On a case-insensitive filesystem git restore deletes a file it just wrote when the old
// name differs only in case (a case-only rename), so every file the index holds but the
// working tree lacks afterwards is written once more from the index.
export function restoreTree(tree, pathspecs, root) {
  const what = `cannot restore ${pathspecs.join(" ")} from ${tree}`;
  gitOrFail(
    ["restore", `--source=${tree}`, "--staged", "--worktree", "--", ...pathspecs],
    what,
    root,
  );
  const missing = gitBuffer(["ls-files", "-d", "-z", "--", ...pathspecs], root);
  if (missing.status !== 0) fail(EXIT.STOP, what, { gitStderr: missing.stderr });
  const paths = nulRecords(missing.stdout);
  if (paths.length > 0) gitOrFail(["checkout-index", "-f", "--", ...paths], what, root);
}

// Commits the real index, which by then holds only the tool's paths: the callers refuse to
// run while anything else is staged. `add -u` first stages every unstaged edit to a tracked
// file under `rel`; untracked files stay out. Hooks and signing run as for any commit.
export function commitIndex(message, rel, root) {
  gitOrFail(["add", "-u", "--", literal(rel)], "cannot stage the edits to commit", root);
  const res = git(["commit", "-q", "-m", message], root);
  if (res.status !== 0) {
    // Hooks may print to stdout, so both streams go to the user.
    fail(EXIT.FIX, "the commit failed; the action is still open", {
      gitStderr: res.stderr + res.raw,
    });
  }
  return readRef("HEAD", root);
}

// `tree` must already be prefixed with `rel`. Untracked files are not seen.
export function worktreeDiffers(tree, rel, root) {
  const res = git(
    ["diff", "--quiet", tree, "--", literal(rel), literalExclude(`${rel}/${MANIFEST_FILE}`)],
    root,
  );
  if (res.status === 0) return false;
  if (res.status === 1) return true;
  fail(EXIT.STOP, `cannot compare ${rel} with ${tree}`, { gitStderr: res.stderr });
}

export function untrackedFiles(rel, root) {
  const res = gitBuffer(["ls-files", "-o", "--exclude-standard", "-z", "--", literal(rel)], root);
  if (res.status !== 0) fail(EXIT.STOP, "git ls-files failed", { gitStderr: res.stderr });
  return nulRecords(res.stdout)
    .map((path) => stripRel(path, rel))
    .sort();
}

// ---- index ----

const INDEX_RECORD = /^(\d{6}) ([0-9a-f]{40}) (\d)\t(.*)$/s;
const GITLINK_MODE = "160000";

function indexRecords(args, root, { env } = {}) {
  const res = gitBuffer(args, root, { env });
  if (res.status !== 0) fail(EXIT.STOP, "git ls-files failed", { gitStderr: res.stderr });
  const out = [];
  for (const record of nulRecords(res.stdout)) {
    const m = INDEX_RECORD.exec(record);
    if (m) out.push({ mode: m[1], oid: m[2], stage: Number(m[3]), path: m[4] });
  }
  return out;
}

export function indexEntries(rel, root) {
  const entries = new Map();
  for (const { mode, oid, stage, path } of indexRecords(
    ["ls-files", "-s", "-z", "--", literal(rel)],
    root,
  )) {
    const file = stripRel(path, rel);
    if (stage !== 0 || file === MANIFEST_FILE) continue;
    entries.set(file, { mode, oid });
  }
  return entries;
}

export function unmergedFiles(rel, root) {
  const paths = indexRecords(["ls-files", "-u", "-z", "--", literal(rel)], root).map(({ path }) =>
    stripRel(path, rel),
  );
  return [...new Set(paths)].sort();
}

export function updateIndexInfo(lines, root) {
  if (lines.length === 0) return;
  const res = gitBuffer(["update-index", "--index-info"], root, { input: lines.join("\n") + "\n" });
  if (res.status !== 0) fail(EXIT.STOP, "cannot update the index", { gitStderr: res.stderr });
}
