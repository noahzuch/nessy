import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { recordAndHint } from "src/features/read-before-write/lib/record-and-hint.js";
import type { Config } from "src/shared/config.js";
import { configure } from "src/shared/log.js";
import {
  buildFakeProject,
  buildTempDir,
  makeConfig,
  type FakeProject,
  type TempDir,
} from "tests/_support/buildFakeProject.js";

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const PREAMBLE = (relTargets: string[]) => [`preamble:${relTargets.join("|")}`];

/** The indented file-list lines of a hint, i.e. what it actually asks the agent to read. */
const bullets = (message: string | null) =>
  (message ?? "").split("\n").filter((l) => l.startsWith("  - "));

/** Run the helper against `p` with the usual root-session defaults. */
const run = (
  p: FakeProject,
  cfg: Config | null,
  targets: string[],
  opts: { agentId?: string | null } = {},
) =>
  recordAndHint({
    targets,
    projectRoot: p.projectRoot,
    sessionId: "sid",
    agentId: opts.agentId ?? null,
    cfg,
    preamble: PREAMBLE,
  });

const cacheAt = (p: FakeProject, file = "__root__.json") =>
  join(p.projectRoot, ".nessy/cache/sid", file);

const readCache = (p: FakeProject, file?: string) =>
  JSON.parse(readFileSync(cacheAt(p, file), "utf8"));

describe("recordAndHint", () => {
  let p: FakeProject | undefined;
  let outside: TempDir | undefined;

  beforeEach(() => {
    // Keep the helper's warn/debug lines off the test output.
    configure({ level: "error", hookName: "test", sessionId: "sid", agentId: null });
  });

  afterEach(() => {
    if (p) p.cleanup();
    if (outside) outside.cleanup();
    p = undefined;
    outside = undefined;
  });

  describe("recording", () => {
    it("no config → records nothing and emits no hint", () => {
      p = buildFakeProject({ files: { "src/foo.ts": "x" } });
      const r = run(p, null, [join(p.projectRoot, "src/foo.ts")]);
      expect(r).toMatchObject({ recorded: [], unread: [], message: null });
      expect(existsSync(cacheAt(p))).toBe(false);
    });

    it("records a file that appears in a require list", () => {
      p = buildFakeProject({ files: { "src/foo.ts": "x" } });
      const cfg = makeConfig({
        rules: [{ name: "r", match: "other/**", require: ["src/foo.ts"] }],
      });
      const target = join(p.projectRoot, "src/foo.ts");
      const stat = statSync(target);
      const r = run(p, cfg, [target]);
      expect(r.recorded).toEqual(["src/foo.ts"]);
      expect(readCache(p).reads).toEqual([
        { path: "src/foo.ts", mtime_ms: stat.mtimeMs, size: stat.size },
      ]);
    });

    it("file not in any require list → not recorded, no cache file written", () => {
      p = buildFakeProject({ files: { "src/foo.ts": "x", "docs/arch.md": "arch" } });
      const cfg = makeConfig({
        rules: [{ name: "r", match: "src/**", require: ["docs/arch.md"] }],
      });
      const r = run(p, cfg, [join(p.projectRoot, "src/foo.ts")]);
      expect(r.recorded).toEqual([]);
      expect(existsSync(cacheAt(p))).toBe(false);
    });

    it("agentId set → cache written to {aid}.json, not __root__.json", () => {
      p = buildFakeProject({ files: { "src/bar.ts": "y" } });
      const cfg = makeConfig({
        rules: [{ name: "r", match: "other/**", require: ["src/bar.ts"] }],
      });
      run(p, cfg, [join(p.projectRoot, "src/bar.ts")], { agentId: "agent-42" });
      expect(existsSync(cacheAt(p))).toBe(false);
      const cache = readCache(p, "agent-42.json");
      expect(cache.agent_id).toBe("agent-42");
      expect(cache.reads[0].path).toBe("src/bar.ts");
    });

    it("records a required file under .nessy/", () => {
      p = buildFakeProject({ config: { rules: [] } });
      const cfg = makeConfig({
        rules: [{ name: "r", match: "src/**", require: [".nessy/config.yml"] }],
      });
      const r = run(p, cfg, [join(p.projectRoot, ".nessy/config.yml")]);
      expect(r.recorded).toEqual([".nessy/config.yml"]);
    });

    it("records a required file outside the project root as a ../ path", () => {
      outside = buildTempDir({ "style.md": "# style" });
      const required = `../${basename(outside.root)}/style.md`;
      p = buildFakeProject({ files: { "src/foo.ts": "x" } });
      const cfg = makeConfig({ rules: [{ name: "r", match: "src/**", require: [required] }] });
      const target = join(outside.root, "style.md");
      const stat = statSync(target);
      const r = run(p, cfg, [target]);
      expect(r.recorded).toEqual([required]);
      expect(readCache(p).reads[0]).toMatchObject({ mtime_ms: stat.mtimeMs, size: stat.size });
    });

    it("same file recorded twice → single cache entry", () => {
      p = buildFakeProject({ files: { "src/baz.ts": "z" } });
      const cfg = makeConfig({
        rules: [{ name: "r", match: "other/**", require: ["src/baz.ts"] }],
      });
      const target = join(p.projectRoot, "src/baz.ts");
      run(p, cfg, [target]);
      run(p, cfg, [target]);
      expect(readCache(p).reads).toHaveLength(1);
    });

    it("target that cannot be stat'd → reported as skipped, not recorded", () => {
      p = buildFakeProject({ files: { "src/foo.ts": "x" } });
      const cfg = makeConfig({ rules: [{ name: "r", match: "src/**", require: ["src/foo.ts"] }] });
      const r = run(p, cfg, [join(p.projectRoot, "src/ghost.ts")]);
      expect(r.skipped).toEqual(["src/ghost.ts"]);
      expect(r.recorded).toEqual([]);
      expect(r.message).toBeNull();
      expect(existsSync(cacheAt(p))).toBe(false);
    });

    it("one unstattable target does not stop the others", () => {
      p = buildFakeProject({ files: { "src/foo.ts": "x", "docs/arch.md": "arch" } });
      const cfg = makeConfig({
        hints: true,
        rules: [{ name: "r", match: "src/**", require: ["docs/arch.md"] }],
      });
      const r = run(p, cfg, [
        join(p.projectRoot, "src/ghost.ts"),
        join(p.projectRoot, "src/foo.ts"),
      ]);
      expect(r.skipped).toEqual(["src/ghost.ts"]);
      expect(r.unread).toEqual(["docs/arch.md"]);
      expect(r.message).toContain("preamble:src/foo.ts");
    });
  });

  describe("hint", () => {
    it("no matching rule → no message", () => {
      p = buildFakeProject({ files: { "src/foo.ts": "x", "README.md": "r" } });
      const cfg = makeConfig({
        hints: true,
        rules: [{ name: "docs", match: ["docs/**"], require: ["README.md"] }],
      });
      const r = run(p, cfg, [join(p.projectRoot, "src/foo.ts")]);
      expect(r).toMatchObject({ matchedRules: [], unread: [], message: null });
    });

    it("matching rule with unread required file → message lists it between preamble and trailer", () => {
      p = buildFakeProject({ files: { "src/foo.ts": "x", "docs/arch.md": "arch" } });
      const cfg = makeConfig({
        hints: true,
        rules: [{ name: "source", match: ["src/**"], require: ["docs/arch.md"] }],
      });
      const r = run(p, cfg, [join(p.projectRoot, "src/foo.ts")]);
      expect(r.matchedRules).toEqual(["source"]);
      expect(r.unread).toEqual(["docs/arch.md"]);
      expect(r.message?.split("\n")).toEqual([
        "preamble:src/foo.ts",
        "  - docs/arch.md",
        expect.stringContaining("*READ* tool"),
        expect.stringContaining("Skipping even a single read is not an option"),
      ]);
    });

    it("hints disabled → no message, but recording still happens", () => {
      p = buildFakeProject({ files: { "src/foo.ts": "x", "docs/arch.md": "arch" } });
      const cfg = makeConfig({
        hints: false,
        rules: [{ name: "source", match: ["src/**"], require: ["docs/arch.md"] }],
      });
      const r = run(p, cfg, [join(p.projectRoot, "docs/arch.md")]);
      expect(r.message).toBeNull();
      expect(r.recorded).toEqual(["docs/arch.md"]);
    });

    it("required file already in cache → no message", () => {
      p = buildFakeProject({ files: { "src/foo.ts": "x", "docs/arch.md": "arch" } });
      const cfg = makeConfig({
        hints: true,
        rules: [{ name: "source", match: ["src/**"], require: ["docs/arch.md"] }],
      });
      run(p, cfg, [join(p.projectRoot, "docs/arch.md")]);
      const r = run(p, cfg, [join(p.projectRoot, "src/foo.ts")]);
      expect(r.unread).toEqual([]);
      expect(r.message).toBeNull();
    });

    it("lists only the required files that are still unread", () => {
      p = buildFakeProject({
        files: {
          "src/foo.ts": "x",
          "docs/arch.md": "arch",
          "docs/style.md": "style",
          "docs/testing.md": "testing",
        },
      });
      const cfg = makeConfig({
        hints: true,
        rules: [
          {
            name: "source",
            match: ["src/**"],
            require: ["docs/arch.md", "docs/style.md", "docs/testing.md"],
          },
        ],
      });
      run(p, cfg, [join(p.projectRoot, "docs/arch.md"), join(p.projectRoot, "docs/testing.md")]);
      const r = run(p, cfg, [join(p.projectRoot, "src/foo.ts")]);
      expect(r.unread).toEqual(["docs/style.md"]);
      expect(bullets(r.message)).toEqual(["  - docs/style.md"]);
    });

    it("same required file demanded by two matched rules → listed once", () => {
      p = buildFakeProject({ files: { "src/foo.ts": "x", "docs/arch.md": "arch" } });
      const cfg = makeConfig({
        hints: true,
        rules: [
          { name: "source", match: ["src/**"], require: ["docs/arch.md"] },
          { name: "typescript", match: ["**/*.ts"], require: ["docs/arch.md"] },
        ],
      });
      const r = run(p, cfg, [join(p.projectRoot, "src/foo.ts")]);
      expect(r.matchedRules).toEqual(["source", "typescript"]);
      expect(r.unread).toEqual(["docs/arch.md"]);
      expect(occurrences(r.message ?? "", "docs/arch.md")).toBe(1);
    });

    it("multiple targets → one message aggregating every unread required file", () => {
      p = buildFakeProject({
        files: {
          "src/foo.ts": "x",
          "tests/foo.test.ts": "t",
          "docs/arch.md": "arch",
          "docs/testing.md": "testing",
        },
      });
      const cfg = makeConfig({
        hints: true,
        rules: [
          { name: "source", match: ["src/**"], require: ["docs/arch.md"] },
          { name: "tests", match: ["tests/**"], require: ["docs/testing.md"] },
        ],
      });
      const r = run(p, cfg, [
        join(p.projectRoot, "src/foo.ts"),
        join(p.projectRoot, "tests/foo.test.ts"),
      ]);
      expect(r.unread).toEqual(["docs/arch.md", "docs/testing.md"]);
      expect(r.message).toContain("preamble:src/foo.ts|tests/foo.test.ts");
    });

    it("same required file demanded by two targets → listed once", () => {
      p = buildFakeProject({
        files: { "src/foo.ts": "x", "src/bar.ts": "y", "docs/arch.md": "arch" },
      });
      const cfg = makeConfig({
        hints: true,
        rules: [{ name: "source", match: ["src/**"], require: ["docs/arch.md"] }],
      });
      const r = run(p, cfg, [join(p.projectRoot, "src/foo.ts"), join(p.projectRoot, "src/bar.ts")]);
      expect(r.unread).toEqual(["docs/arch.md"]);
      expect(occurrences(r.message ?? "", "docs/arch.md")).toBe(1);
    });

    it.each([
      ["requirement first", ["docs/arch.md", "src/foo.ts"]],
      ["requirement last", ["src/foo.ts", "docs/arch.md"]],
    ])(
      "a target that satisfies another target's requirement suppresses the hint (%s)",
      (_label, order) => {
        p = buildFakeProject({ files: { "src/foo.ts": "x", "docs/arch.md": "arch" } });
        const cfg = makeConfig({
          hints: true,
          rules: [{ name: "source", match: ["src/**"], require: ["docs/arch.md"] }],
        });
        const r = run(
          p,
          cfg,
          order.map((rel) => join(p!.projectRoot, rel)),
        );
        expect(r.recorded).toEqual(["docs/arch.md"]);
        expect(r.unread).toEqual([]);
        expect(r.message).toBeNull();
      },
    );

    it("only the satisfied requirement drops out when several are matched", () => {
      p = buildFakeProject({
        files: { "src/foo.ts": "x", "docs/arch.md": "arch", "docs/style.md": "style" },
      });
      const cfg = makeConfig({
        hints: true,
        rules: [{ name: "source", match: ["src/**"], require: ["docs/arch.md", "docs/style.md"] }],
      });
      const r = run(p, cfg, [
        join(p.projectRoot, "src/foo.ts"),
        join(p.projectRoot, "docs/arch.md"),
      ]);
      expect(r.unread).toEqual(["docs/style.md"]);
      // `docs/arch.md` is a target here, so it still shows up in the preamble — the
      // assertion has to be against the file list the hint asks for.
      expect(bullets(r.message)).toEqual(["  - docs/style.md"]);
    });

    it("required file outside the project root → no rule can match it, so no hint for it", () => {
      outside = buildTempDir({ "style.md": "# style" });
      const required = `../${basename(outside.root)}/style.md`;
      p = buildFakeProject({ files: { "src/foo.ts": "x" } });
      const cfg = makeConfig({
        hints: true,
        rules: [{ name: "r", match: "src/**", require: [required] }],
      });
      const r = run(p, cfg, [join(outside.root, "style.md")]);
      expect(r.matchedRules).toEqual([]);
      expect(r.message).toBeNull();
    });
  });
});
