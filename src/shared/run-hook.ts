import { readFileSync } from "node:fs";
import { z } from "zod";
import { findProjectRoot } from "src/shared/paths.js";
import { parseConfig, type Config } from "src/shared/config.js";
import { configure } from "src/shared/log.js";
import { readAndParsePayload, type BasePayload } from "src/shared/payload.js";

export type RunHookOpts =
  | { requiresProject: false }
  | { requiresProject: true; requiresConfig: false }
  | { requiresProject: true; requiresConfig: true };

type BaseCtx<T> = { payload: T; sessionId: string; agentId: string | undefined };
type NoProjectCtx<T> = BaseCtx<T> & { projectRoot: string | null; cfg: Config | null };
type ProjectCtx<T> = BaseCtx<T> & { projectRoot: string; cfg: Config | null };
type ConfigCtx<T> = BaseCtx<T> & { projectRoot: string; cfg: Config };

export function runHook<T extends BasePayload>(
  name: string,
  schema: z.ZodType<T>,
  opts: { requiresProject: false },
  fn: (ctx: NoProjectCtx<T>) => void,
): void;
export function runHook<T extends BasePayload>(
  name: string,
  schema: z.ZodType<T>,
  opts: { requiresProject: true; requiresConfig: false },
  fn: (ctx: ProjectCtx<T>) => void,
): void;
export function runHook<T extends BasePayload>(
  name: string,
  schema: z.ZodType<T>,
  opts: { requiresProject: true; requiresConfig: true },
  fn: (ctx: ConfigCtx<T>) => void,
): void;
export function runHook<T extends BasePayload>(
  name: string,
  schema: z.ZodType<T>,
  opts: RunHookOpts,
  fn: (ctx: any) => void,
): void {
  const payload = readAndParsePayload(schema);
  const sessionId = payload.session_id;
  const agentId = payload.agent_id;

  let projectRoot: string | null = findProjectRoot(payload.cwd);
  if (opts.requiresProject === true && projectRoot === null) return;

  let cfg: Config | null = null;
  if (projectRoot !== null) {
    try {
      cfg = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8"));
    } catch {}
  }
  configure({
    level: cfg?.log_level ?? "info",
    hookName: name,
    sessionId,
    agentId: agentId ?? null,
  });

  if (
    opts.requiresProject === true &&
    "requiresConfig" in opts &&
    opts.requiresConfig === true &&
    cfg === null
  ) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason:
          "Nessy: configuration error in .nessy/config.yml — ask the user to fix the config before continuing.",
      }),
    );
    return;
  }

  fn({ payload, sessionId, agentId, projectRoot, cfg });
}
