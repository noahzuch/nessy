import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { stringify } from "yaml";
import { ConfigSchema, type Config, type ConfigInput } from "src/shared/config.js";

export type TempDir = { root: string; cleanup: () => void };

/**
 * A temp dir seeded with `files` (keys are paths relative to its root).
 */
export function buildTempDir(files: Record<string, string> = {}): TempDir {
  const root = mkdtempSync(join(tmpdir(), "nessy-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A config literal for tests. `version` is always 1, so it can be left out. */
export type TestConfig = Omit<ConfigInput, "version"> & { version?: 1 };

/**
 * Validate a config literal and fill in the schema's defaults (`hints`, `log_level`),
 * yielding the `Config` a hook would have parsed from disk.
 */
export function makeConfig(config: TestConfig): Config {
  return ConfigSchema.parse({ version: 1, ...config });
}

export type FakeProject = { projectRoot: string; cleanup: () => void };

export function buildFakeProject(opts: {
  /** Validated and serialized to `.nessy/config.yml`. Omit to leave the project unconfigured. */
  config?: TestConfig;
  files?: Record<string, string>;
}): FakeProject {
  const { root, cleanup } = buildTempDir({
    ...(opts.config === undefined
      ? {}
      : { ".nessy/config.yml": stringify(makeConfig(opts.config)) }),
    ...opts.files,
  });
  return { projectRoot: root, cleanup };
}
