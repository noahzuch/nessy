import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "../lib/paths.js";
import { parseConfig } from "../lib/config.js";
import { configure, log, type Level } from "../lib/log.js";
import { BasePayloadSchema, readAndParsePayload } from "../lib/payload.js";
import { cachePathFor } from "../lib/cache.js";

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
    hookName: "wipe-session",
    sessionId: payload.session_id,
    agentId: payload.agent_id ?? null,
  });

  if (payload.agent_id) {
    const dir = join(projectRoot, ".nessy", "cache", payload.session_id);
    try {
      rmSync(dir, { recursive: true, force: true });
      log("info", `wipe-session: ${dir}`);
    } catch (e) {
      log("warn", `wipe-session failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    const file = cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null);
    try {
      rmSync(file, { force: true });
      log("info", `wipe: ${file}`);
    } catch (e) {
      log("warn", `wipe failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
main();
