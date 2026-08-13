import { createRequire } from "node:module";
import type { Ignore } from "ignore";
const _require = createRequire(import.meta.url);
const ignore: (options?: { ignorecase?: boolean }) => Ignore = _require("ignore");
import type { Rule } from "src/shared/config.js";

function normalize(path: string): string {
  return path.split("\\").join("/");
}

// Rule globs are gitignore patterns rooted at the project, so a path that escapes
// the root can never match one — and `ignore` rejects such paths outright.
const escapesRoot = (p: string): boolean => p === ".." || p.startsWith("../");

export function matchRules(targetPath: string, rules: Rule[]): Rule[] {
  const norm = normalize(targetPath);
  if (escapesRoot(norm)) return [];
  return rules.filter((r) => ignore().add(r.match).ignores(norm));
}
export function unionRequires(matched: Rule[]): string[] {
  const set = new Set<string>();
  for (const r of matched) for (const req of r.require) set.add(req);
  return [...set];
}

export function isRequired(path: string, rules: Rule[]): boolean {
  const norm = normalize(path);
  return rules.some((r) => r.require.includes(norm));
}
