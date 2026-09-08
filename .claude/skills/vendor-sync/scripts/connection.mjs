// The connection layer: a vendored directory's slug, location, manifest and open-action
// marker, plus the stored base, the tool files, scratch and the commit at --continue that
// build on them.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { EXIT, fail, HEX40, isPlainObject } from "./contract.mjs";
import {
  commitExists,
  commitIndex,
  git,
  gitOrFail,
  literal,
  prefixedTree,
  restoreTree,
  stagedPaths,
  trackingRef,
  treeOid,
  uncommittedPaths,
} from "./git.mjs";

export const MANIFEST_NAME = ".vendor.json";
export const MANIFEST_FIELDS = ["slug", "repo", "path", "ref", "sha", "base_tree", "in_progress"];
export const TOOL_ROOT = ".vendor-sync";

const REQUIRED_STRINGS = ["slug", "repo", "path", "ref", "sha", "base_tree"];
const MARKER_FIELDS = ["action", "state", "target_sha"];
const SLUG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const STATES = {
  add: ["ready", "merging", "merge_staged"],
  sync: ["pin_ready", "merging", "merge_staged"],
};
const SKIPPED_DIRS = new Set([".git", "node_modules", TOOL_ROOT]);
const OPEN_ACTION_HINT = "finish it with --continue, or discard it with --abort";
const TOOL_GITIGNORE = "/scratch/\n";
const TOOL_GITATTRIBUTES = "base/** -diff -merge linguist-generated\n";

// ---- slug ----

export function deriveSlug(rel) {
  return rel
    .replace(/\//g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export function requireSlug(rel, root) {
  const slug = deriveSlug(rel);
  if (slug === "" || git(["check-ref-format", trackingRef(slug)], root).status !== 0) {
    fail(EXIT.FIX, `cannot derive a ref-safe slug from the directory name: ${rel}`, {
      hint: "rename the directory and re-run",
    });
  }
  return slug;
}

// `connections` is what findVendoredDirs returned.
export function requireSlugUnused(slug, rel, connections, root) {
  for (const dir of connections) {
    if (dir === rel) continue;
    let other;
    try {
      other = JSON.parse(readFileSync(join(root, dir, MANIFEST_NAME), "utf8"));
    } catch {
      continue;
    }
    if (other?.slug === slug) {
      fail(EXIT.FIX, `slug "${slug}" is already used by ${dir}`, {
        hint: "rename the directory and re-run",
      });
    }
  }
}

// ---- directory ----

export function isInside(rootAbs, abs) {
  const rel = relative(rootAbs, abs);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function normalizeLocalDir(arg, root) {
  const abs = resolve(root, arg);
  if (!isInside(root, abs)) {
    fail(EXIT.FIX, `${arg}: directory must lie inside the repository (${root})`);
  }
  return { abs, rel: toRepoPath(root, abs) };
}

// `abs` relative to `root`, with forward slashes.
function toRepoPath(root, abs) {
  return relative(root, abs).split(sep).join("/");
}

// A `.vendor.json` inside another connection's directory is upstream content that connection
// manages, so no script acts on it. The outermost connection names the directory, as in list.
export function requireNotNested(rel, root) {
  let outer = null;
  for (let dir = posix.dirname(rel); dir !== "."; dir = posix.dirname(dir)) {
    if (holdsManifest(dir, root)) outer = dir;
  }
  if (outer !== null) {
    fail(EXIT.STOP, `${rel} is inside the vendored directory ${outer}`, {
      hint: "choose a directory outside it",
    });
  }
}

// A connection below `rel` would have its files merged into the new one, and list would stop
// showing it, so add refuses to start onto a directory that contains one. `rel` is compared as
// the file system resolves it, so on a case-insensitive one `Vendor` contains `vendor/foo`;
// the connections need no resolving, because findVendoredDirs reads their names from disk and
// does not follow symbolic links, which requireNoSymlink has already refused in `rel`. A `rel`
// that does not exist contains nothing. `connections` is what findVendoredDirs returned.
export function requireNoInnerConnection(rel, connections, root) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  const resolved = toRepoPath(realpathSync.native(root), realpathSync.native(abs));
  const inner = connections.find((dir) => dir.startsWith(`${resolved}/`));
  if (inner !== undefined) {
    fail(EXIT.STOP, `${rel} contains the vendored directory ${inner}`, {
      hint: "choose a directory that holds no vendored directory",
    });
  }
}

// A `rel` that is a symbolic link, or lies under one, would have the start write through the
// link, outside `rel`, and `git restore` replace the link. Every existing component between the
// root and `rel`, inclusive of `rel`, is checked with lstat; the outermost link is named.
export function requireNoSymlink(rel, root) {
  let dir = "";
  for (const name of rel.split("/")) {
    dir = dir === "" ? name : `${dir}/${name}`;
    let stat;
    try {
      stat = lstatSync(join(root, dir));
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      fail(EXIT.FIX, `${dir} is a symbolic link`, {
        hint: "choose a directory that is not a symbolic link or inside one",
      });
    }
  }
}

// findVendoredDirs' test: a regular file named `.vendor.json`, in a directory its walk reaches.
function holdsManifest(dir, root) {
  if (dir.split("/").some((name) => SKIPPED_DIRS.has(name))) return false;
  try {
    return lstatSync(join(root, dir, MANIFEST_NAME)).isFile();
  } catch {
    return false;
  }
}

// ---- manifest ----

export function serializeManifest(manifest) {
  const obj = {};
  for (const field of MANIFEST_FIELDS) obj[field] = manifest[field];
  obj.in_progress = copyMarker(manifest.in_progress ?? null);
  return JSON.stringify(obj, null, 2) + "\n";
}

function isValidMarker(marker) {
  return (
    isPlainObject(marker) &&
    Object.keys(marker).every((key) => MARKER_FIELDS.includes(key)) &&
    Object.hasOwn(STATES, marker.action) &&
    STATES[marker.action].includes(marker.state) &&
    typeof marker.target_sha === "string" &&
    HEX40.test(marker.target_sha)
  );
}

export function parseManifest(text, path) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    fail(EXIT.STOP, `${path}: malformed JSON: ${err.message}`);
  }
  if (!isPlainObject(obj)) fail(EXIT.STOP, `${path}: not a JSON object`);
  for (const key of Object.keys(obj)) {
    if (!MANIFEST_FIELDS.includes(key)) fail(EXIT.STOP, `${path}: unknown field "${key}"`);
  }
  for (const field of REQUIRED_STRINGS) {
    const value = obj[field];
    if (typeof value !== "string" || !/\S/.test(value)) {
      fail(EXIT.STOP, `${path}: missing required field "${field}"`);
    }
  }
  if (!Object.hasOwn(obj, "in_progress")) {
    fail(EXIT.STOP, `${path}: missing required field "in_progress"`);
  }
  if (!SLUG_PATTERN.test(obj.slug)) fail(EXIT.STOP, `${path}: invalid slug`);
  for (const field of ["sha", "base_tree"]) {
    if (!HEX40.test(obj[field])) fail(EXIT.STOP, `${path}: invalid ${field}`);
  }
  const marker = obj.in_progress;
  if (marker !== null && !isValidMarker(marker)) fail(EXIT.STOP, `${path}: invalid in_progress`);
  return {
    slug: obj.slug,
    repo: obj.repo,
    path: obj.path,
    ref: obj.ref,
    sha: obj.sha,
    base_tree: obj.base_tree,
    in_progress: copyMarker(marker),
  };
}

// The marker's three fields in their on-disk order, or null.
function copyMarker(marker) {
  return marker === null
    ? null
    : { action: marker.action, state: marker.state, target_sha: marker.target_sha };
}

export function manifestExists(abs) {
  return existsSync(join(abs, MANIFEST_NAME));
}

export function loadManifest(abs, rel) {
  if (!manifestExists(abs)) {
    fail(EXIT.STOP, `not a vendored directory: ${rel}`, { hint: "use add to vendor it" });
  }
  return parseManifest(readFileSync(join(abs, MANIFEST_NAME), "utf8"), `${rel}/${MANIFEST_NAME}`);
}

// <dir> as `{ abs, rel }`, inside the repository and not inside another connection.
function locateDir(dirArg, root) {
  const { abs, rel } = normalizeLocalDir(dirArg, root);
  requireNotNested(rel, root);
  return { abs, rel };
}

// An existing connection: `locateDir`, then its manifest.
export function loadConnection(dirArg, root) {
  const { abs, rel } = locateDir(dirArg, root);
  return { root, abs, rel, manifest: loadManifest(abs, rel) };
}

// The identity fields every add and sync result starts with.
export function identityOf(rel, manifest) {
  return {
    dir: rel,
    slug: manifest.slug,
    repo: manifest.repo,
    path: manifest.path,
    ref: manifest.ref,
  };
}

export function writeManifest(abs, manifest) {
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, MANIFEST_NAME), serializeManifest(manifest));
}

export function findVendoredDirs(root) {
  const found = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === MANIFEST_NAME)) {
      found.push(toRepoPath(root, abs));
      // A manifest below a connection's directory is that connection's upstream content. The
      // repository root is never a connection's directory.
      if (abs !== root) return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) walk(join(abs, entry.name));
    }
  };
  walk(root);
  return found.sort();
}

// ---- markers ----

export function requireNoOpenAction(manifest, action, rel) {
  const marker = manifest.in_progress;
  if (marker === null) return;
  const choices =
    marker.state !== "merging" && marker.action === action
      ? ["resume", "abort", "leave"]
      : ["abort", "leave"];
  fail(EXIT.FIX, openActionMessage(marker, rel), { data: { choices } });
}

// The open `action` that --continue finishes; a `merging` marker never finished its start.
export function requireMarker(manifest, action, rel) {
  const marker = requireOpen(manifest, action, rel);
  if (marker.action !== action) {
    fail(EXIT.STOP, `an unfinished ${marker.action} is open on ${rel}, not ${action}`, {
      hint: OPEN_ACTION_HINT,
    });
  }
  if (marker.state === "merging") {
    fail(
      EXIT.STOP,
      `the ${marker.action} on ${rel} did not finish its start; discard it with --abort`,
    );
  }
  return marker;
}

// Whatever action is open, in any state, for --abort.
export function requireAnyMarker(manifest, rel) {
  return requireOpen(manifest, "action", rel);
}

// The open marker; `name` is the word the failure uses for the missing action.
function requireOpen(manifest, name, rel) {
  const marker = manifest.in_progress;
  if (marker === null) {
    fail(EXIT.STOP, `no unfinished ${name} on ${rel}`, { hint: "run the start call first" });
  }
  return marker;
}

export function requireMarkerClosed(manifest, rel) {
  const marker = manifest.in_progress;
  if (marker === null) return;
  fail(EXIT.STOP, openActionMessage(marker, rel), { hint: OPEN_ACTION_HINT });
}

function openActionMessage(marker, rel) {
  return `an unfinished ${marker.action} is open on ${rel}, started against ${marker.target_sha}`;
}

// The start's marker writer: `writeMarker(state)` writes `manifest` with the open `action`
// in `state`, targeting `target`.
export function markerWriter(abs, manifest, action, target) {
  return (state) =>
    writeManifest(abs, { ...manifest, in_progress: { action, state, target_sha: target } });
}

// ---- stored base ----

export function baseRepoPath(slug) {
  return `${TOOL_ROOT}/base/${slug}`;
}

// Reads HEAD, never the working tree: an uncommitted base is missing from every clone.
export function committedBaseTree(slug, root) {
  return treeOid("HEAD", baseRepoPath(slug), root);
}

export function requireBaseIntact(manifest, rel, root) {
  const committed = committedBaseTree(manifest.slug, root);
  if (committed === manifest.base_tree) return;
  const message =
    committed === null
      ? `the stored base for ${rel} is missing from HEAD`
      : `the stored base for ${rel} does not match the pinned upstream commit ${manifest.sha}`;
  const choices = commitExists(manifest.sha, root)
    ? ["base_from_pin", "leave"]
    : ["without_base", "leave"];
  fail(EXIT.FIX, message, { data: { choices } });
}

export function writeStoredBase(slug, target, path, root) {
  const upstream = treeOid(target, path, root);
  if (upstream === null) fail(EXIT.STOP, `upstream path absent at ${target}: ${path}`);
  const prefixed = prefixedTree(upstream, baseRepoPath(slug), root, { omitManifest: true });
  restoreTree(prefixed, [literal(baseRepoPath(slug))], root);
  return treeOid(prefixed, baseRepoPath(slug), root);
}

export function writeToolFiles(root) {
  mkdirSync(join(root, TOOL_ROOT), { recursive: true });
  writeFileSync(join(root, TOOL_ROOT, ".gitignore"), TOOL_GITIGNORE);
  writeFileSync(join(root, TOOL_ROOT, ".gitattributes"), TOOL_GITATTRIBUTES);
  gitOrFail(
    ["add", "--", literal(`${TOOL_ROOT}/.gitignore`), literal(`${TOOL_ROOT}/.gitattributes`)],
    "cannot stage the vendor-sync tool files",
    root,
  );
}

// ---- scratch ----

export function scratchDir(root, slug) {
  return join(root, TOOL_ROOT, "scratch", slug);
}

// The `*` ignore file sits inside the slug's folder, so scratch is ignored before
// `.vendor-sync/.gitignore` is ever committed and resetScratch removes it with the rest.
export function ensureScratch(root, slug) {
  const dir = scratchDir(root, slug);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "*\n");
  } catch (err) {
    fail(EXIT.STOP, `cannot write scratch at ${dir}: ${err.message}`);
  }
  return dir;
}

// `scratch/`, an emptied `base/` (a rolled-back commit removes `base/<slug>`) and then
// `.vendor-sync/` go too once nothing else is left in them. rmdir only ever removes an empty
// directory, and a failure (not empty, absent) just keeps it.
export function resetScratch(root, slug) {
  rmSync(scratchDir(root, slug), { recursive: true, force: true });
  pruneToolDirs(root);
}

function pruneToolDirs(root) {
  for (const dir of ["scratch", "base", ""]) {
    try {
      rmdirSync(join(root, TOOL_ROOT, dir));
    } catch {
      // keep it
    }
  }
}

// ---- files ----

export function countFiles(abs) {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile()) count++;
    else if (entry.isDirectory()) count += countFiles(join(abs, entry.name));
  }
  return count;
}

// ---- the commit at --continue ----

// The paths besides `<dir>` that the commit at --continue holds.
function toolPaths(slug) {
  return [baseRepoPath(slug), `${TOOL_ROOT}/.gitignore`, `${TOOL_ROOT}/.gitattributes`];
}

// A start writes into `rel` and `--abort` restores it from `HEAD`, so `rel` must hold nothing
// uncommitted; the paths that do are named.
export function requireCleanDir(rel, root) {
  const paths = uncommittedPaths(rel, root);
  if (paths.length > 0) {
    fail(EXIT.STOP, `${rel} has uncommitted changes: ${paths.join(", ")}`, {
      hint: "commit or discard them, then re-run",
    });
  }
}

// As `git merge` does, an action refuses to run while unrelated changes are staged, so the
// commit at --continue, a plain commit of the index, holds only the tool's paths. The start
// check stops (exit 2) on any staged path outside <dir>.
export function requireNothingStagedOutside(rel, root) {
  requireStagedWithin(rel, [], EXIT.STOP, root);
}

// The check at --continue: the slug's stored base and the two dotfiles count as the tool's
// too, and a path outside is the user's to fix (exit 1).
export function requireNothingStagedForCommit(rel, slug, root) {
  requireStagedWithin(rel, toolPaths(slug), EXIT.FIX, root);
}

function requireStagedWithin(rel, extraPaths, exitCode, root) {
  const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);
  const outside = stagedPaths(root).filter(
    (path) => !inside(path, rel) && !extraPaths.some((dir) => inside(path, dir)),
  );
  if (outside.length > 0) {
    fail(exitCode, `staged changes outside ${rel}: ${outside.join(", ")}`, {
      hint: "commit or unstage them, then re-run",
    });
  }
}

// The open marker in `manifest` names the action and its target.
export function finishAction({ root, rel, abs, manifest }) {
  const { action, target_sha: target } = manifest.in_progress;
  const slug = manifest.slug;
  const manifestPath = `${rel}/${MANIFEST_NAME}`;
  let commit;
  try {
    const base_tree = writeStoredBase(slug, target, manifest.path, root);
    writeToolFiles(root);
    writeManifest(abs, { ...manifest, sha: target, base_tree, in_progress: null });
    gitOrFail(["add", "--", literal(manifestPath)], "cannot stage the manifest", root);
    commit = commitIndex(`vendor-sync: ${action} ${rel} to ${target.slice(0, 7)}`, rel, root);
  } catch (err) {
    // Everything stays as it was: the base and tool files go back to HEAD in index and
    // working tree, the manifest's index entry goes back to HEAD, and the open manifest
    // returns to disk, so neither --abort nor the user's own commit pins the target. Only an
    // unstaged edit inside <dir> that the commit staged stays staged, with the same content.
    // The tool directories the failed attempt created go too, once they are empty again.
    for (const path of toolPaths(slug)) resetToHead(path, root, { worktree: true });
    pruneToolDirs(root);
    resetToHead(manifestPath, root, { worktree: false });
    writeManifest(abs, manifest);
    throw err;
  }
  resetScratch(root, slug);
  return commit;
}

// Best effort, on exact paths only: a path HEAD lacks ends up absent from the index (and
// the working tree). `git restore` errors on a pathspec matching nothing in HEAD or the
// index, so the two cases take different commands.
function resetToHead(path, root, { worktree }) {
  const spec = literal(path);
  if (git(["cat-file", "-e", `HEAD:${path}`], root).status === 0) {
    const where = worktree ? ["--staged", "--worktree"] : ["--staged"];
    git(["restore", "--source=HEAD", ...where, "--", spec], root);
    return;
  }
  git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", spec], root);
  if (worktree) rmSync(join(root, path), { recursive: true, force: true });
}
