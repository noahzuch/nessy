import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// connection.mjs is plain JS with no declarations, so this import is implicitly `any`.
// @ts-expect-error TS7016
import * as conn from "../../../.claude/skills/vendor-sync/scripts/connection.mjs";
// git.mjs is plain JS with no declarations, so this import is implicitly `any`.
// @ts-expect-error TS7016
import * as gitm from "../../../.claude/skills/vendor-sync/scripts/git.mjs";
// merge.mjs is plain JS with no declarations, so this import is implicitly `any`.
// @ts-expect-error TS7016
import * as merge from "../../../.claude/skills/vendor-sync/scripts/merge.mjs";
import {
  buildConsumer,
  buildUpstream,
  demoUpstreamFiles,
  establish,
  gitShim,
  indexStages,
  listRefs,
  LONG_A,
  plantUnmerged,
  porcelainV2,
  readManifest,
  type Repo,
  runScript,
  SUBPATH,
} from "./_support/fixtures.js";

function caught(fn: () => unknown): any {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

type Entry = { mode: string; oid: string };
function m(entries: Record<string, string | Entry>): Map<string, Entry> {
  return new Map(
    Object.entries(entries).map(([path, v]) => [
      path,
      typeof v === "string" ? { mode: "100644", oid: v } : v,
    ]),
  );
}

describe("merge.mjs part 1", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "vendor-sync-merge-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("exports the merge refs, plan name and plan version", () => {
    expect(merge.MERGE_REFS).toEqual({
      base: "refs/vendor-base",
      local: "refs/vendor-local",
      upstream: "refs/vendor-upstream",
    });
    expect(Object.isFrozen(merge.MERGE_REFS)).toBe(true);
    expect(merge.PLAN_NAME).toBe("plan.json");
    expect(merge.PLAN_VERSION).toBe(1);
  });

  describe("describeChanges with a base", () => {
    it("upstream modified, local equals base: modified/unchanged", () => {
      expect(merge.describeChanges(m({ "a.md": A }), m({ "a.md": B }), m({ "a.md": A }))).toEqual([
        { path: "a.md", upstream_changes: "modified", local_changes: "unchanged" },
      ]);
    });

    it("local differs from base: modified/modified", () => {
      expect(merge.describeChanges(m({ "a.md": A }), m({ "a.md": B }), m({ "a.md": C }))).toEqual([
        { path: "a.md", upstream_changes: "modified", local_changes: "modified" },
      ]);
    });

    it("local absent: modified/deleted", () => {
      expect(merge.describeChanges(m({ "a.md": A }), m({ "a.md": B }), m({}))).toEqual([
        { path: "a.md", upstream_changes: "modified", local_changes: "deleted" },
      ]);
    });

    it("upstream-only, local absent: added/absent", () => {
      expect(merge.describeChanges(m({}), m({ "a.md": B }), m({}))).toEqual([
        { path: "a.md", upstream_changes: "added", local_changes: "absent" },
      ]);
    });

    it("upstream-only with a different local blob: added/modified", () => {
      expect(merge.describeChanges(m({}), m({ "a.md": B }), m({ "a.md": C }))).toEqual([
        { path: "a.md", upstream_changes: "added", local_changes: "modified" },
      ]);
    });

    it("upstream-only with an identical local blob: not listed", () => {
      expect(merge.describeChanges(m({}), m({ "a.md": B }), m({ "a.md": B }))).toEqual([]);
    });

    it("base has it, upstream lacks it, local has it: deleted", () => {
      expect(merge.describeChanges(m({ "a.md": A }), m({}), m({ "a.md": A }))).toEqual([
        { path: "a.md", upstream_changes: "deleted", local_changes: "unchanged" },
      ]);
      expect(merge.describeChanges(m({ "a.md": A }), m({}), m({ "a.md": C }))).toEqual([
        { path: "a.md", upstream_changes: "deleted", local_changes: "modified" },
      ]);
    });

    it("base has it, upstream and local both lack it: not listed", () => {
      expect(merge.describeChanges(m({ "a.md": A }), m({}), m({}))).toEqual([]);
    });

    it("base and upstream equal: not listed, whatever local holds", () => {
      for (const local of [m({ "a.md": A }), m({ "a.md": C }), m({})]) {
        expect(merge.describeChanges(m({ "a.md": A }), m({ "a.md": A }), local)).toEqual([]);
      }
    });

    it("mode-only difference: listed, as upstream modified", () => {
      const exec = { mode: "100755", oid: A };
      expect(
        merge.describeChanges(m({ "a.md": A }), m({ "a.md": exec }), m({ "a.md": A })),
      ).toEqual([{ path: "a.md", upstream_changes: "modified", local_changes: "unchanged" }]);
      expect(
        merge.describeChanges(m({ "a.md": A }), m({ "a.md": exec }), m({ "a.md": exec })),
      ).toEqual([{ path: "a.md", upstream_changes: "modified", local_changes: "modified" }]);
      expect(merge.describeChanges(m({}), m({ "a.md": exec }), m({ "a.md": A }))).toEqual([
        { path: "a.md", upstream_changes: "added", local_changes: "modified" },
      ]);
      expect(
        merge.describeChanges(m({ "a.md": exec }), m({ "a.md": exec }), m({ "a.md": A })),
      ).toEqual([]);
    });

    it("ignores .vendor.json keys in any map", () => {
      expect(
        merge.describeChanges(
          m({ ".vendor.json": A }),
          m({ ".vendor.json": B }),
          m({ ".vendor.json": C }),
        ),
      ).toEqual([]);
      expect(merge.describeChanges(m({}), m({ ".vendor.json": B }), m({}))).toEqual([]);
      expect(
        merge.describeChanges(m({ ".vendor.json": A }), m({}), m({ ".vendor.json": A })),
      ).toEqual([]);
    });

    it("sorts by byte order, never locale order", () => {
      const upstream = m({ "ä.md": B, "a.md": B, "B.md": B });
      const paths = merge.describeChanges(m({}), upstream, m({})).map((f: any) => f.path);
      expect(paths).toEqual(["B.md", "a.md", "ä.md"]);
    });

    it("sorts by UTF-8 bytes where UTF-16 code units disagree", () => {
      // U+1F600 is a surrogate pair (0xD83D…) in UTF-16 but 0xF0… in UTF-8; U+FF61 is 0xEF… .
      const upstream = m({ "a\u{1F600}.md": B, "a\uFF61.md": B });
      const paths = merge.describeChanges(m({}), upstream, m({})).map((f: any) => f.path);
      expect(paths).toEqual(["a\uFF61.md", "a\u{1F600}.md"]);
    });
  });

  describe("describeChanges without a base", () => {
    it("lists upstream files the local side lacks or holds differently", () => {
      const upstream = m({ "new.md": A, "diff.md": B, "same.md": C });
      const local = m({ "diff.md": C, "same.md": C, "mine.md": A });
      expect(merge.describeChanges(null, upstream, local)).toEqual([
        { path: "diff.md", presence: "both" },
        { path: "new.md", presence: "upstream" },
      ]);
    });

    it("compares oid and mode and ignores the manifest", () => {
      const upstream = m({ "a.md": { mode: "100755", oid: A }, ".vendor.json": B });
      expect(merge.describeChanges(null, upstream, m({ "a.md": A }))).toEqual([
        { path: "a.md", presence: "both" },
      ]);
      const same = m({ "a.md": { mode: "100755", oid: A }, ".vendor.json": B });
      expect(merge.describeChanges(null, upstream, same)).toEqual([]);
    });

    it("sorts by byte order", () => {
      const upstream = m({ "ä.md": B, "a.md": B, "B.md": B });
      const paths = merge.describeChanges(null, upstream, m({})).map((f: any) => f.path);
      expect(paths).toEqual(["B.md", "a.md", "ä.md"]);
    });
  });

  describe("noteIds", () => {
    it("noteIds is no_base without a base and empty with one", () => {
      expect(merge.noteIds(null)).toEqual(["no_base"]);
      expect(merge.noteIds(A)).toEqual([]);
    });

    it("publicFiles is gone", () => {
      expect(merge).not.toHaveProperty("publicFiles");
    });
  });

  describe("AC-22 parseMergeTreeOutput", () => {
    const T = "1".repeat(40);
    const o = (n: number) => String(n).repeat(40);

    it("AC-22 parses captured conflicted output from git 2.54", () => {
      const stdout = Buffer.from(
        `${T}\x00100644 ${o(1)} 1\td/a.md\x00100644 ${o(2)} 2\td/a.md\x00100644 ${o(3)} 3\td/a.md\x00100644 ${o(4)} 2\td/b.md\x00100644 ${o(5)} 3\td/b.md\x00\x00` +
          "1\x00d/a.md\x00Auto-merging\x00Auto-merging d/a.md\n\x00",
        "utf8",
      );
      const res = merge.parseMergeTreeOutput(stdout);
      expect(res.tree).toBe(T);
      expect(res.stageLines).toEqual([
        `100644 ${o(1)} 1\td/a.md`,
        `100644 ${o(2)} 2\td/a.md`,
        `100644 ${o(3)} 3\td/a.md`,
        `100644 ${o(4)} 2\td/b.md`,
        `100644 ${o(5)} 3\td/b.md`,
      ]);
      expect(res.messages.length).toBeGreaterThan(0);
    });

    it("AC-22 parses clean output", () => {
      expect(merge.parseMergeTreeOutput(Buffer.from(`${T}\x00`))).toEqual({
        tree: T,
        stageLines: [],
        messages: [],
      });
    });

    it("AC-22 fails 2 when the first record is not a 40-hex oid", () => {
      const err = caught(() => merge.parseMergeTreeOutput(Buffer.from("not-a-tree\x00")));
      expect(err.exit).toBe(2);
      expect(err.message).toMatch(/unexpected merge-tree output/);
    });

    it("AC-22 fails 2 on a malformed stage record", () => {
      const err = caught(() =>
        merge.parseMergeTreeOutput(Buffer.from(`${T}\x00100644 ${o(1)} 4\td/a.md\x00\x00`)),
      );
      expect(err.exit).toBe(2);
      expect(err.message).toMatch(/unexpected merge-tree stage line/);
    });

    it("AC-22 keeps a path containing a newline intact", () => {
      const line = `100644 ${o(1)} 2\td/x\ny.md`;
      const res = merge.parseMergeTreeOutput(Buffer.from(`${T}\x00${line}\x00\x00`, "utf8"));
      expect(res.stageLines).toEqual([line]);
    });
  });

  describe("plan round trip", () => {
    const plan = {
      version: 1,
      action: "sync",
      base: A,
      target: B,
      touched: [
        { path: "a.md", local_oid: C },
        { path: "new.md", local_oid: null },
      ],
    };

    it("writes the plan as pretty JSON and reads it back", () => {
      const dir = tmp();
      merge.writePlan(dir, plan);
      expect(readFileSync(join(dir, "plan.json"), "utf8")).toBe(
        JSON.stringify(plan, null, 2) + "\n",
      );
      expect(merge.readPlan(dir)).toEqual(plan);
    });

    it("reads back a plan without a base", () => {
      const dir = tmp();
      const noBase = { ...plan, action: "add", base: null };
      merge.writePlan(dir, noBase);
      expect(merge.readPlan(dir)).toEqual(noBase);
    });

    function expectMissing(dir: string) {
      const err = caught(() => merge.readPlan(dir));
      expect(err.exit).toBe(2);
      expect(err.message).toBe(`scratch is missing: ${join(dir, "plan.json")}`);
    }

    it("fails 2 on an absent plan", () => {
      const dir = tmp();
      expect(existsSync(join(dir, "plan.json"))).toBe(false);
      expectMissing(dir);
    });

    it("fails 2 on bad JSON", () => {
      const dir = tmp();
      writeFileSync(join(dir, "plan.json"), "{ not json");
      expectMissing(dir);
    });

    it("fails 2 on version 2", () => {
      const dir = tmp();
      merge.writePlan(dir, { ...plan, version: 2 });
      expectMissing(dir);
    });

    it("fails 2 on a missing touched", () => {
      const dir = tmp();
      const { touched: _touched, ...rest } = plan;
      merge.writePlan(dir, rest);
      expectMissing(dir);
    });

    it("fails 2 on a touched entry without local_oid", () => {
      const dir = tmp();
      merge.writePlan(dir, { ...plan, touched: [{ path: "a.md" }] });
      expectMissing(dir);
    });

    it("reads a plan written with the former files list, ignoring it", () => {
      const dir = tmp();
      const former = { ...plan, files: [{ path: "a.md", presence: "upstream", local_oid: null }] };
      merge.writePlan(dir, former);
      expect(merge.readPlan(dir)).toEqual(former);
    });
  });
});

type Spec = string | { content: string; mode?: "755" } | { symlink: string } | null;
type Side = Record<string, Spec>;

const DIR = "vendored";
const U1 = LONG_A.replace("line1\n", "U1\n");
const L1 = LONG_A.replace("line1\n", "L1\n");
const L8 = LONG_A.replace("line8\n", "L8\n");

// Replaces `<repo>/<dir>` with the given files; `null` entries are skipped.
function writeSide(repo: Repo, dir: string, files: Side): void {
  rmSync(join(repo.root, dir), { recursive: true, force: true });
  for (const [path, spec] of Object.entries(files)) {
    if (spec === null) continue;
    const abs = join(repo.root, dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    if (typeof spec === "string") writeFileSync(abs, spec);
    else if ("symlink" in spec) symlinkSync(spec.symlink, abs);
    else {
      writeFileSync(abs, spec.content);
      if (spec.mode === "755") chmodSync(abs, 0o755);
    }
  }
}

function commitAll(repo: Repo, msg: string): string {
  repo.git("add", "-A");
  repo.git("commit", "-q", "--allow-empty", "-m", msg);
  return repo.git("rev-parse", "HEAD");
}

// One `git status --porcelain=v2` record of the vendored directory as `{ kind, xy, paths }`,
// paths relative to it (a rename record carries the new and the original path).
function parseStatus(line: string): { kind: string; xy: string; paths: string[] } {
  const fields = line.split(" ");
  const kind = fields[0];
  const pathAt: Record<string, number> = { "1": 8, "2": 9, u: 10, "?": 1 };
  const xy = kind === "?" ? "??" : fields[1];
  const rest = fields.slice(pathAt[kind]).join(" ");
  const paths = rest.split("\t").map((p) => p.slice(DIR.length + 1));
  return { kind, xy, paths };
}

function status(repo: Repo): string[] {
  return porcelainV2(repo, DIR).map((line) => {
    const { kind, xy, paths } = parseStatus(line);
    return `${kind} ${xy} ${paths.join("\t")}`;
  });
}

function stages(repo: Repo, path: string): number[] {
  return indexStages(repo, `${DIR}/${path}`).map((s) => s.stage);
}

// Every side also holds `keep.md`, so the upstream directory exists at both commits.
function makeMergeFixture(repos: Repo[]) {
  return function mergeFixture({
    base = {},
    local = {},
    upstream = {},
    withBase = true,
    action = "sync",
  }: {
    base?: Side;
    local?: Side;
    upstream?: Side;
    withBase?: boolean;
    action?: "add" | "sync";
  }) {
    const keep = { "keep.md": "keep\n" };
    const up = buildUpstream({ "README.md": "upstream\n" });
    repos.push(up);
    writeSide(up, SUBPATH, { ...keep, ...base });
    const B = commitAll(up, "upstream: base");
    writeSide(up, SUBPATH, { ...keep, ...upstream });
    const T = commitAll(up, "upstream: target");

    const consumer = buildConsumer();
    repos.push(consumer);
    const root = consumer.root;
    gitm.fetchTracking(up.root, "main", "vendored", root);
    const abs = join(root, DIR);
    const manifest = {
      slug: "vendored",
      repo: up.root,
      path: SUBPATH,
      ref: "main",
      sha: B,
      base_tree: gitm.treeOid(B, SUBPATH, root),
      in_progress: null,
    };
    writeSide(consumer, DIR, { ...keep, ...local });
    // An add finds committed content without a manifest; a sync finds a committed manifest.
    if (action === "sync") conn.writeManifest(abs, manifest);
    commitAll(consumer, "consumer: vendored");

    const writeMarker = (state: string) =>
      conn.writeManifest(abs, {
        ...manifest,
        in_progress: { action, state, target_sha: T },
      });
    const call = (extra: Record<string, unknown> = {}) =>
      merge.stageMerge({
        root,
        rel: DIR,
        abs,
        slug: "vendored",
        action,
        base: withBase ? B : null,
        baseTree: withBase ? gitm.treeOid(B, SUBPATH, root) : gitm.EMPTY_TREE_OID,
        target: T,
        upstreamTree: gitm.treeOid(T, SUBPATH, root),
        writeMarker,
        ...extra,
      });
    return { consumer, B, T, abs, manifest, writeMarker, call };
  };
}

describe("merge.mjs part 2", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });

  const mergeFixture = makeMergeFixture(repos);

  function plan(consumer: Repo) {
    return merge.readPlan(conn.scratchDir(consumer.root, "vendored"));
  }

  const read = (abs: string, path: string) => readFileSync(join(abs, path), "utf8");

  const CONFLICT_L1_U1 =
    "<<<<<<< vendor-local\nL1\n||||||| vendor-base\nline1\n=======\nU1\n>>>>>>> vendor-upstream\n" +
    LONG_A.slice("line1\n".length);

  describe("AC-21 with a base", () => {
    it("AC-21 upstream changed, local unchanged: staged modification", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": U1 },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["1 M. a.md"]);
      expect(stages(f.consumer, "a.md")).toEqual([0]);
      expect(read(f.abs, "a.md")).toBe(U1);
    });

    it("AC-21 both changed, no overlap: merged and staged", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": L8 },
        upstream: { "a.md": U1 },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["1 M. a.md"]);
      expect(stages(f.consumer, "a.md")).toEqual([0]);
      expect(read(f.abs, "a.md")).toBe(U1.replace("line8\n", "L8\n"));
    });

    it("AC-21 both changed, overlapping: conflict with diff3 markers", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": L1 },
        upstream: { "a.md": U1 },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["u UU a.md"]);
      expect(stages(f.consumer, "a.md")).toEqual([1, 2, 3]);
      expect(read(f.abs, "a.md")).toBe(CONFLICT_L1_U1);
    });

    it("AC-21 upstream added: staged addition", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": LONG_A, "n.md": "new\n" },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["1 A. n.md"]);
      expect(stages(f.consumer, "n.md")).toEqual([0]);
      expect(read(f.abs, "n.md")).toBe("new\n");
    });

    it("AC-21 both added, different content: conflict, both added", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A, "n.md": "L\n" },
        upstream: { "a.md": LONG_A, "n.md": "U\n" },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["u AA n.md"]);
      expect(stages(f.consumer, "n.md")).toEqual([2, 3]);
      expect(read(f.abs, "n.md")).toBe(
        "<<<<<<< vendor-local\nL\n||||||| vendor-base\n=======\nU\n>>>>>>> vendor-upstream\n",
      );
    });

    it("AC-21 upstream deleted, local unchanged: staged deletion", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": null },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["1 D. a.md"]);
      expect(stages(f.consumer, "a.md")).toEqual([]);
      expect(existsSync(join(f.abs, "a.md"))).toBe(false);
    });

    it("AC-21 upstream deleted, local changed: conflict, deleted by them", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": L8 },
        upstream: { "a.md": null },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["u UD a.md"]);
      expect(stages(f.consumer, "a.md")).toEqual([1, 2]);
      expect(read(f.abs, "a.md")).toBe(L8);
    });

    it("AC-21 upstream changed, local deleted: conflict, deleted by us", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": null },
        upstream: { "a.md": U1 },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["u DU a.md"]);
      expect(stages(f.consumer, "a.md")).toEqual([1, 3]);
      expect(read(f.abs, "a.md")).toBe(U1);
    });

    it("AC-21 upstream renamed, local edited: the edit follows the rename", () => {
      const f = mergeFixture({
        base: { "old.md": LONG_A },
        local: { "old.md": L8 },
        upstream: { "new.md": LONG_A },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["2 R. new.md\told.md"]);
      expect(stages(f.consumer, "old.md")).toEqual([]);
      expect(stages(f.consumer, "new.md")).toEqual([0]);
      expect(existsSync(join(f.abs, "old.md"))).toBe(false);
      expect(read(f.abs, "new.md")).toBe(L8);
    });

    it("AC-21 binary changed on both sides: conflict, local bytes in the working tree", () => {
      const f = mergeFixture({
        base: { "bin.dat": "\0base\0" },
        local: { "bin.dat": "\0local\0" },
        upstream: { "bin.dat": "\0upstream\0" },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["u UU bin.dat"]);
      expect(stages(f.consumer, "bin.dat")).toEqual([1, 2, 3]);
      expect(readFileSync(join(f.abs, "bin.dat"))).toEqual(Buffer.from("\0local\0"));
    });

    it("AC-21 file became a directory: git renames the local file to x~vendor-local", () => {
      const f = mergeFixture({
        base: { x: LONG_A },
        local: { x: L8 },
        upstream: { "x/inner.md": "inner\n" },
      });
      f.call();
      expect(read(f.abs, "x~vendor-local")).toBe(L8);
      expect(existsSync(join(f.abs, "x~vendor-upstream"))).toBe(false);
      expect(read(f.abs, "x/inner.md")).toBe("inner\n");
    });

    it("AC-21 only local has the file, or both are identical: untouched", () => {
      const f = mergeFixture({
        base: { "same.md": "same\n" },
        local: { "same.md": "same\n", "local-only.md": "mine\n" },
        upstream: { "same.md": "same\n" },
      });
      f.call();
      expect(status(f.consumer)).toEqual([]);
      expect(stages(f.consumer, "same.md")).toEqual([0]);
      expect(stages(f.consumer, "local-only.md")).toEqual([0]);
      expect(read(f.abs, "same.md")).toBe("same\n");
      expect(read(f.abs, "local-only.md")).toBe("mine\n");
    });
  });

  describe("AC-21 without a base", () => {
    // Against the empty base both sides added the file; zdiff3 moves the lines they share out
    // of the block, so it holds only the span from the first to the last differing line.
    const REST = LONG_A.slice("line1\n".length);

    function conflictAA(f: ReturnType<typeof mergeFixture>, path: string) {
      expect(status(f.consumer)).toEqual([`u AA ${path}`]);
      expect(stages(f.consumer, path)).toEqual([2, 3]);
    }

    it("AC-21 no base, upstream changed, local unchanged: conflict, both added", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": U1 },
      });
      f.call();
      conflictAA(f, "a.md");
      expect(read(f.abs, "a.md")).toBe(
        "<<<<<<< vendor-local\nline1\n||||||| vendor-base\n=======\nU1\n>>>>>>> vendor-upstream\n" +
          REST,
      );
    });

    it("AC-21 no base, both changed, no overlap: conflict, both added", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "a.md": LONG_A },
        local: { "a.md": L8 },
        upstream: { "a.md": U1 },
      });
      f.call();
      conflictAA(f, "a.md");
      // The differing lines are the first and the last, so the block spans the whole file.
      expect(read(f.abs, "a.md")).toBe(
        "<<<<<<< vendor-local\n" +
          L8 +
          "||||||| vendor-base\n=======\n" +
          U1 +
          ">>>>>>> vendor-upstream\n",
      );
    });

    it("AC-21 no base, both changed, overlapping: conflict, both added", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "a.md": LONG_A },
        local: { "a.md": L1 },
        upstream: { "a.md": U1 },
      });
      f.call();
      conflictAA(f, "a.md");
      expect(read(f.abs, "a.md")).toBe(
        "<<<<<<< vendor-local\nL1\n||||||| vendor-base\n=======\nU1\n>>>>>>> vendor-upstream\n" +
          REST,
      );
    });

    it("AC-21 no base, one differing line: the conflict block holds only that line", () => {
      const L4 = LONG_A.replace("line4\n", "L4\n");
      const U4 = LONG_A.replace("line4\n", "U4\n");
      const f = mergeFixture({
        withBase: false,
        base: { "a.md": LONG_A },
        local: { "a.md": L4 },
        upstream: { "a.md": U4 },
      });
      f.call();
      conflictAA(f, "a.md");
      expect(read(f.abs, "a.md")).toBe(
        "line1\nline2\nline3\n" +
          "<<<<<<< vendor-local\nL4\n||||||| vendor-base\n=======\nU4\n>>>>>>> vendor-upstream\n" +
          "line5\nline6\nline7\nline8\n",
      );
    });

    it("AC-21 no base, upstream added: staged addition", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": LONG_A, "n.md": "new\n" },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["1 A. n.md"]);
      expect(stages(f.consumer, "n.md")).toEqual([0]);
      expect(read(f.abs, "n.md")).toBe("new\n");
    });

    it("AC-21 no base, both added, different content: conflict, both added", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A, "n.md": "L\n" },
        upstream: { "a.md": LONG_A, "n.md": "U\n" },
      });
      f.call();
      conflictAA(f, "n.md");
      expect(read(f.abs, "n.md")).toBe(
        "<<<<<<< vendor-local\nL\n||||||| vendor-base\n=======\nU\n>>>>>>> vendor-upstream\n",
      );
    });

    it("AC-21 no base, upstream deleted, local unchanged: the file stays", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": null },
      });
      f.call();
      expect(status(f.consumer)).toEqual([]);
      expect(stages(f.consumer, "a.md")).toEqual([0]);
      expect(read(f.abs, "a.md")).toBe(LONG_A);
    });

    it("AC-21 no base, upstream deleted, local changed: the file stays", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "a.md": LONG_A },
        local: { "a.md": L8 },
        upstream: { "a.md": null },
      });
      f.call();
      expect(status(f.consumer)).toEqual([]);
      expect(stages(f.consumer, "a.md")).toEqual([0]);
      expect(read(f.abs, "a.md")).toBe(L8);
    });

    it("AC-21 no base, upstream changed, local deleted: upstream's file is added", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "a.md": LONG_A },
        local: { "a.md": null },
        upstream: { "a.md": U1 },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["1 A. a.md"]);
      expect(stages(f.consumer, "a.md")).toEqual([0]);
      expect(read(f.abs, "a.md")).toBe(U1);
    });

    it("AC-21 no base, upstream renamed: the local file stays, the new name is added", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "old.md": LONG_A },
        local: { "old.md": L8 },
        upstream: { "new.md": LONG_A },
      });
      f.call();
      expect(status(f.consumer)).toEqual(["1 A. new.md"]);
      expect(stages(f.consumer, "old.md")).toEqual([0]);
      expect(stages(f.consumer, "new.md")).toEqual([0]);
      expect(read(f.abs, "old.md")).toBe(L8);
      expect(read(f.abs, "new.md")).toBe(LONG_A);
    });

    it("AC-21 no base, binary changed on both sides: conflict, local bytes", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "bin.dat": "\0base\0" },
        local: { "bin.dat": "\0local\0" },
        upstream: { "bin.dat": "\0upstream\0" },
      });
      f.call();
      conflictAA(f, "bin.dat");
      expect(readFileSync(join(f.abs, "bin.dat"))).toEqual(Buffer.from("\0local\0"));
    });

    it("AC-21 no base, file became a directory: git renames the local file to x~vendor-local", () => {
      const f = mergeFixture({
        withBase: false,
        base: { x: LONG_A },
        local: { x: L8 },
        upstream: { "x/inner.md": "inner\n" },
      });
      f.call();
      expect(read(f.abs, "x~vendor-local")).toBe(L8);
      expect(existsSync(join(f.abs, "x~vendor-upstream"))).toBe(false);
      expect(read(f.abs, "x/inner.md")).toBe("inner\n");
    });

    it("AC-21 no base, only local has the file, or both are identical: untouched", () => {
      const f = mergeFixture({
        withBase: false,
        base: { "same.md": "same\n" },
        local: { "same.md": "same\n", "local-only.md": "mine\n" },
        upstream: { "same.md": "same\n" },
      });
      f.call();
      expect(status(f.consumer)).toEqual([]);
      expect(stages(f.consumer, "same.md")).toEqual([0]);
      expect(stages(f.consumer, "local-only.md")).toEqual([0]);
      expect(read(f.abs, "same.md")).toBe("same\n");
      expect(read(f.abs, "local-only.md")).toBe("mine\n");
    });
  });

  it("AC-22 an overlapping change ends unmerged with diff3 markers", () => {
    const f = mergeFixture({
      base: { "a.md": LONG_A },
      local: { "a.md": L1 },
      upstream: { "a.md": U1 },
    });
    f.call();
    expect(f.consumer.git("ls-files", "-u", "--", `${DIR}/a.md`)).not.toBe("");
    expect(porcelainV2(f.consumer, DIR).some((l) => l.startsWith("u UU "))).toBe(true);
    const lines = read(f.abs, "a.md").split("\n");
    const at = [
      "<<<<<<< vendor-local",
      "||||||| vendor-base",
      "=======",
      ">>>>>>> vendor-upstream",
    ].map((marker) => lines.indexOf(marker));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("AC-23 an executable keeps 100755 and a symlink stays a symlink", () => {
    const f = mergeFixture({
      base: { "run.sh": "echo hi\n" },
      local: { "run.sh": "echo hi\n" },
      upstream: { "run.sh": { content: "echo hi\n", mode: "755" }, link: { symlink: "run.sh" } },
    });
    f.call();
    expect(indexStages(f.consumer, `${DIR}/run.sh`)).toEqual([
      expect.objectContaining({ mode: "100755", stage: 0 }),
    ]);
    expect(indexStages(f.consumer, `${DIR}/link`)).toEqual([
      expect.objectContaining({ mode: "120000", stage: 0 }),
    ]);
    expect(statSync(join(f.abs, "run.sh")).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(f.abs, "link"))).toBe("run.sh");
  });

  describe("AC-24 file and directory collisions", () => {
    function expectAllTouched(f: ReturnType<typeof mergeFixture>) {
      const touched = new Set(plan(f.consumer).touched.map((t: any) => t.path));
      const differing = porcelainV2(f.consumer, DIR).flatMap((line) => parseStatus(line).paths);
      expect(differing.length).toBeGreaterThan(0);
      for (const path of differing) expect(touched, path).toContain(path);
    }

    it("AC-24 file became a directory while local changed the file", () => {
      const f = mergeFixture({
        base: { x: LONG_A },
        local: { x: L8 },
        upstream: { "x/inner.md": "inner\n" },
      });
      expect(() => f.call()).not.toThrow();
      expect(read(f.abs, "x~vendor-local")).toBe(L8);
      expect(existsSync(join(f.abs, "x~vendor-upstream"))).toBe(false);
      expectAllTouched(f);
    });

    it("AC-24 directory became a file while local changed a child", () => {
      const f = mergeFixture({
        base: { "x/inner.md": LONG_A },
        local: { "x/inner.md": L8 },
        upstream: { x: "file\n" },
      });
      expect(() => f.call()).not.toThrow();
      expect(read(f.abs, "x~vendor-upstream")).toBe("file\n");
      expect(existsSync(join(f.abs, "x~vendor-local"))).toBe(false);
      expectAllTouched(f);
    });
  });

  it("AC-25 an upstream manifest leaves the local manifest untouched", () => {
    const f = mergeFixture({
      base: { ".vendor.json": '{ "upstream": "base" }\n', "a.md": LONG_A },
      local: { "a.md": LONG_A },
      upstream: { ".vendor.json": '{ "upstream": "target" }\n', "a.md": U1 },
    });
    let last = "";
    f.call({
      writeMarker: (state: string) => {
        f.writeMarker(state);
        last = read(f.abs, ".vendor.json");
      },
    });
    expect(read(f.abs, ".vendor.json")).toBe(last);
    expect(JSON.parse(last).in_progress.state).toBe("merge_staged");
    expect(f.consumer.git("ls-files", "-u", "--", DIR)).not.toContain(".vendor.json");
    const p = plan(f.consumer);
    expect(p).not.toHaveProperty("files");
    expect(p.touched.map((e: any) => e.path)).not.toContain(".vendor.json");
  });

  it("AC-26 the plan exists and the directory is unchanged when the marker opens", () => {
    const f = mergeFixture({
      base: { "a.md": LONG_A, "gone.md": "gone\n" },
      local: { "a.md": L1, "gone.md": "gone\n" },
      upstream: { "a.md": U1, "n.md": "new\n" },
    });
    const calls: string[] = [];
    const facts: { plan?: any; status?: string; oidsMatch?: boolean } = {};
    f.call({
      writeMarker: (state: string) => {
        calls.push(state);
        if (state === "merging") {
          facts.plan = plan(f.consumer);
          facts.status = f.consumer.git("status", "--porcelain", "--", DIR);
          facts.oidsMatch = facts.plan.touched
            .filter((t: any) => t.local_oid !== null)
            .every(
              (t: any) => t.local_oid === f.consumer.git("rev-parse", `HEAD:${DIR}/${t.path}`),
            );
        }
        f.writeMarker(state);
      },
    });
    expect(calls).toEqual(["merging", "merge_staged"]);
    expect(facts.plan.touched.map((t: any) => t.path)).toEqual(["a.md", "gone.md", "n.md"]);
    expect(facts.plan.touched.find((t: any) => t.path === "n.md").local_oid).toBeNull();
    expect(facts.status).toBe("");
    expect(facts.oidsMatch).toBe(true);
  });

  it("with an empty local tree and stagedState ready writes upstream and ends at ready", () => {
    const f = mergeFixture({ action: "add", withBase: false, upstream: { "n/x.md": "new\n" } });
    const calls: string[] = [];
    f.call({
      localTree: gitm.EMPTY_TREE_OID,
      stagedState: "ready",
      writeMarker: (state: string) => {
        calls.push(state);
        f.writeMarker(state);
      },
    });
    expect(calls).toEqual(["merging", "ready"]);
    expect(f.consumer.git("diff", "--cached", "--name-only", "--", DIR)).toBe(`${DIR}/n/x.md`);
    expect(read(f.abs, "n/x.md")).toBe("new\n");
    expect(plan(f.consumer).touched).toEqual([
      { path: "keep.md", local_oid: f.consumer.git("rev-parse", `HEAD:${DIR}/keep.md`) },
      { path: "n/x.md", local_oid: null },
    ]);
  });

  describe("AC-5 temporary refs", () => {
    function expectRefsGone(f: ReturnType<typeof mergeFixture>, heads: string[], main: string) {
      expect(listRefs(f.consumer, "refs/vendor-*")).toEqual([]);
      expect(listRefs(f.consumer, "refs/heads/")).toEqual(heads);
      expect(f.consumer.git("rev-parse", "refs/heads/main")).toBe(main);
    }
    function snapshot(f: ReturnType<typeof mergeFixture>): [string[], string] {
      return [listRefs(f.consumer, "refs/heads/"), f.consumer.git("rev-parse", "refs/heads/main")];
    }

    it("AC-5 a clean merge leaves no temporary ref", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": U1 },
      });
      const before = snapshot(f);
      f.call();
      expectRefsGone(f, ...before);
    });

    it("AC-5 a conflicted merge leaves no temporary ref", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": L1 },
        upstream: { "a.md": U1 },
      });
      const before = snapshot(f);
      f.call();
      expectRefsGone(f, ...before);
    });

    it("AC-5 a failing merge-tree fails 2 and leaves no temporary ref", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": L1 },
        upstream: { "a.md": U1 },
      });
      const before = snapshot(f);
      const shim = gitShim({ failOn: ["-c", "merge.conflictStyle=zdiff3", "merge-tree"] });
      const savedPath = process.env.PATH;
      const savedFail = process.env.SHIM_FAIL;
      let err: any;
      try {
        process.env.PATH = shim.env.PATH;
        process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
        err = caught(() => f.call());
      } finally {
        process.env.PATH = savedPath;
        if (savedFail === undefined) delete process.env.SHIM_FAIL;
        else process.env.SHIM_FAIL = savedFail;
        shim.cleanup();
      }
      expect(err.exit).toBe(2);
      expect(err.message).toBe("git merge-tree failed");
      expectRefsGone(f, ...before);
    });

    it("AC-5 stale temporary refs from a crashed run are overwritten and deleted", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": U1 },
      });
      for (const ref of ["refs/vendor-base", "refs/vendor-local", "refs/vendor-upstream"]) {
        f.consumer.git("update-ref", ref, "HEAD");
      }
      const before = snapshot(f);
      f.call();
      expectRefsGone(f, ...before);
      expect(status(f.consumer)).toEqual(["1 M. a.md"]);
    });
  });

  describe("AC-38 untracked files at paths the merge writes", () => {
    // Ignore rules in .git/info/exclude leave the committed tree untouched.
    function ignore(f: ReturnType<typeof mergeFixture>, ...patterns: string[]) {
      writeFileSync(join(f.consumer.root, ".git/info/exclude"), patterns.join("\n") + "\n");
    }
    function untouched(f: ReturnType<typeof mergeFixture>) {
      return {
        manifest: read(f.abs, ".vendor.json"),
        index: f.consumer.git("ls-files", "-s"),
        status: f.consumer.git("status", "--porcelain=v2", "--untracked-files=all", "--ignored"),
      };
    }
    function expectCollision(f: ReturnType<typeof mergeFixture>, paths: string) {
      const before = untouched(f);
      let marked = false;
      const err = caught(() => f.call({ writeMarker: () => (marked = true) }));
      expect(err.exit).toBe(2);
      expect(err.message).toBe(`${DIR} holds files upstream would overwrite: ${paths}`);
      expect(err.hint).toBe(`move them out of ${DIR}, then re-run`);
      expect(marked).toBe(false);
      expect(untouched(f)).toEqual(before);
      expect(existsSync(conn.scratchDir(f.consumer.root, "vendored"))).toBe(false);
      expect(listRefs(f.consumer, "refs/vendor-*")).toEqual([]);
    }

    it("an ignored file at an upstream-added path stops the merge before any write", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": U1, "new.log": "up\n", "z.log": "up\n" },
      });
      ignore(f, "*.log");
      writeFileSync(join(f.abs, "new.log"), "MINE\n");
      writeFileSync(join(f.abs, "z.log"), "MINE TOO\n");
      expectCollision(f, "new.log, z.log");
      expect(read(f.abs, "new.log")).toBe("MINE\n");
      expect(read(f.abs, "a.md")).toBe(LONG_A);
    });

    it("an ignored file on the parent chain of an upstream-added path stops the merge", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": LONG_A, "out/n.md": "new\n" },
      });
      ignore(f, "out");
      writeFileSync(join(f.abs, "out"), "MINE\n");
      expectCollision(f, "out");
      expect(read(f.abs, "out")).toBe("MINE\n");
    });

    it("an ignored file at a ~vendor-local side name stops the merge", () => {
      const f = mergeFixture({
        base: { x: LONG_A },
        local: { x: L8 },
        upstream: { "x/inner.md": "inner\n" },
      });
      ignore(f, "*~vendor-local");
      writeFileSync(join(f.abs, "x~vendor-local"), "MINE\n");
      expectCollision(f, "x~vendor-local");
      expect(read(f.abs, "x~vendor-local")).toBe("MINE\n");
    });

    it("an ignored file at a path the merge leaves alone does not stop it", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": LONG_A },
        upstream: { "a.md": U1, "new.log": "up\n" },
      });
      ignore(f, "*.log");
      writeFileSync(join(f.abs, "other.log"), "MINE\n");
      f.call();
      expect(status(f.consumer)).toEqual(["1 A. new.log", "1 M. a.md"]);
      expect(read(f.abs, "other.log")).toBe("MINE\n");
    });
  });
});

describe("AC-38 requireNoCollisions and core.ignorecase", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  function onDisk(ignorecase: boolean) {
    const repo = buildConsumer();
    repos.push(repo);
    repo.git("config", "core.ignorecase", String(ignorecase));
    repo.write({ "d/README.md": "mine\n" });
    return { repo, abs: join(repo.root, "d") };
  }

  it("with core.ignorecase false a name that differs only in case is no collision", () => {
    const { repo, abs } = onDisk(false);
    expect(() =>
      merge.requireNoCollisions("d", abs, ["readme.md"], new Set(), repo.root),
    ).not.toThrow();
    const err = caught(() =>
      merge.requireNoCollisions("d", abs, ["README.md"], new Set(), repo.root),
    );
    expect(err.message).toBe("d holds files upstream would overwrite: README.md");
  });

  it("with core.ignorecase true it is one, unless a tracked path matches it up to case", () => {
    const { repo, abs } = onDisk(true);
    const err = caught(() =>
      merge.requireNoCollisions("d", abs, ["readme.md"], new Set(), repo.root),
    );
    expect(err.message).toBe("d holds files upstream would overwrite: README.md");
    expect(() =>
      merge.requireNoCollisions("d", abs, ["readme.md"], new Set(["Readme.md"]), repo.root),
    ).not.toThrow();
  });
});

describe("merge.mjs part 3", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });

  const mergeFixture = makeMergeFixture(repos);
  const scratchOf = (repo: Repo) => conn.scratchDir(repo.root, "vendored");
  const planOf = (repo: Repo) => merge.readPlan(scratchOf(repo));
  const statusOf = (repo: Repo) => repo.git("status", "--porcelain", "--", DIR);

  // Runs `fn` with a git shim that refuses `failOn` first on PATH.
  function withShim(failOn: string[], fn: () => unknown): unknown {
    const shim = gitShim({ failOn });
    const savedPath = process.env.PATH;
    const savedFail = process.env.SHIM_FAIL;
    try {
      process.env.PATH = shim.env.PATH;
      process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
      return fn();
    } finally {
      process.env.PATH = savedPath;
      if (savedFail === undefined) delete process.env.SHIM_FAIL;
      else process.env.SHIM_FAIL = savedFail;
      shim.cleanup();
    }
  }

  describe("abortMerge", () => {
    it("restores exactly the touched paths and reports the debris it leaves", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A, "m.md": "m\n" },
        local: { "a.md": L1, "m.md": "m\n" },
        upstream: { "a.md": U1, "m.md": "m2\n", "n.md": "new\n" },
      });
      f.call();
      expect(f.consumer.git("ls-files", "-u", "--", `${DIR}/a.md`)).not.toBe("");
      // The user's edits between the calls.
      writeFileSync(join(f.abs, "a.md"), "resolved\n");
      chmodSync(join(f.abs, "n.md"), 0o755);
      writeFileSync(join(f.abs, "a.md.orig"), "backup\n");

      const res = merge.abortMerge({
        root: f.consumer.root,
        rel: DIR,
        plan: planOf(f.consumer),
      });
      // Clearing the marker is abortAction's job; put the manifest back to see the rest.
      conn.writeManifest(f.abs, f.manifest);

      expect(statusOf(f.consumer)).toBe(`?? ${DIR}/a.md.orig`);
      expect(res).toEqual({ restored: ["a.md", "m.md"], removed: ["n.md"], left: ["a.md.orig"] });
      expect(readFileSync(join(f.abs, "a.md"), "utf8")).toBe(L1);
      expect(existsSync(join(f.abs, "n.md"))).toBe(false);
      expect(readFileSync(join(f.abs, "a.md.orig"), "utf8")).toBe("backup\n");
    });

    it("removes the directories its created files emptied, and keeps any that hold more", () => {
      const f = mergeFixture({ upstream: { "n/deep/x.md": "x\n", "m/y.md": "y\n" } });
      f.call();
      writeFileSync(join(f.abs, "m", "mine.txt"), "mine\n");
      const res = merge.abortMerge({
        root: f.consumer.root,
        rel: DIR,
        plan: planOf(f.consumer),
      });
      expect(res).toEqual({
        restored: [],
        removed: ["m/y.md", "n/deep/x.md"],
        left: ["m/mine.txt"],
      });
      expect(existsSync(join(f.abs, "n"))).toBe(false);
      expect(readFileSync(join(f.abs, "m/mine.txt"), "utf8")).toBe("mine\n");
    });

    it("runs no git checkout when every touched path was created", () => {
      const f = mergeFixture({ upstream: { "n.md": "new\n" } });
      f.call();
      const plan = planOf(f.consumer);
      expect(plan.touched).toEqual([{ path: "n.md", local_oid: null }]);
      const res: any = withShim(["checkout"], () =>
        merge.abortMerge({ root: f.consumer.root, rel: DIR, plan }),
      );
      expect(res).toEqual({ restored: [], removed: ["n.md"], left: [] });
      expect(existsSync(join(f.abs, "n.md"))).toBe(false);
    });

    it("runs no git clean when every touched path existed", () => {
      const f = mergeFixture({
        base: { "m.md": "m\n" },
        local: { "m.md": "m\n" },
        upstream: { "m.md": "m2\n" },
      });
      f.call();
      const plan = planOf(f.consumer);
      expect(plan.touched.every((t: any) => t.local_oid !== null)).toBe(true);
      const res: any = withShim(["clean"], () =>
        merge.abortMerge({ root: f.consumer.root, rel: DIR, plan }),
      );
      expect(res).toEqual({ restored: ["m.md"], removed: [], left: [] });
      expect(readFileSync(join(f.abs, "m.md"), "utf8")).toBe("m\n");
    });
  });

  it("leftovers excludes the touched paths and .vendor.json", () => {
    const consumer = buildConsumer();
    repos.push(consumer);
    writeSide(consumer, DIR, {
      "a.md": "a\n",
      "b.md": "b\n",
      "sub/c.md": "c\n",
      ".vendor.json": "{}\n",
    });
    const res = merge.leftovers({
      root: consumer.root,
      rel: DIR,
      touched: [
        { path: "a.md", local_oid: null },
        { path: "sub/c.md", local_oid: null },
      ],
    });
    expect(res).toEqual(["b.md"]);
  });

  describe("abortAction", () => {
    const abort = (f: ReturnType<typeof mergeFixture>) =>
      merge.abortAction({
        root: f.consumer.root,
        rel: DIR,
        abs: f.abs,
        manifest: conn.loadManifest(f.abs, DIR),
      });
    const trackingSha = (repo: Repo) =>
      gitm.readRef(gitm.trackingRef("vendored"), repo.root) as string | null;
    const conflicted = () =>
      mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": L1 },
        upstream: { "a.md": U1, "n.md": "new\n" },
      });

    it("on a merge_staged sync restores the merge, clears the marker and keeps sha and ref", () => {
      const f = conflicted();
      f.call();
      writeFileSync(join(f.abs, "a.md.orig"), "backup\n");
      const res = abort(f);
      expect(res).toEqual({ restored: ["a.md"], removed: ["n.md"], left: ["a.md.orig"] });
      const after = conn.loadManifest(f.abs, DIR);
      expect(after.in_progress).toBeNull();
      expect(after.sha).toBe(f.B);
      expect(statusOf(f.consumer)).toBe(`?? ${DIR}/a.md.orig`);
      expect(existsSync(scratchOf(f.consumer))).toBe(false);
      expect(trackingSha(f.consumer)).not.toBeNull();
    });

    it("on a pin_ready sync restores nothing, clears the marker and lists the untracked files", () => {
      const f = mergeFixture({});
      f.writeMarker("pin_ready");
      writeFileSync(join(f.abs, "notes.md"), "mine\n");
      const res = abort(f);
      expect(res).toEqual({ restored: [], removed: [], left: ["notes.md"] });
      expect(conn.loadManifest(f.abs, DIR).in_progress).toBeNull();
      expect(statusOf(f.consumer)).toBe(`?? ${DIR}/notes.md`);
    });

    it("on a ready add removes the written files, the manifest, the dir, the ref and scratch", () => {
      const up = buildUpstream({
        [`${SUBPATH}/a.md`]: LONG_A,
        [`${SUBPATH}/sub/deep/b.md`]: "b\n",
      });
      repos.push(up);
      const consumer = buildConsumer();
      repos.push(consumer);
      const root = consumer.root;
      gitm.fetchTracking(up.root, "main", "vendored", root);
      const T = gitm.readRef(gitm.trackingRef("vendored"), root);
      const abs = join(root, DIR);
      const manifest = {
        slug: "vendored",
        repo: up.root,
        path: SUBPATH,
        ref: "main",
        sha: T,
        base_tree: gitm.treeOid(T, SUBPATH, root),
      };
      merge.stageMerge({
        root,
        rel: DIR,
        abs,
        slug: "vendored",
        action: "add",
        base: null,
        baseTree: gitm.EMPTY_TREE_OID,
        target: T,
        upstreamTree: gitm.treeOid(T, SUBPATH, root),
        localTree: gitm.EMPTY_TREE_OID,
        stagedState: "ready",
        writeMarker: (state: string) =>
          conn.writeManifest(abs, {
            ...manifest,
            in_progress: { action: "add", state, target_sha: T },
          }),
      });
      expect(conn.loadManifest(abs, DIR).in_progress.state).toBe("ready");
      expect(existsSync(join(abs, "sub/deep/b.md"))).toBe(true);
      const res = merge.abortAction({
        root,
        rel: DIR,
        abs,
        manifest: conn.loadManifest(abs, DIR),
      });
      expect(res).toEqual({ restored: [], removed: ["a.md", "sub/deep/b.md"], left: [] });
      expect(existsSync(abs)).toBe(false);
      expect(gitm.readRef(gitm.trackingRef("vendored"), root)).toBeNull();
      expect(existsSync(conn.scratchDir(root, "vendored"))).toBe(false);
      expect(consumer.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    });

    it("on a merge_staged add restores HEAD, deletes manifest and ref, keeps the dir", () => {
      const f = mergeFixture({
        action: "add",
        withBase: false,
        local: { "a.md": L1 },
        upstream: { "a.md": U1, "n.md": "new\n" },
      });
      f.call();
      expect(conn.loadManifest(f.abs, DIR).in_progress.action).toBe("add");
      const res = abort(f);
      expect(res).toEqual({ restored: ["a.md"], removed: ["n.md"], left: [] });
      expect(statusOf(f.consumer)).toBe("");
      expect(readFileSync(join(f.abs, "a.md"), "utf8")).toBe(L1);
      expect(existsSync(join(f.abs, ".vendor.json"))).toBe(false);
      expect(existsSync(f.abs)).toBe(true);
      expect(trackingSha(f.consumer)).toBeNull();
      expect(existsSync(scratchOf(f.consumer))).toBe(false);
    });

    it("on a merging marker behaves like merge_staged", () => {
      const f = conflicted();
      f.call();
      f.writeMarker("merging");
      const res = abort(f);
      expect(res).toEqual({ restored: ["a.md"], removed: ["n.md"], left: [] });
      expect(conn.loadManifest(f.abs, DIR).in_progress).toBeNull();
      expect(statusOf(f.consumer)).toBe("");
      expect(existsSync(scratchOf(f.consumer))).toBe(false);
    });

    it("without a plan fails 2 with a non-destructive hint and writes nothing", () => {
      const f = conflicted();
      f.call();
      conn.resetScratch(f.consumer.root, "vendored");
      const manifestBytes = readFileSync(join(f.abs, ".vendor.json"));
      const statusBefore = f.consumer.git("status", "--porcelain=v2", "--untracked-files=all");
      const err = caught(() => abort(f));
      expect(err.exit).toBe(2);
      expect(err.message).toMatch(/^scratch is missing: /);
      expect(err.hint).toContain(`git restore --source=HEAD --staged --worktree -- ${DIR}`);
      expect(err.hint).toContain(`git status -- ${DIR}`);
      expect(err.hint).not.toContain("git clean");
      expect(readFileSync(join(f.abs, ".vendor.json"))).toEqual(manifestBytes);
      expect(f.consumer.git("status", "--porcelain=v2", "--untracked-files=all")).toBe(
        statusBefore,
      );
    });

    it("without a marker fails 2", () => {
      const f = mergeFixture({});
      const err = caught(() => abort(f));
      expect(err.exit).toBe(2);
      expect(err.message).toMatch(/^no unfinished/);
    });
  });

  describe("requireResolvedPlan", () => {
    const check = (f: ReturnType<typeof mergeFixture>) => {
      const manifest = conn.loadManifest(f.abs, DIR);
      return merge.requireResolvedPlan({
        root: f.consumer.root,
        rel: DIR,
        manifest,
        marker: manifest.in_progress,
      });
    };
    const conflicted = (action: "add" | "sync" = "sync") =>
      mergeFixture({
        action,
        withBase: action === "sync",
        base: { "a.md": LONG_A },
        local: { "a.md": L1 },
        upstream: { "a.md": U1 },
      });

    it("returns null for a state without a plan", () => {
      const f = mergeFixture({});
      f.writeMarker("pin_ready");
      expect(check(f)).toBeNull();
    });

    it("fails 1 on pin_ready while a file is unmerged", () => {
      const f = mergeFixture({});
      f.writeMarker("pin_ready");
      plantUnmerged(f.consumer, `${DIR}/keep.md`);
      const err = caught(() => check(f));
      expect(err.exit).toBe(1);
      expect(err.message).toBe(`1 files in ${DIR} are still unmerged`);
      expect(err.data).toEqual({ unresolved: ["keep.md"] });
    });

    it("returns the plan of a ready add, and fails 1 while a file is unmerged", () => {
      const f = mergeFixture({ action: "add", withBase: false, upstream: { "n.md": "new\n" } });
      f.call({ localTree: gitm.EMPTY_TREE_OID, stagedState: "ready" });
      expect(check(f)).toEqual(planOf(f.consumer));
      plantUnmerged(f.consumer, `${DIR}/n.md`);
      const err = caught(() => check(f));
      expect(err.exit).toBe(1);
      expect(err.data).toEqual({ unresolved: ["n.md"] });
    });

    it("fails 1 while files are still unmerged, listing them", () => {
      const f = conflicted();
      f.call();
      const err = caught(() => check(f));
      expect(err.exit).toBe(1);
      expect(err.message).toBe(`1 files in ${DIR} are still unmerged`);
      expect(err.data).toEqual({ unresolved: ["a.md"] });
    });

    it("returns the plan once every file is resolved", () => {
      const f = conflicted();
      f.call();
      f.consumer.git("add", "--", `${DIR}/a.md`);
      expect(check(f)).toEqual(planOf(f.consumer));
      expect(check(f).target).toBe(f.T);
    });

    it("fails 2 when the plan targets another commit than the open action", () => {
      for (const action of ["add", "sync"] as const) {
        const f = mergeFixture({ action, upstream: { "n.md": "new\n" } });
        f.call();
        const plan = planOf(f.consumer);
        merge.writePlan(scratchOf(f.consumer), { ...plan, target: f.B });
        const err = caught(() => check(f));
        expect(err.exit).toBe(2);
        expect(err.message).toBe(`plan.json targets ${f.B}, but the open ${action} targets ${f.T}`);
        expect(err.hint).toBe("discard it with --abort");
      }
    });
  });

  describe("openForContinue", () => {
    const open = (f: ReturnType<typeof mergeFixture>, action: "add" | "sync" = "sync") =>
      merge.openForContinue(DIR, action, f.consumer.root);

    it("returns the connection, its marker, the marker's target and the plan", () => {
      const f = mergeFixture({ upstream: { "n.md": "new\n" } });
      f.call();
      const manifest = conn.loadManifest(f.abs, DIR);
      expect(open(f)).toEqual({
        root: f.consumer.root,
        abs: f.abs,
        rel: DIR,
        manifest,
        marker: manifest.in_progress,
        target: f.T,
        plan: planOf(f.consumer),
      });
    });

    it("returns a null plan for pin_ready", () => {
      const f = mergeFixture({});
      f.writeMarker("pin_ready");
      expect(open(f).plan).toBeNull();
    });

    it("fails 2 on another action's marker, before any git check", () => {
      const f = mergeFixture({});
      f.writeMarker("pin_ready");
      plantUnmerged(f.consumer, `${DIR}/keep.md`);
      const err = caught(() => open(f, "add"));
      expect(err.exit).toBe(2);
      expect(err.message).toBe(`an unfinished sync is open on ${DIR}, not add`);
    });

    it("fails 2 during another git operation, before the unmerged check", () => {
      const f = mergeFixture({});
      f.writeMarker("pin_ready");
      plantUnmerged(f.consumer, `${DIR}/keep.md`);
      writeFileSync(join(gitm.gitDir(f.consumer.root), "MERGE_HEAD"), `${f.T}\n`);
      const err = caught(() => open(f));
      expect(err.exit).toBe(2);
      expect(err.message).toBe("another git operation is in progress: MERGE_HEAD");
    });

    it("fails 1 while a file is unmerged, before the staged-outside check", () => {
      const f = mergeFixture({});
      f.writeMarker("pin_ready");
      plantUnmerged(f.consumer, `${DIR}/keep.md`);
      f.consumer.write({ "elsewhere.md": "x\n" });
      f.consumer.git("add", "--", "elsewhere.md");
      const err = caught(() => open(f));
      expect(err.exit).toBe(1);
      expect(err.data).toEqual({ unresolved: ["keep.md"] });
    });

    it("fails 1 while something outside the tool's paths is staged", () => {
      const f = mergeFixture({});
      f.writeMarker("pin_ready");
      f.consumer.write({ "elsewhere.md": "x\n" });
      f.consumer.git("add", "--", "elsewhere.md");
      const err = caught(() => open(f));
      expect(err.exit).toBe(1);
      expect(err.message).toBe(`staged changes outside ${DIR}: elsewhere.md`);
    });
  });

  describe("abortOpenAction", () => {
    it("aborts the open action and reports the identity and abortAction's lists", () => {
      const f = mergeFixture({
        base: { "a.md": LONG_A },
        local: { "a.md": L1 },
        upstream: { "a.md": U1, "n.md": "new\n" },
      });
      f.call();
      writeFileSync(join(f.abs, "a.md.orig"), "backup\n");
      expect(merge.abortOpenAction(DIR, f.consumer.root)).toEqual({
        state: "aborted",
        dir: DIR,
        slug: "vendored",
        repo: f.manifest.repo,
        path: SUBPATH,
        ref: "main",
        restored: ["a.md"],
        removed: ["n.md"],
        left: ["a.md.orig"],
      });
      expect(conn.loadManifest(f.abs, DIR).in_progress).toBeNull();
      expect(existsSync(scratchOf(f.consumer))).toBe(false);
    });

    it("fails 2 without an open action", () => {
      const f = mergeFixture({});
      const err = caught(() => merge.abortOpenAction(DIR, f.consumer.root));
      expect(err.exit).toBe(2);
      expect(err.message).toMatch(/^no unfinished/);
    });
  });
});

describe("an interrupted merge start", () => {
  const repos: Repo[] = [];
  const shims: { cleanup(): void }[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
    for (const shim of shims.splice(0)) shim.cleanup();
  });

  it("AC-37 a start that failed after marker merging can only be aborted", () => {
    const upstream = buildUpstream(demoUpstreamFiles());
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    establish(upstream, consumer);
    consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: L1 });
    upstream.commit("upstream: edit a.md", { [`${SUBPATH}/a.md`]: U1 });
    const sync = (args: string[], env?: Record<string, string>) =>
      runScript("vendor-sync", args, consumer.root, { env });

    const shim = gitShim({ failOn: ["update-index", "--index-info"] });
    shims.push(shim);
    expect(sync([DIR], shim.env).exitCode).toBe(2);
    expect(readManifest(consumer, DIR).in_progress?.state).toBe("merging");

    const again = sync([DIR]);
    expect(again.exitCode).toBe(1);
    expect(again.json.error.data.choices).toEqual(["abort", "leave"]);
    const add = runScript("vendor-add", [upstream.root, SUBPATH, DIR], consumer.root);
    expect(add.exitCode).toBe(1);
    expect(add.json.error.data.choices).toEqual(["abort", "leave"]);
    const cont = sync([DIR, "--continue"]);
    expect(cont.exitCode).toBe(2);
    expect(cont.json.error.message).toBe(
      `the sync on ${DIR} did not finish its start; discard it with --abort`,
    );

    const abort = sync([DIR, "--abort"]);
    expect(abort.exitCode).toBe(0);
    expect(abort.json.state).toBe("aborted");
    expect(consumer.git("status", "--porcelain", "--untracked-files=all", "--", DIR)).toBe("");
  });
});
