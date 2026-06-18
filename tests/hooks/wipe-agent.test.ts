import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFakeProject, type FakeProject } from "../_support/buildFakeProject.js";
import { runHook } from "../_support/runHook.js";

function seedCacheFile(projectRoot: string, sessionId: string, agentId: string | null): string {
  const filename = agentId === null ? "__root__.json" : `${agentId}.json`;
  const dir = join(projectRoot, ".nessy", "cache", sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify({ version: 1, session_id: sessionId, agent_id: agentId, reads: [] }, null, 2));
  return path;
}

describe("wipe-agent hook", () => {
  let p: FakeProject | undefined;
  afterEach(() => { if (p) p.cleanup(); p = undefined; });

  it("root file deleted on PreCompact (no agent_id)", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n` });
    const rootPath = seedCacheFile(p.projectRoot, "sid", null);
    expect(existsSync(rootPath)).toBe(true);
    const r = runHook("wipe-agent", {
      session_id: "sid",
      cwd: p.projectRoot,
      hook_event_name: "PreCompact",
    }, { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(existsSync(rootPath)).toBe(false);
  });

  it("subagent file deleted on SubagentStop (with agent_id), root preserved", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n` });
    const rootPath = seedCacheFile(p.projectRoot, "sid", null);
    const agentPath = seedCacheFile(p.projectRoot, "sid", "a1");
    expect(existsSync(rootPath)).toBe(true);
    expect(existsSync(agentPath)).toBe(true);
    const r = runHook("wipe-agent", {
      session_id: "sid",
      agent_id: "a1",
      cwd: p.projectRoot,
      hook_event_name: "SubagentStop",
    }, { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(existsSync(agentPath)).toBe(false);
    expect(existsSync(rootPath)).toBe(true);
  });

  it("ENOENT-tolerant on missing file — exits 0", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n` });
    // No cache file seeded
    const r = runHook("wipe-agent", {
      session_id: "sid",
      cwd: p.projectRoot,
      hook_event_name: "PreCompact",
    }, { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
  });

  it("no-op when no .nessy/config.yml — exits 0", () => {
    p = buildFakeProject({ files: { "src/foo.ts": "x" } });
    const r = runHook("wipe-agent", {
      session_id: "sid",
      cwd: p.projectRoot,
      hook_event_name: "PreCompact",
    }, { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
  });
});
