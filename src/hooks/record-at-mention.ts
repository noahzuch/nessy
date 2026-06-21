import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findProjectRoot } from "../lib/paths.js";
import { cachePathFor, loadCache, upsertRead, saveCache } from "../lib/cache.js";
import { parseConfig } from "../lib/config.js";
import { matchRules } from "../lib/matching.js";
import { configure, log, type Level } from "../lib/log.js";
import { UserPromptSubmitPayloadSchema, readAndParsePayload } from "../lib/payload.js";

const normalize = (p: string) => p.split("\\").join("/");

// Matches @path patterns: @src/foo.ts, @./rel.ts, @../up.ts, @plain.ts
function extractMentions(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of prompt.matchAll(/@([\w./\\-]+)/g)) {
    const p = m[1];
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

function main(): void {
  const payload = readAndParsePayload(UserPromptSubmitPayloadSchema);
  if (payload === null) return;
  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  const sessionId = payload.session_id;
  const agentId = payload.agent_id ?? null;

  let level: Level = "info";
  try { level = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8")).log_level; } catch {}
  configure({ level, hookName: "record-at-mention", sessionId, agentId });

  const mentions = extractMentions(payload.prompt);
  if (mentions.length === 0) return;

  const cachePath = cachePathFor(projectRoot, sessionId, agentId);
  const cache = loadCache(cachePath);

  const allUnread: string[] = [];
  let recorded = 0;

  for (const mention of mentions) {
    const absTarget = resolve(payload.cwd, mention);
    const relTarget = normalize(relative(projectRoot, absTarget));
    if (relTarget.startsWith("..") || relTarget.startsWith(".nessy/")) continue;

    let st: { mtimeMs: number; size: number };
    try { st = statSync(absTarget); } catch { continue; }

    cache.reads = upsertRead(cache.reads, { path: relTarget, mtime_ms: st.mtimeMs, size: st.size });
    recorded++;
    log("debug", `recorded @mention read: ${relTarget}`);

    try {
      const cfg = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8"));
      if (!cfg.hints) continue;
      const matched = matchRules(relTarget, cfg.rules);
      if (matched.length === 0) continue;
      const known = new Set(cache.reads.map(r => r.path));
      for (const r of matched) for (const req of r.require)
        if (!known.has(req) && !allUnread.includes(req)) allUnread.push(req);
    } catch (e) {
      log("warn", `hint collection skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (recorded === 0) return;

  cache.session_id = sessionId;
  cache.agent_id = agentId;
  saveCache(cachePath, cache);

  if (allUnread.length === 0) return;

  const message = [
    `Nessy: The @-mentioned file(s) above match rules that require additional context.`,
    `Before you Write or Edit any matched file, read the following:`,
    ...allUnread.map(p => `  - ${p}`),
    ``,
    `Reading them now means no interrupted writes later.`,
  ].join("\n");
  process.stdout.write(JSON.stringify({ additionalContext: message }));
  log("info", `hint: ${allUnread.join(",")}`);
}

main();
