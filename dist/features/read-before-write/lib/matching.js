import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const ignore = _require("ignore");
function normalize(path) {
    return path.split("\\").join("/");
}
export function matchRules(targetPath, rules) {
    const norm = normalize(targetPath);
    return rules.filter((r) => ignore().add(r.match).ignores(norm));
}
export function unionRequires(matched) {
    const set = new Set();
    for (const r of matched)
        for (const req of r.require)
            set.add(req);
    return [...set];
}
//# sourceMappingURL=matching.js.map