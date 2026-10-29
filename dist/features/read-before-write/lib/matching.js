import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const ignore = _require("ignore");
function normalize(path) {
    return path.split("\\").join("/");
}
// Rule globs are gitignore patterns rooted at the project, so a path that escapes
// the root can never match one — and `ignore` rejects such paths outright.
const escapesRoot = (p) => p === ".." || p.startsWith("../");
export function matchRules(targetPath, rules) {
    const norm = normalize(targetPath);
    if (escapesRoot(norm))
        return [];
    return rules.filter((r) => ignore().add(r.match).ignores(norm));
}
export function unionRequires(matched) {
    const set = new Set();
    for (const r of matched)
        for (const req of r.require)
            set.add(req);
    return [...set];
}
export function isRequired(path, rules) {
    const norm = normalize(path);
    return rules.some((r) => r.require.includes(norm));
}
//# sourceMappingURL=matching.js.map