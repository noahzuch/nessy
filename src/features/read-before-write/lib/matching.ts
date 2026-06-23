import { createRequire } from "node:module";
import type { Ignore } from "ignore";
const _require = createRequire(import.meta.url);
const ignore: (options?: { ignorecase?: boolean }) => Ignore = _require("ignore");
import type { Rule } from "src/shared/config.js";

function normalize(path: string): string {
  return path.split("\\").join("/");
}

export function matchRules(targetPath: string, rules: Rule[]): Rule[] {
  const norm = normalize(targetPath);
  return rules.filter((r) => ignore().add(r.match).ignores(norm));
}
export function unionRequires(matched: Rule[]): string[] {
  const set = new Set<string>();
  for (const r of matched) for (const req of r.require) set.add(req);
  return [...set];
}
