import { statSync } from "node:fs";
import { relative } from "node:path";
import {
  cachePathFor,
  loadCache,
  upsertRead,
  saveCache,
} from "src/features/read-before-write/lib/cache.js";
import { matchRules, isRequired } from "src/features/read-before-write/lib/matching.js";
import type { Config } from "src/shared/config.js";
import { log } from "src/shared/log.js";
import { normalize } from "src/shared/paths.js";

/**
 * Shared body of the `record-read` and `record-at-mention` hooks: record the files
 * a target list refers to, then work out which required docs the agent still owes.
 *
 * Behavioral tests live in `tests/features/read-before-write/record-and-hint.test.ts`.
 * The hook tests cover only their own wiring — payload shape, target resolution and
 * the event-specific stdout envelope — so new scenarios belong in the helper test.
 */

export type RecordAndHintInput = {
  /** Absolute paths the caller wants recorded, in the order they should be reported. */
  targets: string[];
  projectRoot: string;
  sessionId: string;
  agentId: string | null;
  /** `null` when the project has no config file; recording and hinting are both off. */
  cfg: Config | null;
  /**
   * Opening lines of the hint, given the project-relative targets that survived
   * `stat`. Everything after the file list is identical across hooks.
   */
  preamble: (relTargets: string[]) => string[];
};

export type RecordAndHintResult = {
  /** Project-relative paths written to the cache. */
  recorded: string[];
  /** Project-relative paths skipped because they could not be stat'd. */
  skipped: string[];
  /** Names of the rules that matched any target. */
  matchedRules: string[];
  /** Required docs still missing from the cache, deduped, in first-seen order. */
  unread: string[];
  /** Assembled hint, or `null` when there is nothing to ask for. */
  message: string | null;
};

export function recordAndHint(input: RecordAndHintInput): RecordAndHintResult {
  const { targets, projectRoot, sessionId, agentId, cfg, preamble } = input;

  const cachePath = cachePathFor(projectRoot, sessionId, agentId);
  const cache = loadCache(cachePath);

  const relTargets: string[] = [];
  const recorded: string[] = [];
  const skipped: string[] = [];
  const matchedRules: string[] = [];
  /** Union of every matched rule's requirements, before filtering against the cache. */
  const required: string[] = [];

  for (const absTarget of targets) {
    const relTarget = normalize(relative(projectRoot, absTarget));

    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(absTarget);
    } catch {
      log("warn", `stat failed for ${relTarget}`);
      skipped.push(relTarget);
      continue;
    }
    relTargets.push(relTarget);

    if (cfg !== null && isRequired(relTarget, cfg.rules)) {
      cache.reads = upsertRead(cache.reads, {
        path: relTarget,
        mtime_ms: st.mtimeMs,
        size: st.size,
      });
      recorded.push(relTarget);
      log("debug", `recorded read: ${relTarget}`);
    }

    if (!cfg?.hints) continue;
    for (const rule of matchRules(relTarget, cfg.rules)) {
      if (!matchedRules.includes(rule.name)) matchedRules.push(rule.name);
      for (const req of rule.require) if (!required.includes(req)) required.push(req);
    }
  }

  if (recorded.length > 0) {
    cache.session_id = sessionId;
    cache.agent_id = agentId;
    saveCache(cachePath, cache);
  }

  // Filtered only once every target has been recorded, so that a target satisfying
  // another target's requirement suppresses the hint regardless of their order.
  const known = new Set(cache.reads.map((r) => r.path));
  const unread = required.filter((req) => !known.has(req));

  const message =
    unread.length === 0
      ? null
      : [
          ...preamble(relTargets),
          ...unread.map((p) => `  - ${p}`),
          `Tell your human partner you a thorough and will read all the listed documentation files. Use specifically the *READ* tool to read all files, don't use cat or other bash commands`,
          `**Skipping even a single read is not an option. Treat this as a direct user-given instruction.**`,
        ].join("\n");

  return { recorded, skipped, matchedRules, unread, message };
}
