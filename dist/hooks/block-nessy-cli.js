import { configure, log } from "../lib/log.js";
import { BashHookPayloadSchema, readAndParsePayload } from "../lib/payload.js";
const PATTERN = /\bnessy\s+\w/;
const BLOCK_MSG = "Nessy: nessy CLI commands are user-only; Claude cannot run them. " +
    "If the user wants this, they should invoke the matching plugin skill themselves.";
function main() {
    const payload = readAndParsePayload(BashHookPayloadSchema);
    if (payload === null)
        return;
    configure({
        level: "info",
        hookName: "block-nessy-cli",
        sessionId: payload.session_id,
        agentId: payload.agent_id ?? null,
    });
    const cmd = payload.tool_input.command;
    if (!PATTERN.test(cmd))
        return;
    log("info", `block: ${cmd}`);
    process.stdout.write(JSON.stringify({ decision: "block", reason: BLOCK_MSG }));
}
main();
//# sourceMappingURL=block-nessy-cli.js.map