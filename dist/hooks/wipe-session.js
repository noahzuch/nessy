import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "../lib/paths.js";
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
    configure({
        level,
        hookName: "wipe-session",
        sessionId: payload.session_id,
        agentId: payload.agent_id ?? null,
    });
    const dir = join(projectRoot, ".nessy", "cache", payload.session_id);
    try {
        rmSync(dir, { recursive: true, force: true });
        log("info", `wiped session dir: ${dir}`);
    }
    catch (e) {
        log("warn", `wipe-session failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
main();
//# sourceMappingURL=wipe-session.js.map