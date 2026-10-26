#!/usr/bin/env node
// vendor-sync: report every vendored directory's connection and how it stands upstream.
// A connection that cannot be assessed is reported inline with status "error", so one
// broken manifest or unreachable remote never hides the others. Writes no file; only the
// tracking refs move, as any fetch moves them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  committedBaseTree,
  findVendoredDirs,
  MANIFEST_NAME,
  parseManifest,
} from "./connection.mjs";
import { parseArgvOrFail, run, usageFailure } from "./contract.mjs";
import {
  commitsBehind,
  fetchTracking,
  isAncestor,
  prefixedTree,
  readRef,
  repoRoot,
  trackingRef,
  untrackedFiles,
  worktreeDiffers,
} from "./git.mjs";

const USAGE = "usage: node scripts/vendor-list.mjs";

// Never throws: the facts gathered so far stay in `conn`, and a failure adds status "error".
function assess(rel, root) {
  const conn = {
    dir: rel,
    slug: null,
    repo: null,
    ref: null,
    pinned_sha: null,
    upstream_tip: null,
    status: null,
    commits_behind: null,
    local_modifications: null,
  };
  try {
    const path = `${rel}/${MANIFEST_NAME}`;
    const manifest = parseManifest(readFileSync(join(root, path), "utf8"), path);
    conn.slug = manifest.slug;
    conn.repo = manifest.repo;
    conn.ref = manifest.ref;
    conn.pinned_sha = manifest.sha;
    if (manifest.in_progress !== null) {
      conn.status = "in_progress";
      return conn;
    }
    fetchTracking(manifest.repo, manifest.ref, manifest.slug, root);
    const tip = readRef(trackingRef(manifest.slug), root);
    conn.upstream_tip = tip;
    conn.commits_behind = isAncestor(manifest.sha, tip, root)
      ? commitsBehind(manifest.sha, tip, manifest.path, root)
      : null;
    if (committedBaseTree(manifest.slug, root) !== manifest.base_tree) {
      // No intact base to compare against, so local_modifications stays null.
      conn.status = "base_missing";
      return conn;
    }
    conn.local_modifications =
      worktreeDiffers(prefixedTree(manifest.base_tree, rel, root), rel, root) ||
      untrackedFiles(rel, root).some((p) => p !== MANIFEST_NAME);
    conn.status = manifest.sha === tip ? "up_to_date" : "behind";
    return conn;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...conn,
      status: "error",
      error: message + (err?.gitStderr ? "\n" + err.gitStderr.trimEnd() : ""),
    };
  }
}

run(() => {
  const { positionals } = parseArgvOrFail(process.argv.slice(2), { value: [], bool: [] }, USAGE);
  if (positionals.length !== 0) usageFailure(USAGE)("expected no arguments");
  const root = repoRoot(process.cwd());
  return {
    state: "listed",
    connections: findVendoredDirs(root).map((rel) => assess(rel, root)),
  };
});
