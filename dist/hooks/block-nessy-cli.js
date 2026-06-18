import { configure, log } from "../lib/log.js";
import { BashHookPayloadSchema, readAndParsePayload } from "../lib/payload.js";
const PATTERNS = [
    /\bnessy\s+(init|remove)\b/,
    /\b(?:\.\/)?(?:bin\/)?nessy\s+(init|remove)\b/,
    /\bnode\s+\S*\/(cli\/\S+|cli\.js|\S*cli(?:\.js)?)\s+(init|remove)\b/,
];
const BLOCK_MSG = "Nessy: `nessy init` and `nessy remove` are user-only commands; Claude cannot run them. "
    + "If the user wants this, they should invoke `/nessy:init` or `/nessy:remove` themselves.";
function main() {
    const payload = readAndParsePayload(BashHookPayloadSchema);
    if (payload === null)
        return;
    configure({ level: "info", hookName: "block-nessy-cli", sessionId: payload.session_id, agentId: payload.agent_id ?? null });
    const cmd = payload.tool_input.command;
    let matched = false;
    try {
        matched = PATTERNS.some(re => re.test(cmd));
    }
    catch (e) {
        log("error", `regex failure: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }
    if (!matched)
        return;
    log("info", `block: ${cmd}`);
    process.stdout.write(JSON.stringify({ decision: "block", reason: BLOCK_MSG }));
}
main();
//# sourceMappingURL=block-nessy-cli.js.map