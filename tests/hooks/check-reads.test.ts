import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildFakeProject, type FakeProject } from "tests/_support/buildFakeProject.js";
import { runHook } from "tests/_support/runHook.js";

// Helper to seed a cache file pre-populated with read entries
function seedCacheFile(
  projectRoot: string,
  sid: string,
  aid: string | null,
  reads: Array<{ path: string; mtime_ms: number; size: number }>,
): void {
  const file = join(
    projectRoot,
    ".nessy/cache",
    sid,
    aid === null ? "__root__.json" : `${aid}.json`,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ version: 1, session_id: sid, agent_id: aid, reads }, null, 2),
  );
}

describe("check-reads hook", () => {
  let p: FakeProject | undefined;
  afterEach(() => {
    if (p) p.cleanup();
    p = undefined;
  });

  it("no config → allow (exit 0, no stdout decision)", () => {
    p = buildFakeProject({ files: { "src/app.ts": "x" } });
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "check-reads",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Write",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect((r.stdoutJson as any)?.decision).not.toBe("block");
  });

  it("target under .nessy/ → block with self-mod message (before config load)", () => {
    // Config that would otherwise allow — but self-mod check runs before config load
    p = buildFakeProject({
      config: "version: 1\nrules: []\n",
    });
    const target = join(p.projectRoot, ".nessy/config.yml");
    const r = runHook(
      "check-reads",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Edit",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect((r.stdoutJson as any)?.decision).toBe("block");
    expect((r.stdoutJson as any)?.reason).toContain("plugin-managed state");
  });

  it("malformed YAML config → block with parse-error", () => {
    p = buildFakeProject({
      config: "version: 1\nrules: [bad yaml: {\n",
      files: { "src/app.ts": "x" },
    });
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "check-reads",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Write",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect((r.stdoutJson as any)?.decision).toBe("block");
    const reason: string = (r.stdoutJson as any)?.reason ?? "";
    expect(reason.toLowerCase()).toMatch(/configuration error|yaml parse error/);
  });

  it("no rule matches → allow", () => {
    p = buildFakeProject({
      config:
        "version: 1\nrules:\n  - name: guard-docs\n    match: docs/**\n    require:\n      - docs/standards/coding.md\n",
      files: { "src/app.ts": "x" },
    });
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "check-reads",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Write",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect((r.stdoutJson as any)?.decision).not.toBe("block");
  });

  it("missing required read → block (reason contains path + 'not yet read')", () => {
    p = buildFakeProject({
      config:
        "version: 1\nrules:\n  - name: guard-src\n    match: src/**\n    require:\n      - docs/standards/coding.md\n",
      files: {
        "src/app.ts": "x",
        "docs/standards/coding.md": "# coding standards",
      },
    });
    const target = join(p.projectRoot, "src/app.ts");
    // No cache seeded → required file not in cache
    const r = runHook(
      "check-reads",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Write",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect((r.stdoutJson as any)?.decision).toBe("block");
    const reason: string = (r.stdoutJson as any)?.reason ?? "";
    expect(reason).toContain("docs/standards/coding.md");
    expect(reason).toContain("not yet read");
  });

  it("all requires satisfied + fresh → allow", () => {
    p = buildFakeProject({
      config:
        "version: 1\nrules:\n  - name: guard-src\n    match: src/**\n    require:\n      - docs/standards/coding.md\n",
      files: {
        "src/app.ts": "x",
        "docs/standards/coding.md": "# coding standards",
      },
    });
    const reqFile = join(p.projectRoot, "docs/standards/coding.md");
    const stat = statSync(reqFile);
    seedCacheFile(p.projectRoot, "sid", null, [
      { path: "docs/standards/coding.md", mtime_ms: stat.mtimeMs, size: stat.size },
    ]);
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "check-reads",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Write",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect((r.stdoutJson as any)?.decision).not.toBe("block");
  });

  it("stale (mtime/size differs) → block (reason contains 'changed on disk')", () => {
    p = buildFakeProject({
      config:
        "version: 1\nrules:\n  - name: guard-src\n    match: src/**\n    require:\n      - docs/standards/coding.md\n",
      files: {
        "src/app.ts": "x",
        "docs/standards/coding.md": "# coding standards",
      },
    });
    // Seed with stale mtime/size
    seedCacheFile(p.projectRoot, "sid", null, [
      { path: "docs/standards/coding.md", mtime_ms: 1000, size: 999 },
    ]);
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "check-reads",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Edit",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect((r.stdoutJson as any)?.decision).toBe("block");
    const reason: string = (r.stdoutJson as any)?.reason ?? "";
    expect(reason).toContain("changed on disk");
  });

  it("required file deleted from disk → block (config-error message)", () => {
    p = buildFakeProject({
      config:
        "version: 1\nrules:\n  - name: guard-src\n    match: src/**\n    require:\n      - docs/standards/coding.md\n",
      files: {
        "src/app.ts": "x",
        // docs/standards/coding.md intentionally NOT created on disk
      },
    });
    // Seed cache as if it was once read (mtime/size don't matter — file is gone)
    seedCacheFile(p.projectRoot, "sid", null, [
      { path: "docs/standards/coding.md", mtime_ms: 1000, size: 42 },
    ]);
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "check-reads",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Write",
        tool_input: { file_path: target },
      },
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect((r.stdoutJson as any)?.decision).toBe("block");
    const reason: string = (r.stdoutJson as any)?.reason ?? "";
    expect(reason.toLowerCase()).toContain("configuration error");
    expect(reason).toContain("docs/standards/coding.md");
  });
});
