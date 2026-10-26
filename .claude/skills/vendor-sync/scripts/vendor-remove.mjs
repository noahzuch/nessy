#!/usr/bin/env node
// vendor-sync: drop the connection of a vendored directory and keep every vendored file.
// Performs no network operation and makes no commit: the deletions are the user's to commit.

import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  baseRepoPath,
  countFiles,
  loadConnection,
  MANIFEST_NAME,
  requireMarkerClosed,
  resetScratch,
} from "./connection.mjs";
import { parseArgvOrFail, run, usageFailure } from "./contract.mjs";
import { deleteRef, repoRoot, trackingRef } from "./git.mjs";

const USAGE = "usage: node scripts/vendor-remove.mjs <dir>";

function remove(dirArg, root) {
  const { abs, rel, manifest } = loadConnection(dirArg, root);
  requireMarkerClosed(manifest, rel);
  const { slug } = manifest;
  rmSync(join(abs, MANIFEST_NAME), { force: true });
  rmSync(join(root, baseRepoPath(slug)), { recursive: true, force: true });
  deleteRef(trackingRef(slug), root);
  resetScratch(root, slug);
  return { state: "removed", dir: rel, slug, files_retained: countFiles(abs) };
}

run(() => {
  const { positionals } = parseArgvOrFail(process.argv.slice(2), { value: [], bool: [] }, USAGE);
  if (positionals.length !== 1) usageFailure(USAGE)("expected exactly one <dir>");
  return remove(positionals[0], repoRoot(process.cwd()));
});
