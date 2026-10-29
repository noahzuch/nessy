import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  buildFakeProject,
  buildTempDir,
  type FakeProject,
  type TempDir,
} from "tests/_support/buildFakeProject.js";
import { runHook } from "tests/_support/runHook.js";

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

describe("enforce-read-before-write hook", () => {
  let p: FakeProject | undefined;
  let outside: TempDir | undefined;
  afterEach(() => {
    if (p) p.cleanup();
    if (outside) outside.cleanup();
    p = undefined;
    outside = undefined;
  });

  it("no config → allow (exit 0, no stdout decision)", () => {
    p = buildFakeProject({ files: { "src/app.ts": "x" } });
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "features/read-before-write/hooks/enforce-read-before-write",
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

  it("no rule matches → allow", () => {
    p = buildFakeProject({
      config: {
        rules: [{ name: "guard-docs", match: "docs/**", require: ["docs/standards/coding.md"] }],
      },
      files: { "src/app.ts": "x" },
    });
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "features/read-before-write/hooks/enforce-read-before-write",
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
      config: {
        rules: [{ name: "guard-src", match: "src/**", require: ["docs/standards/coding.md"] }],
      },
      files: {
        "src/app.ts": "x",
        "docs/standards/coding.md": "# coding standards",
      },
    });
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "features/read-before-write/hooks/enforce-read-before-write",
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
      config: {
        rules: [{ name: "guard-src", match: "src/**", require: ["docs/standards/coding.md"] }],
      },
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
      "features/read-before-write/hooks/enforce-read-before-write",
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
      config: {
        rules: [{ name: "guard-src", match: "src/**", require: ["docs/standards/coding.md"] }],
      },
      files: {
        "src/app.ts": "x",
        "docs/standards/coding.md": "# coding standards",
      },
    });
    seedCacheFile(p.projectRoot, "sid", null, [
      { path: "docs/standards/coding.md", mtime_ms: 1000, size: 999 },
    ]);
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "features/read-before-write/hooks/enforce-read-before-write",
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

  it("require above the project root: unread → block, recorded by record-read → allow", () => {
    outside = buildTempDir({ "style.md": "# style" });
    const required = `../${basename(outside.root)}/style.md`;
    p = buildFakeProject({
      config: { rules: [{ name: "guard-src", match: "src/**", require: [required] }] },
      files: { "src/app.ts": "x" },
    });
    const target = join(p.projectRoot, "src/app.ts");
    const write = {
      session_id: "sid",
      cwd: p.projectRoot,
      tool_name: "Write",
      tool_input: { file_path: target },
    };

    const before = runHook("features/read-before-write/hooks/enforce-read-before-write", write, {
      cwd: p.projectRoot,
    });
    expect((before.stdoutJson as any)?.decision).toBe("block");
    expect((before.stdoutJson as any)?.reason).toContain(required);

    runHook(
      "features/read-before-write/hooks/record-read",
      {
        session_id: "sid",
        cwd: p.projectRoot,
        tool_name: "Read",
        tool_input: { file_path: join(outside.root, "style.md") },
      },
      { cwd: p.projectRoot },
    );

    const after = runHook("features/read-before-write/hooks/enforce-read-before-write", write, {
      cwd: p.projectRoot,
    });
    expect(after.exitCode).toBe(0);
    expect((after.stdoutJson as any)?.decision).not.toBe("block");
  });

  it("required file deleted from disk → block (config-error message)", () => {
    p = buildFakeProject({
      config: {
        rules: [{ name: "guard-src", match: "src/**", require: ["docs/standards/coding.md"] }],
      },
      files: { "src/app.ts": "x" },
    });
    seedCacheFile(p.projectRoot, "sid", null, [
      { path: "docs/standards/coding.md", mtime_ms: 1000, size: 42 },
    ]);
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "features/read-before-write/hooks/enforce-read-before-write",
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
