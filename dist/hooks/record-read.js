import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ReadHookPayloadSchema } from "../lib/payload.js";
import { cachePathFor, loadCache, upsertRead, saveCache } from "../lib/cache.js";
import { matchRules } from "../lib/matching.js";
import { log } from "../lib/log.js";
import { normalize } from "../lib/paths.js";
import { runHook } from "../lib/run-hook.js";
runHook("record-read", ReadHookPayloadSchema, { requiresProject: true, requiresConfig: false }, ({ payload, projectRoot, cfg }) => {
    const absTarget = resolve(payload.tool_input.file_path);
    const relTarget = normalize(relative(projectRoot, absTarget));
    if (relTarget.startsWith("..") || relTarget.startsWith(".nessy/"))
        return;
    let st;
    try {
        st = statSync(absTarget);
    }
    catch {
        log("warn", `stat failed for ${relTarget}`);
        return;
    }
    const cachePath = cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null);
    const cache = loadCache(cachePath);
    cache.reads = upsertRead(cache.reads, { path: relTarget, mtime_ms: st.mtimeMs, size: st.size });
    cache.session_id = payload.session_id;
    cache.agent_id = payload.agent_id ?? null;
    saveCache(cachePath, cache);
    log("debug", `recorded read: ${relTarget}`);
    try {
        if (!cfg?.hints)
            return;
        const matched = matchRules(relTarget, cfg.rules);
        if (matched.length === 0)
            return;
        const known = new Set(cache.reads.map((r) => r.path));
        const unread = [];
        for (const r of matched)
            for (const req of r.require)
                if (!known.has(req) && !unread.includes(req))
                    unread.push(req);
        if (unread.length === 0)
            return;
        const message = [
            `Nessy: You just read \`${relTarget}\`.`,
            `Before you Write or Edit this file (or any other file matching the same rule), read the following:`,
            ...unread.map((p) => `  - ${p}`),
            ``,
            `Reading them now means no interrupted writes later.`,
        ].join("\n");
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: { additionalContext: message, hookEventName: "PostToolUse" },
        }));
        log("info", `hint: ${matched.map((r) => r.name).join(",")}`);
    }
    catch (e) {
        log("warn", `hint emission skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
});
//# sourceMappingURL=record-read.js.map