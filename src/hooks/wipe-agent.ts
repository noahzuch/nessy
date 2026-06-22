import { readFileSync, rmSync } from "node:fs";
import { findProjectRoot } from "src/lib/paths.js";
import { parseConfig } from "src/lib/config.js";
import { configure, log, type Level } from "src/lib/log.js";
import { BasePayloadSchema, readAndParsePayload } from "src/lib/payload.js";
import { cachePathFor } from "src/lib/cache.js";

function main(): void {
  const payload = readAndParsePayload(BasePayloadSchema);
  if (payload === null) return;
  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  let level: Level = "info";
  try {
    level = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8")).log_level;
  } catch {}
  configure({
    level,
    hookName: "wipe-agent",
    sessionId: payload.session_id,
    agentId: payload.agent_id ?? null,
  });

  const file = cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null);
  try {
    rmSync(file, { force: true });
    log("info", `wiped agent file: ${file}`);
  } catch (e) {
    log("warn", `wipe-agent failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
main();
