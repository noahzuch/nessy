import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildFakeProject, type FakeProject } from "tests/_support/buildFakeProject.js";
import { runHook } from "tests/_support/runHook.js";

// Recording and hint content are covered by tests/features/read-before-write/record-and-hint.test.ts.
// What is left here is this hook's own wiring: payload handling, project discovery,
// and the PostToolUse output envelope.

const readPayload = (projectRoot: string, filePath: string, extra?: object) => ({
  session_id: "sid",
  cwd: projectRoot,
  tool_name: "Read",
  tool_input: { file_path: filePath },
  ...extra,
});

describe("record-read hook", () => {
  let p: FakeProject | undefined;
  afterEach(() => {
    if (p) p.cleanup();
    p = undefined;
  });

  it("no config → no-op (no cache file created)", () => {
    p = buildFakeProject({ files: { "src/foo.ts": "x" } });
    const r = runHook(
      "features/read-before-write/hooks/record-read",
      readPayload(p.projectRoot, join(p.projectRoot, "src/foo.ts")),
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(p.projectRoot, ".nessy/cache/sid/__root__.json"))).toBe(false);
  });

  it("happy path: records the read and emits the hint as PostToolUse additionalContext", () => {
    // Reading `docs/arch.md` both satisfies the `source` rule (so it is recorded) and
    // matches the `docs` rule (so it draws a hint) — one invocation, both behaviors.
    p = buildFakeProject({
      config: {
        hints: true,
        rules: [
          { name: "source", match: ["src/**"], require: ["docs/arch.md"] },
          { name: "docs", match: ["docs/**"], require: ["docs/conventions.md"] },
        ],
      },
      files: { "docs/arch.md": "arch", "docs/conventions.md": "conv" },
    });
    const r = runHook(
      "features/read-before-write/hooks/record-read",
      readPayload(p.projectRoot, join(p.projectRoot, "docs/arch.md")),
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    const cache = JSON.parse(
      readFileSync(join(p.projectRoot, ".nessy/cache/sid/__root__.json"), "utf8"),
    );
    expect(cache.reads.map((e: { path: string }) => e.path)).toEqual(["docs/arch.md"]);
    expect(r.stdoutJson).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining("docs/conventions.md"),
      },
    });
    // The preamble names the file that was just read.
    const context = (r.stdoutJson as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(context).toContain("You just read `docs/arch.md`");
  });

  it("nothing to hint about → empty stdout", () => {
    p = buildFakeProject({
      config: {
        hints: true,
        rules: [{ name: "docs", match: ["docs/**"], require: ["README.md"] }],
      },
      files: { "src/foo.ts": "x", "README.md": "r" },
    });
    const r = runHook(
      "features/read-before-write/hooks/record-read",
      readPayload(p.projectRoot, join(p.projectRoot, "src/foo.ts")),
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("agent_id from the payload → cache file at {aid}.json", () => {
    p = buildFakeProject({
      config: { rules: [{ name: "r", match: "other/**", require: ["src/bar.ts"] }] },
      files: { "src/bar.ts": "y" },
    });
    const r = runHook(
      "features/read-before-write/hooks/record-read",
      readPayload(p.projectRoot, join(p.projectRoot, "src/bar.ts"), { agent_id: "agent-42" }),
      { cwd: p.projectRoot },
    );
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(p.projectRoot, ".nessy/cache/sid/__root__.json"))).toBe(false);
    const cache = JSON.parse(
      readFileSync(join(p.projectRoot, ".nessy/cache/sid/agent-42.json"), "utf8"),
    );
    expect(cache.reads[0].path).toBe("src/bar.ts");
  });
});
