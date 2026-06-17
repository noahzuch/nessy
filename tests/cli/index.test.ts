import { describe, it, expect } from "vitest";
import { dispatch } from "../../src/cli/index.js";

describe("dispatch", () => {
  it("routes 'init' to nessyInit", () => {
    const output: string[] = [];
    const code = dispatch(["init"], (m) => output.push(m), "/tmp/p");
    expect(code).toBe(0);
    expect(output).toEqual([
      "[nessy init — noop] would create .nessy/ at /tmp/p",
    ]);
  });

  it("routes 'remove' to nessyRemove and passes remaining args as flags", () => {
    const output: string[] = [];
    const code = dispatch(
      ["remove", "--yes"],
      (m) => output.push(m),
      "/tmp/p",
    );
    expect(code).toBe(0);
    expect(output).toEqual([
      "[nessy remove — noop] would delete .nessy/ at /tmp/p",
    ]);
  });

  it("prints usage and returns 0 for --help", () => {
    const output: string[] = [];
    const code = dispatch(["--help"], (m) => output.push(m), "/tmp/p");
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("Usage: nessy");
    expect(output.join("\n")).toContain("init");
    expect(output.join("\n")).toContain("remove");
  });

  it("prints usage and returns 0 when no args given", () => {
    const output: string[] = [];
    const code = dispatch([], (m) => output.push(m), "/tmp/p");
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("Usage: nessy");
  });

  it("prints an error and returns 1 for an unknown subcommand", () => {
    const output: string[] = [];
    const code = dispatch(["bogus"], (m) => output.push(m), "/tmp/p");
    expect(code).toBe(1);
    expect(output.join("\n")).toContain("Unknown subcommand: bogus");
  });
});
