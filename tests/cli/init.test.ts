import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nessyInit } from "src/cli/init.js";

let cwd: string | undefined;
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = undefined;
});

it("creates .nessy/config.yml with template content", () => {
  cwd = mkdtempSync(join(tmpdir(), "nessy-init-test-"));
  const out: string[] = [];
  const code = nessyInit((m) => out.push(m), cwd);
  expect(code).toBe(0);
  const cfgPath = join(cwd, ".nessy", "config.yml");
  expect(existsSync(cfgPath)).toBe(true);
  const content = readFileSync(cfgPath, "utf8");
  expect(content).toContain("version: 1");
  expect(content).toContain("hints: true");
  expect(content).toContain("rules: []");
});

it("refuses when .nessy/ already exists", () => {
  cwd = mkdtempSync(join(tmpdir(), "nessy-init-test-"));
  mkdirSync(join(cwd, ".nessy"));
  const out: string[] = [];
  const code = nessyInit((m) => out.push(m), cwd);
  expect(code).toBe(1);
});
