import { readFileSync, rmSync } from "node:fs";
import { findProjectRoot } from "../lib/paths.js";
import { cachePathFor } from "../lib/cache.js";
import { parseConfig } from "../lib/config.js";
import { configure, log } from "../lib/log.js";
import { BasePayloadSchema, readAndParsePayload } from "../lib/payload.js";
function main() {
    const payload = readAndParsePayload(BasePayloadSchema);
    if (payload === null)
        return;
    const projectRoot = findProjectRoot(payload.cwd);
    if (projectRoot === null)
        return;
    let level = "info";
    try {
        level = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8")).log_level;
    }
    catch { }
    configure({ level, hookName: "wipe-agent", sessionId: payload.session_id, agentId: payload.agent_id ?? null });
    const file = cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null);
    try {
        rmSync(file, { force: true });
        log("info", `wipe: ${file}`);
    }
    catch (e) {
        log("warn", `wipe failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
main();
//# sourceMappingURL=wipe-agent.js.map