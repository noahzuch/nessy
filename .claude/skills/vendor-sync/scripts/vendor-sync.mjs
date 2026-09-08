#!/usr/bin/env node
// vendor-sync: update a vendored directory to the tip of its upstream branch (start, --continue,
// --abort).

import {
  finishAction,
  identityOf,
  loadConnection,
  markerWriter,
  requireBaseIntact,
  requireCleanDir,
  requireNoOpenAction,
  requireNothingStagedOutside,
} from "./connection.mjs";
import { EXIT, fail, parseArgvOrFail, resumeMode, run, usageFailure } from "./contract.mjs";
import {
  commitExists,
  committedPaths,
  commitsBehind,
  EMPTY_TREE_OID,
  fetchTracking,
  gitlinkPaths,
  indexEntries,
  isAncestor,
  readRef,
  requireNoGitOperation,
  requireRepository,
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
  "usage: node scripts/vendor-sync.mjs <dir> [--base-from-pin | --without-base]",
  "       node scripts/vendor-sync.mjs <dir> --continue",
  "       node scripts/vendor-sync.mjs <dir> --abort",
].join("\n");

// ---- start ----

function startSync(dirArg, baseChoice, root) {
  const { abs, rel, manifest } = loadConnection(dirArg, root);
  requireNoOpenAction(manifest, "sync", rel);
  requireCleanDir(rel, root);
  requireNoGitOperation(root);
  requireNothingStagedOutside(rel, root);
  fetchTracking(manifest.repo, manifest.ref, manifest.slug, root);
  const tip = readRef(trackingRef(manifest.slug), root);
  const upstreamTree = treeOid(tip, manifest.path, root);
  if (upstreamTree === null) fail(EXIT.STOP, `upstream path absent at ${tip}: ${manifest.path}`);
  const id = identityOf(rel, manifest);
  if (manifest.sha === tip) return { state: "up_to_date", ...id, sha: tip };
  const skipped_submodules = gitlinkPaths(tip, manifest.path, root);

  const commits_behind = isAncestor(manifest.sha, tip, root)
    ? commitsBehind(manifest.sha, tip, manifest.path, root)
    : null;
  const writeMarker = markerWriter(abs, manifest, "sync", tip);
  const pinReady = { id, manifest, tip, commits_behind, skipped_submodules, writeMarker };
  // Same tree: --continue rewrites the stored base anyway, so no base check runs.
  if (treeOid(manifest.sha, manifest.path, root) === upstreamTree) return openPinReady(pinReady);

  const { base, baseTree } = chooseMergeBase(manifest, rel, baseChoice, root);
  const files = describeSync(manifest, rel, base, baseTree, tip, root);
  // The trees differ only in what the description ignores.
  if (files.length === 0) return openPinReady(pinReady);

  stageMerge({
    root,
    rel,
    abs,
    slug: manifest.slug,
    action: "sync",
    base,
    baseTree,
    target: tip,
    upstreamTree,
    writeMarker,
  });
  return {
    state: "merge_staged",
    ...id,
    base,
    sha_before: manifest.sha,
    sha_after: tip,
    commits_behind,
    files,
    skipped_submodules,
    notes: noteIds(base),
  };
}

function openPinReady({ id, manifest, tip, commits_behind, skipped_submodules, writeMarker }) {
  writeMarker("pin_ready");
  return {
    state: "pin_ready",
    ...id,
    sha_before: manifest.sha,
    sha_after: tip,
    commits_behind,
    skipped_submodules,
  };
}

// baseChoice: "stored" checks the stored base; "from_pin" and "none" skip that check.
function chooseMergeBase(manifest, rel, baseChoice, root) {
  if (baseChoice === "none") return { base: null, baseTree: EMPTY_TREE_OID };
  if (baseChoice === "from_pin") {
    if (!commitExists(manifest.sha, root)) {
      fail(
        EXIT.FIX,
        `the pinned commit ${manifest.sha} is not available; choose without_base instead`,
      );
    }
    return { base: manifest.sha, baseTree: treeOid(manifest.sha, manifest.path, root) };
  }
  requireBaseIntact(manifest, rel, root);
  return { base: manifest.sha, baseTree: manifest.base_tree };
}

function describeSync(manifest, rel, base, baseTree, tip, root) {
  return describeChanges(
    base === null ? null : treeEntries(baseTree, "", root),
    treeEntries(tip, manifest.path, root),
    indexEntries(rel, root),
  );
}

// ---- --continue ----

// pin_ready writes nothing into <dir>: upstream changed nothing the local side lacks, so the
// commit holds the closed manifest and the new stored base, plus any edit the user made.
// `files` is what the commit changed in <dir>.
function continueSync(dirArg, root) {
  const { abs, rel, manifest, target } = openForContinue(dirArg, "sync", root);
  const commit = finishAction({ root, rel, abs, manifest });
  const files = committedPaths(rel, root);
  return {
    state: "synced",
    ...identityOf(rel, manifest),
    sha_before: manifest.sha,
    sha_after: target,
    commit,
    files,
  };
}

run(() => {
  const { positionals, flags } = parseArgvOrFail(
    process.argv.slice(2),
    { value: [], bool: ["base-from-pin", "without-base", "continue", "abort"] },
    USAGE,
  );
  const mode = resumeMode(positionals, flags, ["base-from-pin", "without-base"], USAGE);
  if (mode === null) {
    const usage = usageFailure(USAGE);
    if (positionals.length !== 1) usage("expected exactly one <dir>");
    if (flags["base-from-pin"] && flags["without-base"]) {
      usage("--base-from-pin and --without-base exclude each other");
    }
  }
  const root = requireRepository(process.cwd());
  if (mode === "continue") return continueSync(positionals[0], root);
  if (mode === "abort") return abortOpenAction(positionals[0], root);
  // The base flags are passed only after the user chose the matching option of a failed
  // stored-base check.
  const baseChoice = flags["without-base"]
    ? "none"
    : flags["base-from-pin"]
      ? "from_pin"
      : "stored";
  return startSync(positionals[0], baseChoice, root);
});
