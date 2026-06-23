import { relative, resolve } from "node:path";
import { WriteEditHookPayloadSchema } from "src/shared/payload.js";
import { matchRules, unionRequires } from "src/features/read-before-write/lib/matching.js";
import { cachePathFor, loadCache } from "src/features/read-before-write/lib/cache.js";
import { checkStaleness } from "src/features/read-before-write/lib/staleness.js";
import { log } from "src/shared/log.js";
import { normalize } from "src/shared/paths.js";
import { runHook } from "src/shared/run-hook.js";

runHook(
  "enforce-read-before-write",
  WriteEditHookPayloadSchema,
  { requiresProject: true, requiresConfig: true },
  ({ payload, projectRoot, cfg }) => {
    const absTarget = resolve(payload.tool_input.file_path);
    const relTarget = normalize(relative(projectRoot, absTarget));
    if (relTarget.startsWith("..")) return;

    const matched = matchRules(relTarget, cfg.rules);
    if (matched.length === 0) return;
    const required = unionRequires(matched);

    const cache = loadCache(cachePathFor(projectRoot, payload.session_id, payload.agent_id ?? null));
    const byPath = new Map(cache.reads.map((r) => [r.path, r]));

    type Issue = { path: string; status: "missing" | "stale" | "config-error" };
    const issues: Issue[] = [];
    for (const req of required) {
      const entry = byPath.get(req);
      if (!entry) {
        issues.push({ path: req, status: "missing" });
        continue;
      }
      const s = checkStaleness(resolve(projectRoot, req), entry.mtime_ms, entry.size);
      if (s === "missing") issues.push({ path: req, status: "config-error" });
      else if (s === "stale") issues.push({ path: req, status: "stale" });
    }
    if (issues.length === 0) return;

    const block = (reason: string) =>
      process.stdout.write(JSON.stringify({ decision: "block", reason }));

    const configErrs = issues.filter((i) => i.status === "config-error");
    if (configErrs.length > 0) {
      const lines = configErrs
        .map(
          (c) =>
            `  - rule '${matched.find((r) => r.require.includes(c.path))?.name}' requires \`${c.path}\`, which does not exist on disk`,
        )
        .join("\n");
      log("error", `block: config-error (missing files)`);
      return block(
        `Nessy: configuration error in .nessy/config.yml\n\n${lines}\n\nAsk the user to either create those files or remove them from .nessy/config.yml. Do not retry the write.`,
      );
    }

    const names = matched.map((r) => r.name).join(", ");
    const lines = issues.map((i) => {
      const tag =
        i.status === "missing"
          ? "[not yet read this session]"
          : "[changed on disk since you last read it]";
      return `  - ${i.path}      ${tag}`;
    });
    log("info", `block: missing-reads ${issues.map((i) => i.path).join(",")}`);
    return block(
      [
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
      ].join("\n"),
    );
  },
);
