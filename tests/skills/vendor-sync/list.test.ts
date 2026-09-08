import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConsumer,
  buildUpstream,
  demoUpstreamFiles,
  establish,
  LONG_A,
  nestedUpstreamFiles,
  patchManifest,
  readManifest,
  type Repo,
  runScript,
  SUBPATH,
} from "./_support/fixtures.js";

const FIELDS = [
  "dir",
  "slug",
  "repo",
  "ref",
  "pinned_sha",
  "upstream_tip",
  "status",
  "commits_behind",
  "local_modifications",
];

describe("vendor-list", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  const track = (repo: Repo) => {
    repos.push(repo);
    return repo;
  };
  // Read untrimmed: Repo.git trims, which would eat the first line's leading space.
  const status = (repo: Repo) =>
    spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repo.root,
      encoding: "utf8",
    }).stdout;
  // Runs list and checks it exits 0, prints nothing to stderr and writes no file.
  const list = (consumer: Repo) => {
    const before = status(consumer);
    const res = runScript("vendor-list", [], consumer.root);
    expect(res.exitCode, res.stdout).toBe(0);
    expect(res.stderr).toBe("");
    expect(status(consumer)).toBe(before);
    expect(Object.keys(res.json)).toEqual(["state", "connections"]);
    expect(res.json.state).toBe("listed");
    return res.json.connections as Record<string, unknown>[];
  };
  const byDir = (connections: Record<string, unknown>[], dir: string) =>
    connections.find((c) => c.dir === dir)!;

  it("AC-34 reports one connection per status and writes no file", () => {
    const shared = track(buildUpstream(demoUpstreamFiles()));
    const upB = track(buildUpstream(demoUpstreamFiles()));
    const upE = track(buildUpstream(demoUpstreamFiles()));
    const consumer = track(buildConsumer());
    const est = Object.fromEntries(
      (
        [
          ["a", shared],
          ["b", upB],
          ["c", shared],
          ["d", shared],
          ["e", upE],
          ["f", shared],
          ["g", shared],
        ] as const
      ).map(([dir, up]) => [dir, establish(up, consumer, dir)]),
    );
    const sharedTip = shared.git("rev-parse", "HEAD");

    // b: upstream moves by two commits touching SUBPATH, plus a committed local edit.
    upB.commit("upstream: one", { [`${SUBPATH}/SKILL.md`]: "# demo skill v2\n" });
    const upBTip = upB.commit("upstream: two", { [`${SUBPATH}/nested/b.md`]: "b2\n" });
    consumer.commit("local edit", { "b/a.md": LONG_A + "local\n" });
    // d: the stored base is deleted and committed.
    consumer.commitDeletion("drop d's base", [".vendor-sync/base/d"]);
    // e: an open sync, then a repo no fetch could reach.
    upE.commit("upstream: readme", { "plugins/demo/README.md": "new\n" });
    const start = runScript("vendor-sync", ["e"], consumer.root);
    expect(start.json?.state, start.stdout).toBe("pin_ready");
    patchManifest(consumer, "e", { repo: "/does/not/exist" });
    expect(readManifest(consumer, "e").in_progress).not.toBeNull();
    // f: malformed manifest. g: valid manifest, unreachable repo.
    writeFileSync(join(consumer.root, "f/.vendor.json"), "{ not json\n");
    patchManifest(consumer, "g", { repo: "/does/not/exist" });

    // c, sub-case: an edit to the manifest alone is no local modification.
    const cManifest = join(consumer.root, "c/.vendor.json");
    writeFileSync(cManifest, JSON.stringify(JSON.parse(readFileSync(cManifest, "utf8")), null, 4));
    expect(byDir(list(consumer), "c").local_modifications).toBe(false);

    consumer.write({ "c/new.md": "new\n" });
    const connections = list(consumer);
    expect(connections.map((c) => c.dir)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    for (const c of connections.slice(0, 5)) expect(Object.keys(c)).toEqual(FIELDS);
    for (const c of connections.slice(5)) expect(Object.keys(c)).toEqual([...FIELDS, "error"]);

    const identity = (dir: string, repo: string) => ({
      dir,
      slug: dir,
      repo,
      ref: "main",
      pinned_sha: est[dir].sha,
    });
    expect(byDir(connections, "a")).toEqual({
      ...identity("a", shared.root),
      upstream_tip: sharedTip,
      status: "up_to_date",
      commits_behind: 0,
      local_modifications: false,
    });
    expect(byDir(connections, "b")).toEqual({
      ...identity("b", upB.root),
      upstream_tip: upBTip,
      status: "behind",
      commits_behind: 2,
      local_modifications: true,
    });
    expect(byDir(connections, "c")).toEqual({
      ...identity("c", shared.root),
      upstream_tip: sharedTip,
      status: "up_to_date",
      commits_behind: 0,
      local_modifications: true,
    });
    expect(byDir(connections, "d")).toEqual({
      ...identity("d", shared.root),
      upstream_tip: sharedTip,
      status: "base_missing",
      commits_behind: 0,
      local_modifications: null,
    });
    expect(byDir(connections, "e")).toEqual({
      ...identity("e", "/does/not/exist"),
      upstream_tip: null,
      status: "in_progress",
      commits_behind: null,
      local_modifications: null,
    });

    const f = byDir(connections, "f");
    expect(f).toMatchObject({
      dir: "f",
      slug: null,
      repo: null,
      ref: null,
      pinned_sha: null,
      upstream_tip: null,
      status: "error",
      commits_behind: null,
      local_modifications: null,
    });
    expect(f.error).toContain("f/.vendor.json");

    const g = byDir(connections, "g");
    expect(g).toMatchObject({
      ...identity("g", "/does/not/exist"),
      upstream_tip: null,
      status: "error",
      commits_behind: null,
      local_modifications: null,
    });
    expect(g.error).toContain("fetch failed");
    // git's own output follows the message on its own line.
    expect(String(g.error).split("\n").length).toBeGreaterThan(1);
  });

  it("a manifest nested inside a connection's directory is not listed", () => {
    const upstream = track(buildUpstream(nestedUpstreamFiles()));
    const consumer = track(buildConsumer());
    establish(upstream, consumer, "outer");
    expect(readFileSync(join(consumer.root, "outer/inner/.vendor.json"), "utf8")).toContain(
      '"slug": "inner"',
    );
    const connections = list(consumer);
    expect(connections.map((c) => c.dir)).toEqual(["outer"]);
    expect(byDir(connections, "outer")).toMatchObject({
      status: "up_to_date",
      local_modifications: false,
    });
  });
});
