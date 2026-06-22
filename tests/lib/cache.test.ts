import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachePathFor, loadCache, upsertRead, saveCache } from "src/lib/cache.js";
import type { ReadEntry, CacheFile } from "src/lib/cache.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("cachePathFor", () => {
  it("returns __root__.json for null agent_id", () => {
    expect(cachePathFor("/p", "sid", null)).toBe("/p/.nessy/cache/sid/__root__.json");
  });

  it("returns agent file for non-null agent_id", () => {
    expect(cachePathFor("/p", "sid", "a1")).toBe("/p/.nessy/cache/sid/a1.json");
  });
});

describe("loadCache", () => {
  it("returns empty cache for missing file", () => {
    const p = "/nonexistent/path/.nessy/cache/sid/__root__.json";
    const result = loadCache(p);
    expect(result).toEqual({ version: 1, session_id: "sid", agent_id: null, reads: [] });
  });

  it("returns empty cache for corrupted JSON", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nessy-cache-test-"));
    const p = join(tmpDir, "sid", "__root__.json");
    // Create the dir and write garbage JSON
    mkdirSync(join(tmpDir, "sid"), { recursive: true });
    writeFileSync(p, "not json{");
    const result = loadCache(p);
    expect(result).toEqual({ version: 1, session_id: "sid", agent_id: null, reads: [] });
  });
});

describe("saveCache / loadCache round-trip", () => {
  it("save-then-load round-trips", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nessy-cache-test-"));
    const p = join(tmpDir, "sid", "__root__.json");
    const cache: CacheFile = {
      version: 1,
      session_id: "sid",
      agent_id: null,
      reads: [{ path: "/some/file.ts", mtime_ms: 12345, size: 999 }],
    };
    saveCache(p, cache);
    const loaded = loadCache(p);
    expect(loaded).toEqual(cache);
  });
});

describe("upsertRead", () => {
  it("adds a new entry", () => {
    const entry: ReadEntry = { path: "a", mtime_ms: 1, size: 1 };
    expect(upsertRead([], entry)).toEqual([entry]);
  });

  it("replaces existing entry by path", () => {
    const old: ReadEntry = { path: "a", mtime_ms: 1, size: 1 };
    const next: ReadEntry = { path: "a", mtime_ms: 2, size: 2 };
    const result = upsertRead([old], next);
    expect(result).toEqual([next]);
    expect(result).toHaveLength(1);
  });

  it("preserves sibling entries", () => {
    const a: ReadEntry = { path: "a", mtime_ms: 1, size: 1 };
    const b: ReadEntry = { path: "b", mtime_ms: 1, size: 1 };
    const aNew: ReadEntry = { path: "a", mtime_ms: 2, size: 2 };
    const result = upsertRead([a, b], aNew);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.path === "b")).toEqual(b);
    expect(result.find((r) => r.path === "a")).toEqual(aNew);
  });
});

describe("saveCache filesystem", () => {
  it("creates parent dirs and leaves no .tmp.* orphans", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nessy-cache-test-"));
    const p = join(tmpDir, "nested", "deep", "sid", "agent1.json");
    const cache: CacheFile = {
      version: 1,
      session_id: "sid",
      agent_id: "agent1",
      reads: [],
    };
    saveCache(p, cache);
    // File was created
    expect(existsSync(p)).toBe(true);
    // Parent dir was created
    expect(existsSync(join(tmpDir, "nested", "deep", "sid"))).toBe(true);
    // No .tmp.* orphans remain
    const dir = join(tmpDir, "nested", "deep", "sid");
    const files = readdirSync(dir);
    const orphans = files.filter((f) => f.includes(".tmp."));
    expect(orphans).toHaveLength(0);
  });
});
