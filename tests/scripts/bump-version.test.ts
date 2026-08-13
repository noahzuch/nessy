import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The build scripts are plain JS with no declarations, so this import is implicitly
// `any`.
// @ts-expect-error TS7016
import { bumpVersion, applyBump } from "../../scripts/bump-version.mjs";

describe("bumpVersion", () => {
  it("increments patch", () => {
    expect(bumpVersion("0.1.3", "patch")).toBe("0.1.4");
  });

  it("increments minor and resets patch", () => {
    expect(bumpVersion("0.1.3", "minor")).toBe("0.2.0");
  });

  it("increments major and resets minor and patch", () => {
    expect(bumpVersion("0.1.3", "major")).toBe("1.0.0");
  });

  it("throws on a malformed version", () => {
    expect(() => bumpVersion("1.2", "patch")).toThrow();
  });

  it("throws on an invalid level", () => {
    expect(() => bumpVersion("0.1.3", "sideways")).toThrow();
  });
});

describe("applyBump", () => {
  it("writes the bumped version to both plugin.json and package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "nessy-bump-"));
    try {
      mkdirSync(join(root, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "nessy", version: "0.1.3" }, null, 2) + "\n",
      );
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "nessy", version: "0.1.3" }, null, 2) + "\n",
      );

      const next = applyBump(root, "patch");

      expect(next).toBe("0.1.4");
      const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      expect(plugin.version).toBe("0.1.4");
      expect(pkg.version).toBe("0.1.4");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
