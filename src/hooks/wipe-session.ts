import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "src/lib/paths.js";
import { parseConfig } from "src/lib/config.js";
import { configure, log, type Level } from "src/lib/log.js";
import { BasePayloadSchema, readAndParsePayload } from "src/lib/payload.js";

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

  const dir = join(projectRoot, ".nessy", "cache", payload.session_id);
  try {
    rmSync(dir, { recursive: true, force: true });
    log("info", `wiped session dir: ${dir}`);
  } catch (e) {
    log("warn", `wipe-session failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
main();
