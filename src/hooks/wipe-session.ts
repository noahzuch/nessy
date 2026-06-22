import { rmSync } from "node:fs";
import { join } from "node:path";
import { BasePayloadSchema } from "src/lib/payload.js";
import { log } from "src/lib/log.js";
import { runHook } from "src/lib/run-hook.js";

runHook("wipe-session", BasePayloadSchema, { requiresProject: true, requiresConfig: false }, ({ payload, projectRoot }) => {
  const dir = join(projectRoot, ".nessy", "cache", payload.session_id);
  try {
    rmSync(dir, { recursive: true, force: true });
    log("info", `wiped session dir: ${dir}`);
  } catch (e) {
    log("warn", `wipe-session failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});
