import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConsumer,
  buildUpstream,
  demoUpstreamFiles,
  establish,
  gitShim,
  LONG_A,
  readManifest,
  refSha,
  type Repo,
  runScript,
  scratchOf,
  SUBPATH,
} from "./_support/fixtures.js";

const DIR = "vendored";

describe("add --abort", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  function setup(consumerFiles: Record<string, string> = {}) {
    const upstream = buildUpstream(demoUpstreamFiles());
    const consumer = buildConsumer(consumerFiles);
    repos.push(upstream, consumer);
    return { upstream, consumer };
  }
  const add = (consumer: Repo, args: string[]) => runScript("vendor-add", args, consumer.root);
  const identity = (upstream: Repo) => ({
    dir: DIR,
    slug: DIR,
    repo: upstream.root,
    path: SUBPATH,
    ref: "main",
  });

  it("AC-14 from ready leaves the same trace as an add that never ran", () => {
    const { upstream, consumer } = setup();
    expect(add(consumer, [upstream.root, SUBPATH, DIR]).json.state).toBe("ready");
    const res = add(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({
      state: "aborted",
      ...identity(upstream),
      restored: [],
      removed: ["SKILL.md", "a.md", "nested/b.md"],
      left: [],
    });
    expect(Object.keys(res.json)).toEqual([
      "state",
      "dir",
      "slug",
      "repo",
      "path",
      "ref",
      "restored",
      "removed",
      "left",
    ]);
    expect(existsSync(join(consumer.root, DIR))).toBe(false);
    expect(refSha(consumer, `refs/vendor/${DIR}`)).toBeNull();
    expect(existsSync(scratchOf(consumer, DIR))).toBe(false);
    expect(consumer.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  // The state an add that never ran leaves: no <dir>, no ref, no scratch, nothing staged.
  const expectNeverRan = (consumer: Repo) => {
    expect(existsSync(join(consumer.root, DIR))).toBe(false);
    expect(refSha(consumer, `refs/vendor/${DIR}`)).toBeNull();
    expect(existsSync(join(consumer.root, ".vendor-sync"))).toBe(false);
    expect(consumer.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(consumer.git("diff", "--cached", "--name-only")).toBe("");
  };

  it("from ready keeps the ignored files and folders that were there before the start", () => {
    const { upstream, consumer } = setup({ ".gitignore": "*.log\n" });
    consumer.write({ [`${DIR}/nested/debug.log`]: "noise\n" });
    mkdirSync(join(consumer.root, DIR, "empty"));
    expect(add(consumer, [upstream.root, SUBPATH, DIR]).json.state).toBe("ready");
    const res = add(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.removed).toEqual(["SKILL.md", "a.md", "nested/b.md"]);
    expect(readFileSync(join(consumer.root, DIR, "nested/debug.log"), "utf8")).toBe("noise\n");
    expect(statSync(join(consumer.root, DIR, "empty")).isDirectory()).toBe(true);
    expect(existsSync(join(consumer.root, DIR, ".vendor.json"))).toBe(false);
    expect(existsSync(join(consumer.root, DIR, "a.md"))).toBe(false);
    expect(consumer.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(consumer.git("diff", "--cached", "--name-only")).toBe("");
  });

  it("from ready after the user edited a written file", () => {
    const { upstream, consumer } = setup();
    expect(add(consumer, [upstream.root, SUBPATH, DIR]).json.state).toBe("ready");
    writeFileSync(join(consumer.root, DIR, "a.md"), "mine\n");
    writeFileSync(join(consumer.root, DIR, "nested/b.md"), "mine too\n");
    consumer.git("add", "--", `${DIR}/nested/b.md`);
    expect(add(consumer, [DIR, "--abort"]).exitCode).toBe(0);
    expectNeverRan(consumer);
  });

  it("from ready after a rejected --continue", () => {
    const { upstream, consumer } = setup();
    expect(add(consumer, [upstream.root, SUBPATH, DIR]).json.state).toBe("ready");
    writeFileSync(join(consumer.root, DIR, "a.md"), "mine\n");
    const gitDir = consumer.git("rev-parse", "--absolute-git-dir");
    writeFileSync(join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(add(consumer, [DIR, "--continue"]).exitCode).toBe(1);
    expect(readManifest(consumer, DIR).in_progress?.state).toBe("ready");
    expect(add(consumer, [DIR, "--abort"]).exitCode).toBe(0);
    expectNeverRan(consumer);
  });

  for (const [when, failOn] of [
    ["before", ["restore"]],
    ["after", ["ls-files", "-d"]],
  ] as const) {
    it(`from a ready start that failed ${when} writing its files (marker merging)`, () => {
      const { upstream, consumer } = setup();
      const shim = gitShim({ failOn: [...failOn] });
      try {
        const res = runScript("vendor-add", [upstream.root, SUBPATH, DIR], consumer.root, {
          env: shim.env,
        });
        expect(res.exitCode).toBe(2);
      } finally {
        shim.cleanup();
      }
      expect(readManifest(consumer, DIR).in_progress?.state).toBe("merging");
      if (when === "after") expect(existsSync(join(consumer.root, DIR, "a.md"))).toBe(true);
      const res = add(consumer, [DIR, "--abort"]);
      expect(res.exitCode).toBe(0);
      expect(res.json.removed).toEqual(["SKILL.md", "a.md", "nested/b.md"]);
      expectNeverRan(consumer);
    });
  }

  it("AC-14 from merge_staged puts every touched path back at HEAD", () => {
    const { upstream, consumer } = setup({
      [`${DIR}/a.md`]: "local a\n",
      [`${DIR}/SKILL.md`]: "# demo skill\n",
      [`${DIR}/local.md`]: "local only\n",
    });
    expect(add(consumer, [upstream.root, SUBPATH, DIR]).json.state).toBe("merge_staged");
    const res = add(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({
      state: "aborted",
      ...identity(upstream),
      restored: ["a.md"],
      removed: ["nested/b.md"],
      left: [],
    });
    expect(existsSync(join(consumer.root, DIR, ".vendor.json"))).toBe(false);
    expect(refSha(consumer, `refs/vendor/${DIR}`)).toBeNull();
    expect(existsSync(scratchOf(consumer, DIR))).toBe(false);
    expect(consumer.git("ls-files", "-u")).toBe("");
    expect(consumer.git("status", "--porcelain", "--untracked-files=all", "--", DIR)).toBe("");
  });

  it("leaves no .vendor-sync/ behind in a repository that had none", () => {
    const { upstream, consumer } = setup({ [`${DIR}/a.md`]: "local a\n" });
    expect(add(consumer, [upstream.root, SUBPATH, DIR]).json.state).toBe("merge_staged");
    expect(existsSync(scratchOf(consumer, DIR))).toBe(true);
    expect(add(consumer, [DIR, "--abort"]).exitCode).toBe(0);
    expect(existsSync(join(consumer.root, ".vendor-sync"))).toBe(false);
  });

  it("leaves no .vendor-sync/ behind after a rejected --continue and the abort", () => {
    const { upstream, consumer } = setup({ [`${DIR}/a.md`]: "local a\n" });
    expect(add(consumer, [upstream.root, SUBPATH, DIR]).json.state).toBe("merge_staged");
    writeFileSync(join(consumer.root, DIR, "a.md"), "resolved\n");
    consumer.git("add", "--", `${DIR}/a.md`);
    const gitDir = consumer.git("rev-parse", "--absolute-git-dir");
    writeFileSync(join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(add(consumer, [DIR, "--continue"]).exitCode).toBe(1);
    expect(add(consumer, [DIR, "--abort"]).exitCode).toBe(0);
    expect(existsSync(join(consumer.root, ".vendor-sync"))).toBe(false);
    expect(consumer.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("keeps a .vendor-sync/ that holds anything else", () => {
    const { upstream, consumer } = setup({
      [`${DIR}/a.md`]: "local a\n",
      ".vendor-sync/base/x": "x\n",
    });
    expect(add(consumer, [upstream.root, SUBPATH, DIR]).json.state).toBe("merge_staged");
    expect(add(consumer, [DIR, "--abort"]).exitCode).toBe(0);
    expect(existsSync(join(consumer.root, ".vendor-sync/scratch"))).toBe(false);
    expect(readFileSync(join(consumer.root, ".vendor-sync/base/x"), "utf8")).toBe("x\n");
  });
});

describe("sync --abort", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  function setup(upstreamFiles = demoUpstreamFiles()) {
    const upstream = buildUpstream(upstreamFiles);
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    const { sha } = establish(upstream, consumer);
    return { upstream, consumer, sha };
  }
  const sync = (consumer: Repo, args: string[]) => runScript("vendor-sync", args, consumer.root);
  const identity = (upstream: Repo) => ({
    dir: DIR,
    slug: DIR,
    repo: upstream.root,
    path: SUBPATH,
    ref: "main",
  });
  const editLine = (n: number, text: string) =>
    LONG_A.split("\n")
      .map((line, i) => (i === n - 1 ? text : line))
      .join("\n");
  const statusOf = (repo: Repo, ...pathspec: string[]) =>
    repo.git("status", "--porcelain", "--untracked-files=all", "--", ...pathspec);
  const indexMode = (repo: Repo, path: string) =>
    repo.git("ls-files", "-s", "--", path).split(" ")[0];
  const diskExecutable = (repo: Repo, path: string) =>
    (statSync(join(repo.root, path)).mode & 0o111) !== 0;

  it("AC-20 puts every touched path back at HEAD, content and mode", () => {
    const upstream = buildUpstream({
      ...demoUpstreamFiles(),
      [`${SUBPATH}/x.sh`]: "#!/bin/sh\necho x\n",
      [`${SUBPATH}/m.sh`]: "echo m\n",
    });
    upstream.chmodX(`${SUBPATH}/x.sh`);
    upstream.commit("upstream: x.sh executable", {});
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    const { sha } = establish(upstream, consumer);
    consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: editLine(2, "local") });
    upstream.commit("upstream: change all three", {
      [`${SUBPATH}/x.sh`]: "#!/bin/sh\necho x2\n",
      [`${SUBPATH}/m.sh`]: "echo m2\n",
      [`${SUBPATH}/a.md`]: editLine(2, "upstream"),
    });
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    rmSync(join(consumer.root, DIR, "x.sh"));
    consumer.chmodX(`${DIR}/m.sh`);

    const res = sync(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({
      state: "aborted",
      ...identity(upstream),
      restored: ["a.md", "m.sh", "x.sh"],
      removed: [],
      left: [],
    });
    expect(Object.keys(res.json)).toEqual([
      "state",
      "dir",
      "slug",
      "repo",
      "path",
      "ref",
      "restored",
      "removed",
      "left",
    ]);
    expect(statusOf(consumer, DIR)).toBe("");
    expect(indexMode(consumer, `${DIR}/x.sh`)).toBe("100755");
    expect(diskExecutable(consumer, `${DIR}/x.sh`)).toBe(true);
    expect(indexMode(consumer, `${DIR}/m.sh`)).toBe("100644");
    expect(diskExecutable(consumer, `${DIR}/m.sh`)).toBe(false);
    const manifest = readManifest(consumer, DIR);
    expect(manifest.in_progress).toBeNull();
    expect(manifest.sha).toBe(sha);
    expect(existsSync(scratchOf(consumer, DIR))).toBe(false);
  });

  it("AC-20 keeps a submodule entry the user tracks inside <dir>", () => {
    const { upstream, consumer } = setup();
    const sm = consumer.git("rev-parse", "HEAD");
    consumer.git("update-index", "--add", "--cacheinfo", `160000,${sm},${DIR}/sm`);
    consumer.git("commit", "-q", "-m", "consumer: add a submodule entry");
    // An unpopulated submodule: git status reports a missing directory as a deletion.
    mkdirSync(join(consumer.root, DIR, "sm"));
    upstream.commit("upstream: edit a.md", { [`${SUBPATH}/a.md`]: editLine(2, "upstream") });
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    const res = sync(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(consumer.git("ls-files", "-s", "--", `${DIR}/sm`)).toBe(`160000 ${sm} 0\t${DIR}/sm`);
    expect(statusOf(consumer)).toBe("");
  });

  it("AC-20 on an open add behaves as add --abort", () => {
    const upstream = buildUpstream(demoUpstreamFiles());
    const consumer = buildConsumer({
      [`${DIR}/a.md`]: "local a\n",
      [`${DIR}/SKILL.md`]: "# demo skill\n",
      [`${DIR}/local.md`]: "local only\n",
    });
    repos.push(upstream, consumer);
    const add = runScript("vendor-add", [upstream.root, SUBPATH, DIR], consumer.root);
    expect(add.json.state).toBe("merge_staged");
    const res = sync(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({
      state: "aborted",
      ...identity(upstream),
      restored: ["a.md"],
      removed: ["nested/b.md"],
      left: [],
    });
    expect(existsSync(join(consumer.root, DIR, ".vendor.json"))).toBe(false);
    expect(refSha(consumer, `refs/vendor/${DIR}`)).toBeNull();
    expect(existsSync(scratchOf(consumer, DIR))).toBe(false);
    expect(consumer.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("an ignored file the merge does not write survives the start and the abort", () => {
    const { upstream, consumer } = setup();
    consumer.commit("consumer: ignore logs", { ".gitignore": "*.log\n" });
    consumer.write({ [`${DIR}/other.log`]: "MINE\n" });
    upstream.commit("upstream: edit a.md, add new.log", {
      [`${SUBPATH}/a.md`]: editLine(2, "upstream"),
      [`${SUBPATH}/new.log`]: "up\n",
    });
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    expect(readFileSync(join(consumer.root, DIR, "other.log"), "utf8")).toBe("MINE\n");
    const res = sync(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.removed).toEqual(["new.log"]);
    expect(readFileSync(join(consumer.root, DIR, "other.log"), "utf8")).toBe("MINE\n");
    expect(existsSync(join(consumer.root, DIR, "new.log"))).toBe(false);
  });

  it("AC-31 a created path with glob characters removes only itself, not an ignored look-alike", () => {
    const { upstream, consumer } = setup();
    consumer.commit("consumer: ignore *.local", { ".gitignore": "*.local\n" });
    consumer.write({ [`${DIR}/x.local`]: "SECRET\n" });
    upstream.commit("upstream: add [xy].local", { [`${SUBPATH}/[xy].local`]: "up\n" });
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    expect(readFileSync(join(consumer.root, DIR, "[xy].local"), "utf8")).toBe("up\n");
    const res = sync(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.removed).toEqual(["[xy].local"]);
    expect(existsSync(join(consumer.root, DIR, "[xy].local"))).toBe(false);
    expect(readFileSync(join(consumer.root, DIR, "x.local"), "utf8")).toBe("SECRET\n");
  });

  it("abort from pin_ready clears the marker and restores nothing", () => {
    const { upstream, consumer, sha } = setup();
    upstream.commit("upstream: readme", { "plugins/demo/README.md": "new\n" });
    expect(sync(consumer, [DIR]).json.state).toBe("pin_ready");
    const res = sync(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({
      state: "aborted",
      ...identity(upstream),
      restored: [],
      removed: [],
      left: [],
    });
    expect(readManifest(consumer, DIR).in_progress).toBeNull();
    expect(readManifest(consumer, DIR).sha).toBe(sha);
    expect(consumer.git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("AC-24 (abort) removes the side files of a file that became a directory", () => {
    const { upstream, consumer } = setup({ ...demoUpstreamFiles(), [`${SUBPATH}/x`]: LONG_A });
    consumer.commit("consumer: edit x", { [`${DIR}/x`]: editLine(2, "local") });
    upstream.git("rm", "-q", "--", `${SUBPATH}/x`);
    upstream.commit("upstream: x becomes a directory", { [`${SUBPATH}/x/inner.md`]: "inner\n" });
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    const res = sync(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(consumer.root, DIR, "x~vendor-local"))).toBe(false);
    expect(existsSync(join(consumer.root, DIR, "x~vendor-upstream"))).toBe(false);
    expect(readFileSync(join(consumer.root, DIR, "x"), "utf8")).toBe(editLine(2, "local"));
    expect(statusOf(consumer, DIR)).toBe("");
  });

  it("AC-31 touches only the touched paths and lists the leftovers", () => {
    const { upstream, consumer } = setup();
    consumer.commit("consumer: ignore rules, a local file and a local edit", {
      ".gitignore": "*.log\n",
      [`${DIR}/local-only.md`]: "local only\n",
      [`${DIR}/a.md`]: editLine(2, "local"),
    });
    consumer.write({ [`${DIR}/debug.log`]: "debug\n", "outside.txt": "outside\n" });
    upstream.commit("upstream: edit a.md", { [`${SUBPATH}/a.md`]: editLine(2, "upstream") });
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    writeFileSync(join(consumer.root, DIR, "a.md.orig"), "backup\n");

    const res = sync(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.left).toEqual(["a.md.orig"]);
    const read = (path: string) => readFileSync(join(consumer.root, path), "utf8");
    expect(read(`${DIR}/debug.log`)).toBe("debug\n");
    expect(read(`${DIR}/local-only.md`)).toBe("local only\n");
    expect(read(`${DIR}/a.md.orig`)).toBe("backup\n");
    expect(read("outside.txt")).toBe("outside\n");
  });

  for (const variant of ["missing", "{}"]) {
    it(`AC-32 a ${variant === "missing" ? "missing" : "invalid"} plan stops the abort with a recovery hint`, () => {
      const { upstream, consumer } = setup();
      upstream.commit("upstream: edit a.md", { [`${SUBPATH}/a.md`]: editLine(2, "upstream") });
      expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
      const plan = join(scratchOf(consumer, DIR), "plan.json");
      if (variant === "missing") rmSync(plan);
      else writeFileSync(plan, "{}");
      const status = () => consumer.git("status", "--porcelain=v2", "--untracked-files=all");
      const manifest = () => readFileSync(join(consumer.root, DIR, ".vendor.json"), "utf8");
      const before = [status(), manifest()];
      const res = sync(consumer, [DIR, "--abort"]);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.hint).toContain(
        `git restore --source=HEAD --staged --worktree -- ${DIR}`,
      );
      expect(res.json.error.hint).not.toContain("git clean");
      expect([status(), manifest()]).toEqual(before);
    });
  }
});
