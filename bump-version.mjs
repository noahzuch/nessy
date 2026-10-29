// Bumps the plugin version and keeps package.json in sync.
// Usage: node scripts/bump-version.mjs <patch|minor|major>  (prints the new version)
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LEVELS = new Set(["patch", "minor", "major"]);

export function bumpVersion(version, level) {
  if (!LEVELS.has(level)) throw new Error(`Invalid bump level: ${level}`);
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Invalid version: ${version}`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (level === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function writeVersion(path, version) {
  const obj = JSON.parse(readFileSync(path, "utf8"));
  obj.version = version;
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

export function applyBump(root, level) {
  const pluginPath = join(root, ".claude-plugin", "plugin.json");
  const pkgPath = join(root, "package.json");
  const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
  const next = bumpVersion(plugin.version, level);
  writeVersion(pluginPath, next);
  writeVersion(pkgPath, next);
  return next;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const level = process.argv[2] ?? "patch";
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  process.stdout.write(applyBump(root, level) + "\n");
}
