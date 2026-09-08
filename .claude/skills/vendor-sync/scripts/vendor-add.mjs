#!/usr/bin/env node
// vendor-add: vendor an upstream directory into this project (start, --continue, --abort).

import { existsSync, readdirSync, statSync } from "node:fs";
import {
  findVendoredDirs,
  finishAction,
  identityOf,
  loadManifest,
  manifestExists,
  markerWriter,
  normalizeLocalDir,
  requireCleanDir,
  requireNoInnerConnection,
  requireNoOpenAction,
  requireNoSymlink,
  requireNotNested,
  requireNothingStagedOutside,
  requireSlug,
  requireSlugUnused,
} from "./connection.mjs";
import { EXIT, fail, parseArgvOrFail, resumeMode, run, usageFailure } from "./contract.mjs";
import {
  committedPaths,
  deleteRef,
  EMPTY_TREE_OID,
  fetchTracking,
  gitlinkPaths,
  indexEntries,
  isAncestor,
  isWellFormedRev,
  listRemoteBranches,
  pathKind,
  readRef,
  requireNoGitOperation,
  requireRepository,
  resolveCommit,
  siblingListing,
  trackingRef,
  treeEntries,
  treeOid,
} from "./git.mjs";
import {
  abortOpenAction,
  describeChanges,
  noteIds,
  openForContinue,
  stageMerge,
} from "./merge.mjs";

const USAGE = [
  "usage: node scripts/vendor-add.mjs <repo> <path> <dir> [--ref <branch>] [--sha <commit>]",
  "       node scripts/vendor-add.mjs <dir> --continue",
  "       node scripts/vendor-add.mjs <dir> --abort",
].join("\n");

// ---- start ----

function startAdd(repo, path, dirArg, ref, shaFlag, root) {
  const { abs, rel, slug } = requireAddable(dirArg, root);
  try {
    fetchBranch(repo, ref, slug, root);
    const sha = pinnedCommit(shaFlag, ref, slug, root);
    requireUpstreamDirectory(sha, path, root);
    const skipped_submodules = gitlinkPaths(sha, path, root);
    const upstreamTree = treeOid(sha, path, root);
    const manifest = { slug, repo, path, ref, sha, base_tree: upstreamTree };
    const merge = {
      root,
      rel,
      abs,
      slug,
      action: "add",
      base: null,
      baseTree: EMPTY_TREE_OID,
      target: sha,
      upstreamTree,
      writeMarker: markerWriter(abs, manifest, "add", sha),
    };
    const start = { root, rel, manifest, merge, skipped_submodules };

    // Onto existing content: its state is known only now, after the fetch. A clean
    // directory with nothing committed (only ignored files or empty folders) counts as empty.
    const empty = !existsSync(abs) || readdirSync(abs).length === 0;
    if (!empty) requireCleanDir(rel, root);
    // Both branches write the index.
    requireNoGitOperation(root);
    if (empty || treeOid("HEAD", rel, root) === null) return startOntoEmpty(start);
    return startOntoContent(start);
  } catch (err) {
    // A failed add leaves no trace: the fetch's tracking ref goes again.
    deleteRef(trackingRef(slug), root);
    throw err;
  }
}

// The preconditions before the fetch, in the precondition order: `loadConnection`'s two directory
// checks with the symbolic-link check between them, so a link is named before anything is read through it.
// The tree is walked for connections once, for the inner-connection and the slug check.
function requireAddable(dirArg, root) {
  const { abs, rel } = normalizeLocalDir(dirArg, root);
  requireNoSymlink(rel, root);
  requireNotNested(rel, root);
  const connections = findVendoredDirs(root);
  requireNoInnerConnection(rel, connections, root);
  const slug = requireSlug(rel, root);
  if (manifestExists(abs)) {
    requireNoOpenAction(loadManifest(abs, rel), "add", rel);
    fail(EXIT.STOP, `already vendored: ${rel}`, { hint: "use sync to update it" });
  }
  requireSlugUnused(slug, rel, connections, root);
  requireNothingStagedOutside(rel, root);
  if (existsSync(abs) && !statSync(abs).isDirectory()) {
    fail(EXIT.STOP, `${rel} is not a directory`, { hint: "choose another directory" });
  }
  return { abs, rel, slug };
}

// The same merge against an empty local side: upstream's files, written and staged.
function startOntoEmpty({ root, rel, manifest, merge, skipped_submodules }) {
  const { sha, path } = manifest;
  const upstream = treeEntries(sha, path, root);
  stageMerge({ ...merge, localTree: EMPTY_TREE_OID, stagedState: "ready" });
  return {
    state: "ready",
    ...identityOf(rel, manifest),
    sha,
    files: upstreamFiles(upstream),
    skipped_submodules,
  };
}

function startOntoContent({ root, rel, manifest, merge, skipped_submodules }) {
  const { sha, path } = manifest;
  const files = describeChanges(null, treeEntries(sha, path, root), indexEntries(rel, root));
  stageMerge(merge);
  return {
    state: "merge_staged",
    ...identityOf(rel, manifest),
    base: null,
    sha,
    files,
    skipped_submodules,
    notes: noteIds(null),
  };
}

// The `files` of `ready`: the paths of upstream's blobs as `treeEntries` returns them, so
// without a root `.vendor.json`.
function upstreamFiles(upstream) {
  return [...upstream.keys()].sort();
}

function fetchBranch(repo, ref, slug, root) {
  try {
    fetchTracking(repo, ref, slug, root);
  } catch (err) {
    const branches = listRemoteBranches(repo, root);
    if (branches.length > 0 && !branches.includes(ref)) {
      fail(EXIT.FIX, `branch not found on the remote: ${ref}`, {
        data: { branches },
        gitStderr: err.gitStderr,
      });
    }
    throw err;
  }
}

function pinnedCommit(shaFlag, ref, slug, root) {
  if (shaFlag === undefined) return readRef(trackingRef(slug), root);
  if (!isWellFormedRev(shaFlag, root)) fail(EXIT.FIX, "not a well-formed revision");
  if (!isAncestor(shaFlag, trackingRef(slug), root)) {
    fail(EXIT.FIX, "sha is not an ancestor of the tracked branch");
  }
  const sha = resolveCommit(shaFlag, root);
  if (sha === null) fail(EXIT.FIX, "not a commit");
  return sha;
}

function requireUpstreamDirectory(sha, path, root) {
  const kind = pathKind(sha, path, root);
  if (kind === null) {
    fail(EXIT.FIX, `upstream path absent at ${sha}: ${path}`, {
      data: { entries: siblingListing(sha, path, root) },
    });
  }
  if (kind === "blob") fail(EXIT.FIX, "upstream path is a file, not a directory");
}

// ---- --continue ----

// Every state's files were written and staged at the start, so --continue checks and commits
// whatever <dir> holds now, and `files` is what that commit changed in <dir>.
function continueAdd(dirArg, root) {
  const { abs, rel, manifest, target } = openForContinue(dirArg, "add", root);
  const commit = finishAction({ root, rel, abs, manifest });
  const files = committedPaths(rel, root);
  return { state: "added", ...identityOf(rel, manifest), sha: target, commit, files };
}

run(() => {
  const { positionals, flags } = parseArgvOrFail(
    process.argv.slice(2),
    { value: ["ref", "sha"], bool: ["continue", "abort"] },
    USAGE,
  );
  const mode = resumeMode(positionals, flags, ["ref", "sha"], USAGE);
  if (mode === null && positionals.length !== 3) {
    usageFailure(USAGE)("expected <repo> <path> <dir>");
  }
  const root = requireRepository(process.cwd());
  if (mode === "continue") return continueAdd(positionals[0], root);
  if (mode === "abort") return abortOpenAction(positionals[0], root);
  const [repo, path, dir] = positionals;
  return startAdd(repo, path, dir, flags.ref ?? "main", flags.sha, root);
});
