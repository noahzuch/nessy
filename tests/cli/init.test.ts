import { describe, it, expect } from "vitest";
import { nessyInit } from "../../src/cli/init.js";

describe("nessyInit (noop, Plan 1)", () => {
  it("prints a would-create message including cwd and returns exit code 0", () => {
    const output: string[] = [];
    const code = nessyInit((msg) => output.push(msg), "/tmp/example");
    expect(code).toBe(0);
    expect(output).toEqual([
      "[nessy init — noop] would create .nessy/ at /tmp/example",
    ]);
  });
});
