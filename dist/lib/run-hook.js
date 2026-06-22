import { readFileSync } from "node:fs";
import { findProjectRoot } from "../lib/paths.js";
import { parseConfig } from "../lib/config.js";
import { configure } from "../lib/log.js";
import { readAndParsePayload } from "../lib/payload.js";
export function runHook(name, schema, opts, fn) {
    const payload = readAndParsePayload(schema);
    const sessionId = payload.session_id;
    const agentId = payload.agent_id;
    let projectRoot = findProjectRoot(payload.cwd);
    if (opts.requiresProject === true && projectRoot === null)
        return;
    let cfg = null;
    if (projectRoot !== null) {
        try {
            cfg = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8"));
        }
        catch { }
    }
    configure({
        level: cfg?.log_level ?? "info",
        hookName: name,
        sessionId,
        agentId: agentId ?? null,
    });
    if (opts.requiresProject === true &&
        "requiresConfig" in opts &&
        opts.requiresConfig === true &&
        cfg === null) {
        process.stdout.write(JSON.stringify({
            decision: "block",
            reason: "Nessy: configuration error in .nessy/config.yml — ask the user to fix the config before continuing.",
        }));
        return;
    }
    fn({ payload, sessionId, agentId, projectRoot, cfg });
}
//# sourceMappingURL=run-hook.js.map