import { describe, it, expect } from "vitest";
import { nessyRemove } from "../../src/cli/remove.js";

describe("nessyRemove (noop, Plan 1)", () => {
  it("prints a would-delete message including cwd and returns exit code 0", () => {
    const output: string[] = [];
    const code = nessyRemove((msg) => output.push(msg), "/tmp/example", []);
    expect(code).toBe(0);
    expect(output).toEqual([
      "[nessy remove — noop] would delete .nessy/ at /tmp/example",
    ]);
  });

  it("ignores any flags passed (e.g. --yes) in Plan 1", () => {
    const output: string[] = [];
    const code = nessyRemove((msg) => output.push(msg), "/tmp/example", [
      "--yes",
    ]);
    expect(code).toBe(0);
    expect(output).toEqual([
      "[nessy remove — noop] would delete .nessy/ at /tmp/example",
    ]);
  });
});
