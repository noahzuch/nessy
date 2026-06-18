import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export type FakeProject = { projectRoot: string; cleanup: () => void };
export function buildFakeProject(opts: { config?: string; files?: Record<string, string> }): FakeProject {
  const projectRoot = mkdtempSync(join(tmpdir(), "nessy-fake-"));
  if (opts.config !== undefined) {
    mkdirSync(join(projectRoot, ".nessy"), { recursive: true });
    writeFileSync(join(projectRoot, ".nessy/config.yml"), opts.config);
  }
  for (const [rel, c] of Object.entries(opts.files ?? {})) {
    const full = join(projectRoot, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, c);
  }
  return { projectRoot, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}
