import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildFakeProject, type FakeProject } from "../_support/buildFakeProject.js";
import { runHook } from "../_support/runHook.js";

const basePayload = (projectRoot: string, prompt: string, extra?: object) => ({
  session_id: "sid",
  cwd: projectRoot,
  hook_event_name: "UserPromptSubmit",
  prompt,
  ...extra,
});

describe("record-at-mention hook", () => {
  let p: FakeProject | undefined;
  afterEach(() => { if (p) p.cleanup(); p = undefined; });

  it("no config → no-op (no cache file created)", () => {
    p = buildFakeProject({ files: { "src/foo.ts": "x" } });
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `look at @src/foo.ts`), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(p.projectRoot, ".nessy/cache/sid/__root__.json"))).toBe(false);
  });

  it("prompt with no @ patterns → no-op", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n`, files: { "src/foo.ts": "x" } });
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `just a plain message`), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(p.projectRoot, ".nessy/cache/sid/__root__.json"))).toBe(false);
  });

  it("happy path: writes cache entry with mtime+size", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n`, files: { "src/foo.ts": "x" } });
    const target = join(p.projectRoot, "src/foo.ts");
    const stat = statSync(target);
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `edit @src/foo.ts for me`), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    const cache = JSON.parse(readFileSync(join(p.projectRoot, ".nessy/cache/sid/__root__.json"), "utf8"));
    expect(cache.reads).toHaveLength(1);
    expect(cache.reads[0]).toMatchObject({ path: "src/foo.ts", mtime_ms: stat.mtimeMs, size: stat.size });
  });

  it("agent_id present → cache file at {aid}.json", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n`, files: { "src/bar.ts": "y" } });
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `@src/bar.ts`, { agent_id: "agent-7" }), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(p.projectRoot, ".nessy/cache/sid/__root__.json"))).toBe(false);
    const cache = JSON.parse(readFileSync(join(p.projectRoot, ".nessy/cache/sid/agent-7.json"), "utf8"));
    expect(cache.reads[0].path).toBe("src/bar.ts");
  });

  it("@ mention of a .nessy/ file → skipped", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n` });
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `look at @.nessy/config.yml`), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(p.projectRoot, ".nessy/cache/sid/__root__.json"))).toBe(false);
  });

  it("@ mention of non-existent file → skipped without error", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n` });
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `check @src/ghost.ts`), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(p.projectRoot, ".nessy/cache/sid/__root__.json"))).toBe(false);
  });

  it("duplicate @ mention → single cache entry", () => {
    p = buildFakeProject({ config: `version: 1\nrules: []\n`, files: { "src/foo.ts": "x" } });
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `@src/foo.ts and @src/foo.ts again`), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    const cache = JSON.parse(readFileSync(join(p.projectRoot, ".nessy/cache/sid/__root__.json"), "utf8"));
    expect(cache.reads).toHaveLength(1);
  });

  it("no matching rule → no hint output", () => {
    p = buildFakeProject({
      config: `version: 1\nhints: true\nrules:\n  - name: docs\n    match: ["docs/**"]\n    require:\n      - README.md\n`,
      files: { "src/foo.ts": "x", "README.md": "r" },
    });
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `@src/foo.ts`), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdoutJson).toBeNull();
  });

  it("matching rule with unread required file → emits additionalContext hint", () => {
    p = buildFakeProject({
      config: `version: 1\nhints: true\nrules:\n  - name: source\n    match: ["src/**"]\n    require:\n      - docs/arch.md\n`,
      files: { "src/foo.ts": "x", "docs/arch.md": "arch" },
    });
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `edit @src/foo.ts`), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdoutJson).toMatchObject({ additionalContext: expect.stringContaining("docs/arch.md") });
  });

  it("matching rule but hints disabled → no hint output", () => {
    p = buildFakeProject({
      config: `version: 1\nhints: false\nrules:\n  - name: source\n    match: ["src/**"]\n    require:\n      - docs/arch.md\n`,
      files: { "src/foo.ts": "x", "docs/arch.md": "arch" },
    });
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `@src/foo.ts`), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdoutJson).toBeNull();
  });

  it("required file already in cache → no hint", () => {
    p = buildFakeProject({
      config: `version: 1\nhints: true\nrules:\n  - name: source\n    match: ["src/**"]\n    require:\n      - docs/arch.md\n`,
      files: { "src/foo.ts": "x", "docs/arch.md": "arch" },
    });
    // Pre-record the required file as already read
    runHook("record-at-mention", basePayload(p.projectRoot, `@docs/arch.md`), { cwd: p.projectRoot });
    // Now mention the source file — required file is already known
    const r = runHook("record-at-mention", basePayload(p.projectRoot, `@src/foo.ts`), { cwd: p.projectRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdoutJson).toBeNull();
  });
});
