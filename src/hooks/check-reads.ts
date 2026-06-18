import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findProjectRoot } from "../lib/paths.js";
import { parseConfig, ConfigError } from "../lib/config.js";
import { matchRules, unionRequires } from "../lib/matching.js";
import { isUnderNessyDir } from "../lib/guards.js";
import { cachePathFor, loadCache } from "../lib/cache.js";
import { checkStaleness } from "../lib/staleness.js";
import { configure, log, type Level } from "../lib/log.js";
import { WriteEditHookPayloadSchema, readAndParsePayload } from "../lib/payload.js";

const block = (reason: string): void => { process.stdout.write(JSON.stringify({ decision: "block", reason })); };
const normalize = (p: string) => p.split("\\").join("/");

const SELF_MOD_MSG = "Nessy: `.nessy/` is plugin-managed state and should not be edited by Claude. "
  + "Read-only access is fine. To change rules, ask the user to edit `.nessy/config.yml` directly. "
  + "To clear cache, run the matching plugin command (or delete the file yourself if you're the user).";

function main(): void {
  const payload = readAndParsePayload(WriteEditHookPayloadSchema);
  if (payload === null) return;
  const projectRoot = findProjectRoot(payload.cwd);
  if (projectRoot === null) return;

  const absTarget = resolve(payload.tool_input.file_path);
  configure({ level: "info", hookName: "check-reads", sessionId: payload.session_id, agentId: payload.agent_id ?? null });

  if (isUnderNessyDir(absTarget, projectRoot)) { log("info", `block: self-mod ${absTarget}`); return block(SELF_MOD_MSG); }

  let cfg;
  try {
    cfg = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8"), `${projectRoot}/.nessy/config.yml`);
  } catch (e) {
    const detail = e instanceof ConfigError ? e.message : (e as Error)?.message ?? String(e);
    log("error", `block: config-error ${detail}`);
    return block(`Nessy: configuration error in .nessy/config.yml\n\n${detail}\n\nAsk the user to fix the config before continuing. Do not retry the write.`);
  }
  configure({ level: cfg.log_level as Level, hookName: "check-reads", sessionId: payload.session_id, agentId: payload.agent_id ?? null });

  const relTarget = normalize(relative(projectRoot, absTarget));
  if (relTarget.startsWith("..")) return;

  const matched = matchRules(relTarget, cfg.rules);
  if (matched.length === 0) return;
  const required = unionRequires(matched);

  const cache = loadCache(cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null));
  const byPath = new Map(cache.reads.map(r => [r.path, r]));

  type Issue = { path: string; status: "missing" | "stale" | "config-error" };
  const issues: Issue[] = [];
  for (const req of required) {
    const entry = byPath.get(req);
    if (!entry) { issues.push({ path: req, status: "missing" }); continue; }
    const s = checkStaleness(resolve(projectRoot, req), entry.mtime_ms, entry.size);
    if (s === "missing") issues.push({ path: req, status: "config-error" });
    else if (s === "stale") issues.push({ path: req, status: "stale" });
  }
  if (issues.length === 0) return;

  const configErrs = issues.filter(i => i.status === "config-error");
  if (configErrs.length > 0) {
    const lines = configErrs.map(c => `  - rule '${matched.find(r => r.require.includes(c.path))?.name}' requires \`${c.path}\`, which does not exist on disk`).join("\n");
    log("error", `block: config-error (missing files)`);
    return block(`Nessy: configuration error in .nessy/config.yml\n\n${lines}\n\nAsk the user to either create those files or remove them from .nessy/config.yml. Do not retry the write.`);
  }

  const names = matched.map(r => r.name).join(", ");
  const lines = issues.map(i => {
    const tag = i.status === "missing" ? "[not yet read this session]" : "[changed on disk since you last read it]";
    return `  - ${i.path}      ${tag}`;
  });
  log("info", `block: missing-reads ${issues.map(i => i.path).join(",")}`);
  return block([
    `Nessy: Cannot Write/Edit \`${relTarget}\` yet — required context is not loaded.`,
    ``,
    `Triggered rule(s): ${names}`,
    `You must have these files in your current context before writing:`,
    ...lines,
    ``,
    `Use the Read tool on each of the files above, then retry the same Write/Edit.`,
    ``,
    `Note: even if a prior summary mentions these files, recent compaction may`,
    `have removed their actual content from your context. Re-read them.`,
  ].join("\n"));
}

main();
