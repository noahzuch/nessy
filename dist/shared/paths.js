import { existsSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
export const normalize = (p) => p.split("\\").join("/");
export function findProjectRoot(startDir) {
    let current = resolve(startDir);
    const { root } = parse(current);
    while (true) {
        if (existsSync(join(current, ".nessy", "config.yml")))
            return current;
        if (current === root)
            return null;
        current = dirname(current);
    }
}
//# sourceMappingURL=paths.js.map