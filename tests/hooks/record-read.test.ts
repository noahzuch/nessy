import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildFakeProject, type FakeProject } from "../_support/buildFakeProject.js";
import { runHook } from "../_support/runHook.js";

describe("record-read hook", () => {
  let p: FakeProject | undefined;
  afterEach(() => {
    if (p) p.cleanup();
    p = undefined;
  });

  it("no config → no-op (no cache file created)", () => {
    p = buildFakeProject({ files: { "src/foo.ts": "x" } });
    const target = join(p.projectRoot, "src/foo.ts");
    const r = runHook(
      "record-read",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Read",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    const cachePath = join(p.projectRoot, ".nessy/cache/sid/__root__.json");
    expect(existsSync(cachePath)).toBe(false);
  });

  it("happy path: writes cache entry with mtime+size", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n`, files: { "src/foo.ts": "x" } });
    const target = join(p.projectRoot, "src/foo.ts");
    const stat = statSync(target);
    const r = runHook(
      "record-read",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Read",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    const cachePath = join(p.projectRoot, ".nessy/cache/sid/__root__.json");
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cache.reads).toHaveLength(1);
    expect(cache.reads[0]).toMatchObject({
      path: "src/foo.ts",
      mtime_ms: stat.mtimeMs,
      size: stat.size,
    });
  });

  it("agent_id present → cache file at {aid}.json", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n`, files: { "src/bar.ts": "y" } });
    const target = join(p.projectRoot, "src/bar.ts");
    const r = runHook(
      "record-read",
      {
        session_id: "sid",
        agent_id: "agent-42",
        cwd: p.projectRoot,
        tool_name: "Read",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    const rootPath = join(p.projectRoot, ".nessy/cache/sid/__root__.json");
    const agentPath = join(p.projectRoot, ".nessy/cache/sid/agent-42.json");
    expect(existsSync(rootPath)).toBe(false);
    expect(existsSync(agentPath)).toBe(true);
    const cache = JSON.parse(readFileSync(agentPath, "utf8"));
    expect(cache.reads).toHaveLength(1);
    expect(cache.reads[0].path).toBe("src/bar.ts");
  });

  it("target under .nessy/ → skipped (no cache file written)", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n` });
    const target = join(p.projectRoot, ".nessy/config.yml");
    const r = runHook(
      "record-read",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Read",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    const cachePath = join(p.projectRoot, ".nessy/cache/sid/__root__.json");
    expect(existsSync(cachePath)).toBe(false);
  });

  it("repeated read of same file → deduped (single entry)", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n`, files: { "src/baz.ts": "z" } });
    const target = join(p.projectRoot, "src/baz.ts");
    const payload = {
      session_id: "sid",
      cwd: p.projectRoot,
      tool_name: "Read",
      tool_input: { file_path: target },
    };
    runHook("record-read", payload, { cwd: p.projectRoot });
    runHook("record-read", payload, { cwd: p.projectRoot });
    const cachePath = join(p.projectRoot, ".nessy/cache/sid/__root__.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cache.reads).toHaveLength(1);
    expect(cache.reads[0].path).toBe("src/baz.ts");
  });
});
