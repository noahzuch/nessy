import { relative, resolve } from "node:path";
export function isUnderNessyDir(target, root) {
    const nessy = resolve(root, ".nessy");
    const t = resolve(target);
    if (t === nessy)
        return true;
    const rel = relative(nessy, t);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}
//# sourceMappingURL=guards.js.map