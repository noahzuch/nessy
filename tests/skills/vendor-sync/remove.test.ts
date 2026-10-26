import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConsumer,
  buildUpstream,
  demoUpstreamFiles,
  establish,
  listFiles,
  nestedUpstreamFiles,
  refSha,
  type Repo,
  repoState,
  runScript,
  SUBPATH,
} from "./_support/fixtures.js";

const DIR = "vendored";

describe("vendor-remove", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  function setup() {
    const upstream = buildUpstream(demoUpstreamFiles());
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    establish(upstream, consumer, DIR);
    // Any network command would fail against this remote.
    consumer.git("remote", "add", "origin", "/does/not/exist");
    return { upstream, consumer };
  }
  const remove = (consumer: Repo, args: string[]) =>
    runScript("vendor-remove", args, consumer.root);
  const snapshot = (consumer: Repo) => {
    const abs = join(consumer.root, DIR);
    return Object.fromEntries(
      listFiles(abs).map((rel) => [rel, readFileSync(join(abs, rel)).toString("base64")]),
    );
  };

  it("AC-33 drops the connection, keeps every other file and commits nothing", () => {
    const { upstream, consumer } = setup();
    // A fetch of the manifest's upstream would fail too.
    rmSync(upstream.root, { recursive: true, force: true });
    expect(refSha(consumer, "refs/vendor/vendored")).not.toBeNull();
    const head = consumer.git("rev-parse", "HEAD");
    const before = snapshot(consumer);
    delete before[".vendor.json"];

    const res = remove(consumer, [DIR]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.json).toEqual({
      state: "removed",
      dir: DIR,
      slug: DIR,
      files_retained: 3,
    });
    expect(Object.keys(res.json)).toEqual(["state", "dir", "slug", "files_retained"]);

    expect(existsSync(join(consumer.root, DIR, ".vendor.json"))).toBe(false);
    expect(existsSync(join(consumer.root, ".vendor-sync/base/vendored"))).toBe(false);
    expect(snapshot(consumer)).toEqual(before);
    expect(refSha(consumer, "refs/vendor/vendored")).toBeNull();
    expect(consumer.git("rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(consumer.root, ".vendor-sync/.gitignore"))).toBe(true);
    expect(existsSync(join(consumer.root, ".vendor-sync/.gitattributes"))).toBe(true);
    expect(existsSync(join(consumer.root, ".vendor-sync/scratch"))).toBe(false);

    // Read untrimmed: Repo.git trims, which would eat the first line's leading space.
    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: consumer.root,
      encoding: "utf8",
    })
      .stdout.split("\n")
      .filter((line) => line !== "");
    expect(status.length).toBeGreaterThan(1);
    expect(status).toContain(` D ${DIR}/.vendor.json`);
    for (const line of status) {
      expect(line.startsWith(" D ")).toBe(true);
      const path = line.slice(3);
      expect(path === `${DIR}/.vendor.json` || path.startsWith(".vendor-sync/base/vendored/")).toBe(
        true,
      );
    }
  });

  it("AC-33 refuses while an action is open and deletes nothing", () => {
    const { upstream, consumer } = setup();
    upstream.commit("upstream: readme", { "plugins/demo/README.md": "new\n" });
    const start = runScript("vendor-sync", [DIR], consumer.root);
    expect(start.json.state).toBe("pin_ready");
    const state = () => [
      consumer.git("status", "--porcelain", "--untracked-files=all"),
      consumer.git("for-each-ref"),
      consumer.git("rev-parse", "HEAD"),
      snapshot(consumer),
    ];
    const before = state();

    const res = remove(consumer, [DIR]);
    expect(res.exitCode).toBe(2);
    expect(res.json.error.message).toBe(
      `an unfinished sync is open on ${DIR}, started against ${start.json.sha_after}`,
    );
    expect(res.json.error.hint).toBe("finish it with --continue, or discard it with --abort");
    expect(state()).toEqual(before);
    expect(existsSync(join(consumer.root, ".vendor-sync/base/vendored"))).toBe(true);
  });

  it("a manifest nested inside another connection's directory exits 2 and changes nothing", () => {
    const upstream = buildUpstream(nestedUpstreamFiles());
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    establish(upstream, consumer, "outer");
    const before = repoState(consumer);
    const res = remove(consumer, ["outer/inner"]);
    expect(res.exitCode, res.stdout).toBe(2);
    expect(res.json.error.message).toBe("outer/inner is inside the vendored directory outer");
    expect(repoState(consumer)).toEqual(before);
    expect(existsSync(join(consumer.root, "outer/inner/.vendor.json"))).toBe(true);
  });

  it("the nested guard runs before an invalid nested manifest is read", () => {
    const upstream = buildUpstream({
      ...demoUpstreamFiles(),
      [`${SUBPATH}/inner/.vendor.json`]: JSON.stringify({ slug: "inner" }) + "\n",
    });
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    establish(upstream, consumer, "outer");
    const before = repoState(consumer);
    const res = remove(consumer, ["outer/inner"]);
    expect(res.exitCode, res.stdout).toBe(2);
    expect(res.json.error.message).toBe("outer/inner is inside the vendored directory outer");
    expect(repoState(consumer)).toEqual(before);
  });
});
