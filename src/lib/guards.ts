import { relative, resolve } from "node:path";
export function isUnderNessyDir(target: string, root: string): boolean {
  const nessy = resolve(root, ".nessy");
  const t = resolve(target);
  if (t === nessy) return true;
  const rel = relative(nessy, t);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}
