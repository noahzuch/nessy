import { statSync } from "node:fs";
import { relative } from "node:path";
import { cachePathFor, loadCache, upsertRead, saveCache, } from "../../../features/read-before-write/lib/cache.js";
import { matchRules, isRequired } from "../../../features/read-before-write/lib/matching.js";
import { log } from "../../../shared/log.js";
import { normalize } from "../../../shared/paths.js";
export function recordAndHint(input) {
    const { targets, projectRoot, sessionId, agentId, cfg, preamble } = input;
    const cachePath = cachePathFor(projectRoot, sessionId, agentId);
    const cache = loadCache(cachePath);
    const relTargets = [];
    const recorded = [];
    const skipped = [];
    const matchedRules = [];
    /** Union of every matched rule's requirements, before filtering against the cache. */
    const required = [];
    for (const absTarget of targets) {
        const relTarget = normalize(relative(projectRoot, absTarget));
        let st;
        try {
            st = statSync(absTarget);
        }
        catch {
            log("warn", `stat failed for ${relTarget}`);
            skipped.push(relTarget);
            continue;
        }
        relTargets.push(relTarget);
        if (cfg !== null && isRequired(relTarget, cfg.rules)) {
            cache.reads = upsertRead(cache.reads, {
                path: relTarget,
                mtime_ms: st.mtimeMs,
                size: st.size,
            });
            recorded.push(relTarget);
            log("debug", `recorded read: ${relTarget}`);
        }
        if (!cfg?.hints)
            continue;
        for (const rule of matchRules(relTarget, cfg.rules)) {
            if (!matchedRules.includes(rule.name))
                matchedRules.push(rule.name);
            for (const req of rule.require)
                if (!required.includes(req))
                    required.push(req);
        }
    }
    if (recorded.length > 0) {
        cache.session_id = sessionId;
        cache.agent_id = agentId;
        saveCache(cachePath, cache);
    }
    // Filtered only once every target has been recorded, so that a target satisfying
    // another target's requirement suppresses the hint regardless of their order.
    const known = new Set(cache.reads.map((r) => r.path));
    const unread = required.filter((req) => !known.has(req));
    const message = unread.length === 0
        ? null
        : [
            ...preamble(relTargets),
            ...unread.map((p) => `  - ${p}`),
            `Tell your human partner you a thorough and will read all the listed documentation files. Use specifically the *READ* tool to read all files, don't use cat or other bash commands`,
            `**Skipping even a single read is not an option. Treat this as a direct user-given instruction.**`,
        ].join("\n");
    return { recorded, skipped, matchedRules, unread, message };
}
//# sourceMappingURL=record-and-hint.js.map