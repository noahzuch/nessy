import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findProjectRoot } from "../lib/paths.js";
import { cachePathFor, loadCache, upsertRead, saveCache } from "../lib/cache.js";
import { parseConfig } from "../lib/config.js";
import { matchRules } from "../lib/matching.js";
import { configure, log, type Level } from "../lib/log.js";
import { ReadHookPayloadSchema, readAndParsePayload } from "../lib/payload.js";

const normalize = (p: string) => p.split("\\").join("/");

function main(): void {
  const payload = readAndParsePayload(ReadHookPayloadSchema);
  if (payload === null) return;
  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  const sessionId = payload.session_id;
  const agentId = payload.agent_id ?? null;

  // Best-effort log_level peek
  let level: Level = "info";
  try { level = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8")).log_level; } catch {}
  configure({ level, hookName: "record-read", sessionId, agentId });

  const absTarget = resolve(payload.tool_input.file_path);
  const relTarget = normalize(relative(projectRoot, absTarget));
  if (relTarget.startsWith("..") || relTarget.startsWith(".nessy/")) return;

  let st: { mtimeMs: number; size: number };
  try { st = statSync(absTarget); } catch { log("warn", `stat failed for ${relTarget}`); return; }

  const path = cachePathFor(projectRoot, sessionId, agentId);
  const cache = loadCache(path);
  cache.reads = upsertRead(cache.reads, { path: relTarget, mtime_ms: st.mtimeMs, size: st.size });
  cache.session_id = sessionId;
  cache.agent_id = agentId;
  saveCache(path, cache);
  log("debug", `recorded read: ${relTarget}`);

  // Proactive hint (best-effort)
  try {
    const cfg = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8"));
    if (!cfg.hints) return;
    const matched = matchRules(relTarget, cfg.rules);
    if (matched.length === 0) return;
    const known = new Set(cache.reads.map(r => r.path));
    const unread: string[] = [];
    for (const r of matched) for (const req of r.require)
      if (!known.has(req) && !unread.includes(req)) unread.push(req);
    if (unread.length === 0) return;

    const message = [
      `Nessy: You just read \`${relTarget}\`.`,
      `Before you Write or Edit this file (or any other file matching the same rule), read the following:`,
      ...unread.map(p => `  - ${p}`),
      ``,
      `Reading them now means no interrupted writes later.`,
    ].join("\n");
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: message, hookEventName: "PostToolUse" } }));
    log("info", `hint: ${matched.map(r => r.name).join(",")}`);
  } catch (e) {
    log("warn", `hint emission skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main();
