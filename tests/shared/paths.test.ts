import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot, normalize } from "src/shared/paths.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("findProjectRoot", () => {
  it("returns dir containing .nessy/config.yml", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nessy-paths-"));
    mkdirSync(join(tmpDir, ".nessy"));
    writeFileSync(join(tmpDir, ".nessy", "config.yml"), "");
    expect(findProjectRoot(tmpDir)).toBe(tmpDir);
  });

  it("walks up to find .nessy/config.yml in a parent", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nessy-paths-"));
    mkdirSync(join(tmpDir, ".nessy"));
    writeFileSync(join(tmpDir, ".nessy", "config.yml"), "");
    const child = join(tmpDir, "a", "b", "c");
    mkdirSync(child, { recursive: true });
    expect(findProjectRoot(child)).toBe(tmpDir);
  });

  it("returns null at filesystem root if .nessy/config.yml not found", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nessy-paths-"));
    // No .nessy/config.yml anywhere in tmpDir
    expect(findProjectRoot(tmpDir)).toBeNull();
  });

  it("does NOT match .nessy/ without config.yml", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nessy-paths-"));
    // Create .nessy dir but no config.yml inside
    mkdirSync(join(tmpDir, ".nessy"));
    expect(findProjectRoot(tmpDir)).toBeNull();
  });
});

describe("normalize", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalize("src\\lib\\foo.ts")).toBe("src/lib/foo.ts");
  });

  it("leaves forward slashes unchanged", () => {
    expect(normalize("src/lib/foo.ts")).toBe("src/lib/foo.ts");
  });
});
