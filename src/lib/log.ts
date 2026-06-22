export type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let state = {
  level: "info" as Level,
  hookName: "uninitialized",
  sessionId: "",
  agentId: null as string | null,
};

export function configure(opts: {
  level: Level;
  hookName: string;
  sessionId: string;
  agentId: string | null;
}): void {
  state = { ...opts };
}
export function log(level: Level, message: string): void {
  if (RANK[level] < RANK[state.level]) return;
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      hook: state.hookName,
      session_id: state.sessionId,
      agent_id: state.agentId,
      message,
    }) + "\n",
  );
}
