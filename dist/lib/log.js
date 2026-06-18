const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
let state = { level: "info", hookName: "uninitialized", sessionId: "", agentId: null };
export function configure(opts) {
    state = { ...opts };
}
export function log(level, message) {
    if (RANK[level] < RANK[state.level])
        return;
    process.stderr.write(JSON.stringify({
        ts: new Date().toISOString(), level,
        hook: state.hookName, session_id: state.sessionId, agent_id: state.agentId, message,
    }) + "\n");
}
//# sourceMappingURL=log.js.map