import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { UserPromptSubmitPayloadSchema } from "src/lib/payload.js";
import { cachePathFor, loadCache, upsertRead, saveCache } from "src/lib/cache.js";
import { matchRules } from "src/lib/matching.js";
import { log } from "src/lib/log.js";
import { normalize } from "src/lib/paths.js";
import { runHook } from "src/lib/run-hook.js";

function extractMentions(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of prompt.matchAll(/@([\w./\\-]+)/g)) {
    const p = m[1];
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

runHook("record-at-mention", UserPromptSubmitPayloadSchema, { requiresProject: true, requiresConfig: false }, ({ payload, projectRoot, cfg }) => {
  const mentions = extractMentions(payload.prompt);
  if (mentions.length === 0) return;

  const cachePath = cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null);
  const cache = loadCache(cachePath);
  const allUnread: string[] = [];
  let recorded = 0;

  for (const mention of mentions) {
    const absTarget = resolve(payload.cwd, mention);
    const relTarget = normalize(relative(projectRoot, absTarget));
    if (relTarget.startsWith("..") || relTarget.startsWith(".nessy/")) continue;

    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(absTarget);
    } catch {
      continue;
    }

    cache.reads = upsertRead(cache.reads, { path: relTarget, mtime_ms: st.mtimeMs, size: st.size });
    recorded++;
    log("debug", `recorded @mention read: ${relTarget}`);

    try {
      if (!cfg?.hints) continue;
      const matched = matchRules(relTarget, cfg.rules);
      if (matched.length === 0) continue;
      const known = new Set(cache.reads.map((r) => r.path));
      for (const r of matched)
        for (const req of r.require)
          if (!known.has(req) && !allUnread.includes(req)) allUnread.push(req);
    } catch (e) {
      log("warn", `hint collection skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (recorded === 0) return;
  cache.session_id = payload.session_id;
  cache.agent_id = payload.agent_id ?? null;
  saveCache(cachePath, cache);

  if (allUnread.length === 0) return;
  const message = [
    `Nessy: The @-mentioned file(s) above match rules that require additional context.`,
    `Before you Write or Edit any matched file, read the following:`,
    ...allUnread.map((p) => `  - ${p}`),
    ``,
    `Reading them now means no interrupted writes later.`,
  ].join("\n");
  process.stdout.write(JSON.stringify({ additionalContext: message }));
  log("info", `hint: ${allUnread.join(",")}`);
});
