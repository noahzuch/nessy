import { log } from "../lib/log.js";
import { BashHookPayloadSchema } from "../lib/payload.js";
import { runHook } from "../lib/run-hook.js";
const PATTERN = /\bnessy\s+\w/;
const BLOCK_MSG = "Nessy: nessy CLI commands are user-only; Claude cannot run them. " +
    "If the user wants this, they should invoke the matching plugin skill themselves.";
runHook("block-nessy-cli", BashHookPayloadSchema, { requiresProject: false }, ({ payload }) => {
    const cmd = payload.tool_input.command;
    if (!PATTERN.test(cmd))
        return;
    log("info", `block: ${cmd}`);
    process.stdout.write(JSON.stringify({ decision: "block", reason: BLOCK_MSG }));
});
//# sourceMappingURL=block-nessy-cli.js.map