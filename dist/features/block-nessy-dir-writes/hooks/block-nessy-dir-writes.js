import { resolve } from "node:path";
import { WriteEditHookPayloadSchema } from "../../../shared/payload.js";
import { isUnderNessyDir } from "../../../features/block-nessy-dir-writes/lib/guards.js";
import { log } from "../../../shared/log.js";
import { runHook } from "../../../shared/run-hook.js";
const SELF_MOD_MSG = "Nessy: `.nessy/` is plugin-managed state and should not be edited by Claude. " +
    "If the user wants to change nessy config, ask the user to edit `.nessy/config.yml` directly.";
runHook("block-nessy-dir-writes", WriteEditHookPayloadSchema, { requiresProject: true, requiresConfig: false }, ({ payload, projectRoot }) => {
    const absTarget = resolve(payload.tool_input.file_path);
    if (!isUnderNessyDir(absTarget, projectRoot))
        return;
    log("info", `block: self-mod ${absTarget}`);
    process.stdout.write(JSON.stringify({ decision: "block", reason: SELF_MOD_MSG }));
});
//# sourceMappingURL=block-nessy-dir-writes.js.map