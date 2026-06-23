import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFakeProject, type FakeProject } from "tests/_support/buildFakeProject.js";
import { runHook } from "tests/_support/runHook.js";

function seedCacheFile(projectRoot: string, sessionId: string, filename: string): void {
  const dir = join(projectRoot, ".nessy", "cache", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    JSON.stringify({ version: 1, session_id: sessionId, reads: [] }, null, 2),
  );
}

describe("wipe-session hook", () => {
  let p: FakeProject | undefined;
  afterEach(() => {
    if (p) p.cleanup();
    p = undefined;
  });

  it("removes session dir and all files inside", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n` });
    seedCacheFile(p.projectRoot, "sid", "__root__.json");
    seedCacheFile(p.projectRoot, "sid", "a1.json");
    seedCacheFile(p.projectRoot, "sid", "a2.json");
    const sessionDir = join(p.projectRoot, ".nessy", "cache", "sid");
    expect(existsSync(sessionDir)).toBe(true);
    const r = runHook(
      "features/read-before-write/hooks/wipe-session",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        hook_event_name: "Stop",
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("leaves other session dirs untouched", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n` });
    seedCacheFile(p.projectRoot, "sid1", "__root__.json");
    seedCacheFile(p.projectRoot, "sid2", "__root__.json");
    const sid1Dir = join(p.projectRoot, ".nessy", "cache", "sid1");
    const sid2Dir = join(p.projectRoot, ".nessy", "cache", "sid2");
    expect(existsSync(sid1Dir)).toBe(true);
    expect(existsSync(sid2Dir)).toBe(true);
    const r = runHook(
      "features/read-before-write/hooks/wipe-session",
      {
        session_id: "sid1",
        cwd: p.projectRoot,
        hook_event_name: "Stop",
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect(existsSync(sid1Dir)).toBe(false);
    expect(existsSync(sid2Dir)).toBe(true);
  });

  it("tolerates missing cache dir — exits 0", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n` });
    // No cache dir seeded at all
    const r = runHook(
      "features/read-before-write/hooks/wipe-session",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        hook_event_name: "Stop",
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
  });
});
