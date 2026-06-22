import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { buildFakeProject, type FakeProject } from "tests/_support/buildFakeProject.js";
import { runHook } from "tests/_support/runHook.js";

describe("block-nessy-dir-writes hook", () => {
  let p: FakeProject | undefined;
  afterEach(() => {
    if (p) p.cleanup();
    p = undefined;
  });

  it("target under .nessy/ → block with self-mod message", () => {
    p = buildFakeProject({ config: "version: 1\nrules: []\n" });
    const target = join(p.projectRoot, ".nessy/config.yml");
    const r = runHook(
      "block-nessy-dir-writes",
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

  it("target outside .nessy/ → allow", () => {
    p = buildFakeProject({
      config: "version: 1\nrules: []\n",
      files: { "src/app.ts": "x" },
    });
    const target = join(p.projectRoot, "src/app.ts");
    const r = runHook(
      "block-nessy-dir-writes",
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
});
