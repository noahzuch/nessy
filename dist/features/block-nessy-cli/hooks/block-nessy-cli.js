import { log } from "../../../shared/log.js";
import { BashHookPayloadSchema } from "../../../shared/payload.js";
import { runHook } from "../../../shared/run-hook.js";
const PATTERN = /\bnessy\s+\w/;
const BLOCK_MSG = "Nessy: nessy CLI commands are user-only; Claude cannot run them. " +
    "If the user instructed you to call it, tell him that he has to execute nessy commands manually";
runHook("block-nessy-cli", BashHookPayloadSchema, { requiresProject: false }, ({ payload }) => {
    const cmd = payload.tool_input.command;
    if (!PATTERN.test(cmd))
        return;
    log("info", `block: ${cmd}`);
    process.stdout.write(JSON.stringify({ decision: "block", reason: BLOCK_MSG }));
});
//# sourceMappingURL=block-nessy-cli.js.map