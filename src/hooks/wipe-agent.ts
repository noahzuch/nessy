import { rmSync } from "node:fs";
import { BasePayloadSchema } from "src/lib/payload.js";
import { cachePathFor } from "src/lib/cache.js";
import { log } from "src/lib/log.js";
import { runHook } from "src/lib/run-hook.js";

runHook("wipe-agent", BasePayloadSchema, { requiresProject: true, requiresConfig: false }, ({ payload, projectRoot }) => {
  const file = cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null);
  try {
    rmSync(file, { force: true });
    log("info", `wiped agent file: ${file}`);
  } catch (e) {
    log("warn", `wipe-agent failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});
