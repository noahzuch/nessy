import { statSync } from "node:fs";
export function checkStaleness(p, cachedMtime, cachedSize) {
    try {
        const s = statSync(p);
        return s.mtimeMs === cachedMtime && s.size === cachedSize ? "fresh" : "stale";
    }
    catch {
        return "missing";
    }
}
//# sourceMappingURL=staleness.js.map