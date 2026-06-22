import { resolve } from "node:path";
import { WriteEditHookPayloadSchema } from "src/lib/payload.js";
import { isUnderNessyDir } from "src/lib/guards.js";
import { log } from "src/lib/log.js";
import { runHook } from "src/lib/run-hook.js";

const SELF_MOD_MSG =
  "Nessy: `.nessy/` is plugin-managed state and should not be edited by Claude. " +
  "If the user wants to change nessy config, ask the user to edit `.nessy/config.yml` directly.";

runHook(
  "block-nessy-dir-writes",
  WriteEditHookPayloadSchema,
  { requiresProject: true, requiresConfig: false },
  ({ payload, projectRoot }) => {
    const absTarget = resolve(payload.tool_input.file_path);
    if (!isUnderNessyDir(absTarget, projectRoot)) return;
    log("info", `block: self-mod ${absTarget}`);
    process.stdout.write(JSON.stringify({ decision: "block", reason: SELF_MOD_MSG }));
  },
);
