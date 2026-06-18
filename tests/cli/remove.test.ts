import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nessyRemove } from "../../src/cli/remove.js";

let cwd: string | undefined;
afterEach(() => { if (cwd) rmSync(cwd, { recursive: true, force: true }); cwd = undefined; });

it("noop + exit 0 + 'Nothing to remove' message when .nessy/ does not exist", () => {
  cwd = mkdtempSync(join(tmpdir(), "nessy-remove-test-"));
  const out: string[] = [];
  const code = nessyRemove(m => out.push(m), cwd, {});
  expect(code).toBe(0);
  expect(out.join("\n")).toContain("Nothing to remove");
});

it("removes .nessy/ recursively when called with { yes: true }", () => {
  cwd = mkdtempSync(join(tmpdir(), "nessy-remove-test-"));
  mkdirSync(join(cwd, ".nessy"));
  writeFileSync(join(cwd, ".nessy/config.yml"), "version: 1\nrules: []\n");
  const code = nessyRemove(() => {}, cwd, { yes: true });
  expect(code).toBe(0);
  expect(existsSync(join(cwd, ".nessy"))).toBe(false);
});

it("refuses without --yes in non-TTY, .nessy/ preserved", () => {
  cwd = mkdtempSync(join(tmpdir(), "nessy-remove-test-"));
  mkdirSync(join(cwd, ".nessy"));
  const out: string[] = [];
  const code = nessyRemove(m => out.push(m), cwd, {});
  expect(code).not.toBe(0);
  expect(existsSync(join(cwd, ".nessy"))).toBe(true);
  expect(out.join("\n")).toMatch(/--yes/);
});
