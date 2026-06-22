import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStaleness } from "src/lib/staleness.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("checkStaleness", () => {
  it("returns 'missing' for a non-existent file", () => {
    expect(checkStaleness("/nonexistent/path/file.ts", 0, 0)).toBe("missing");
  });

  it("returns 'fresh' when mtime and size match", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nessy-staleness-test-"));
    const p = join(tmpDir, "file.ts");
    writeFileSync(p, "hello");
    const s = statSync(p);
    expect(checkStaleness(p, s.mtimeMs, s.size)).toBe("fresh");
  });

  it("returns 'stale' when size differs", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nessy-staleness-test-"));
    const p = join(tmpDir, "file.ts");
    writeFileSync(p, "hello");
    const s = statSync(p);
    expect(checkStaleness(p, s.mtimeMs, s.size + 1)).toBe("stale");
  });

  it("returns 'stale' when mtime differs", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nessy-staleness-test-"));
    const p = join(tmpDir, "file.ts");
    writeFileSync(p, "hello");
    const s = statSync(p);
    expect(checkStaleness(p, s.mtimeMs + 1, s.size)).toBe("stale");
  });
});
