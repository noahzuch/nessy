import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { runHook } from "tests/_support/runHook.js";

const cwd = tmpdir();

function makePayload(command: string) {
  return {
    session_id: "sid-test",
    cwd,
    tool_name: "Bash" as const,
    tool_input: { command },
  };
}

describe("block-nessy-cli hook", () => {
  it.each([
    ["nessy init"],
    ["nessy remove"],
    ["nessy status"],
    ["./bin/nessy init"],
    ["bin/nessy remove --yes"],
  ])("blocks: %s", (command) => {
    const r = runHook("block-nessy-cli", makePayload(command), { cwd });
    expect(r.exitCode).toBe(0);
    expect((r.stdoutJson as any)?.decision).toBe("block");
  });

  it("allows ordinary commands (ls, git status, npm test)", () => {
    for (const command of ["ls", "git status", "npm test"]) {
      const r = runHook("block-nessy-cli", makePayload(command), { cwd });
      expect(r.exitCode).toBe(0);
      expect((r.stdoutJson as any)?.decision).not.toBe("block");
    }
  });

  it("allows meta commands (nessy --help, nessy --version)", () => {
    for (const command of ["nessy --help", "nessy --version"]) {
      const r = runHook("block-nessy-cli", makePayload(command), { cwd });
      expect(r.exitCode).toBe(0);
      expect((r.stdoutJson as any)?.decision).not.toBe("block");
    }
  });
});
