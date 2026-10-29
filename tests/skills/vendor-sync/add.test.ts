import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConsumer,
  buildUpstream,
  CASE_INSENSITIVE_FS,
  demoUpstreamFiles,
  establish,
  indexStages,
  listFiles,
  listRefs,
  NEEDS_CASE_INSENSITIVE_FS,
  nestedUpstreamFiles,
  plantGitOperation,
  plantUnmerged,
  readManifest,
  readPlan,
  refSha,
  type Repo,
  repoState,
  runScript,
  scratchOf,
  SUBPATH,
} from "./_support/fixtures.js";

const DIR = "vendored";
const GIT_OPERATIONS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

// The consumer of AC-13: committed content in vendored/ that differs, matches, and is local-only.
const LOCAL_CONTENT = {
  [`${DIR}/a.md`]: "local a\n",
  [`${DIR}/SKILL.md`]: "# demo skill\n",
  [`${DIR}/local.md`]: "local only\n",
};

describe("vendor-add", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  function setup(consumerFiles: Record<string, string> = {}) {
    const upstream = buildUpstream(demoUpstreamFiles());
    const consumer = buildConsumer(consumerFiles);
    repos.push(upstream, consumer);
    return { upstream, consumer, sha: upstream.git("rev-parse", "HEAD") };
  }
  const add = (consumer: Repo, args: string[]) => runScript("vendor-add", args, consumer.root);
  const start = (upstream: Repo, consumer: Repo, extra: string[] = [], dir = DIR) =>
    add(consumer, [upstream.root, SUBPATH, dir, ...extra]);
  const identity = (upstream: Repo, dir = DIR, slug = DIR) => ({
    dir,
    slug,
    repo: upstream.root,
    path: SUBPATH,
    ref: "main",
  });
  const statusAll = (repo: Repo, ...pathspec: string[]) =>
    repo.git("status", "--porcelain", "--untracked-files=all", "--", ...pathspec);
  const trackingRefOf = (repo: Repo, slug = DIR) => refSha(repo, `refs/vendor/${slug}`);
  // One record per path: `<kind> <xy> <path>`, from `git status --porcelain=v2`.
  const statusV2 = (repo: Repo) =>
    repo
      .git("status", "--porcelain=v2", "--untracked-files=all", "--", DIR)
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const fields = line.split(" ");
        const pathAt: Record<string, number> = { "1": 8, "2": 9, u: 10, "?": 1 };
        const xy = fields[0] === "?" ? "??" : fields[1];
        return `${fields[0]} ${xy} ${fields.slice(pathAt[fields[0]]).join(" ")}`;
      })
      .sort();
  // Everything a failed call must leave as it was.
  const snapshot = (repo: Repo) => ({
    status: repo.git("status", "--porcelain=v2", "--untracked-files=all"),
    index: repo.git("ls-files", "-s"),
    files: listFiles(join(repo.root, DIR)).map((path) => [
      path,
      readFileSync(join(repo.root, DIR, path), "utf8"),
    ]),
    refs: repo.git("for-each-ref"),
  });
  const expectNoTrace = (consumer: Repo) => {
    expect(existsSync(join(consumer.root, DIR, ".vendor.json"))).toBe(false);
    expect(trackingRefOf(consumer)).toBeNull();
    expect(existsSync(scratchOf(consumer, DIR))).toBe(false);
  };

  describe("start onto an absent or empty directory", () => {
    for (const variant of ["absent", "empty"]) {
      it(`AC-11 writes and stages upstream's files with marker ready (${variant} dir)`, () => {
        const { upstream, consumer, sha } = setup();
        if (variant === "empty") mkdirSync(join(consumer.root, DIR));
        const res = start(upstream, consumer);
        expect(res.exitCode).toBe(0);
        expect(res.json).toEqual({
          state: "ready",
          ...identity(upstream),
          sha,
          files: ["SKILL.md", "a.md", "nested/b.md"],
          skipped_submodules: [],
        });
        expect(Object.keys(res.json)).toEqual([
          "state",
          "dir",
          "slug",
          "repo",
          "path",
          "ref",
          "sha",
          "files",
          "skipped_submodules",
        ]);
        expect(statusAll(consumer).split("\n")).toEqual([
          `A  ${DIR}/SKILL.md`,
          `A  ${DIR}/a.md`,
          `A  ${DIR}/nested/b.md`,
          `?? ${DIR}/.vendor.json`,
        ]);
        expect(consumer.git("diff", "--cached", "--name-only").split("\n")).toEqual([
          `${DIR}/SKILL.md`,
          `${DIR}/a.md`,
          `${DIR}/nested/b.md`,
        ]);
        for (const file of ["SKILL.md", "a.md", "nested/b.md"]) {
          expect(readFileSync(join(consumer.root, DIR, file), "utf8")).toBe(
            consumer.git("show", `${sha}:${SUBPATH}/${file}`) + "\n",
          );
        }
        expect(readPlan(consumer, DIR).touched).toEqual(
          ["SKILL.md", "a.md", "nested/b.md"].map((path) => ({ path, local_oid: null })),
        );
        const manifest = readManifest(consumer, DIR);
        expect(manifest.in_progress).toEqual({ action: "add", state: "ready", target_sha: sha });
        expect(manifest.sha).toBe(sha);
        expect(manifest.base_tree).toBe(consumer.git("rev-parse", `${sha}:${SUBPATH}`));
      });
    }

    it("AC-30 (add) files omits a written file the user deleted before --continue", () => {
      const { upstream, consumer } = setup();
      expect(start(upstream, consumer).json.state).toBe("ready");
      rmSync(join(consumer.root, DIR, "a.md"));
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(0);
      expect(res.json.files).toEqual(["SKILL.md", "nested/b.md"]);
      expect(consumer.git("ls-tree", "-r", "--name-only", "HEAD", "--", DIR).split("\n")).toEqual([
        `${DIR}/.vendor.json`,
        `${DIR}/SKILL.md`,
        `${DIR}/nested/b.md`,
      ]);
    });

    it("AC-12 --continue commits upstream's exact blobs, modes and symlinks", () => {
      const { upstream, consumer } = setup();
      upstream.write({ [`${SUBPATH}/run.sh`]: "#!/bin/sh\necho hi\n" });
      upstream.chmodX(`${SUBPATH}/run.sh`);
      upstream.symlink(`${SUBPATH}/link`, "a.md");
      const sha = upstream.commit("upstream: exec and link", {});
      expect(start(upstream, consumer).json.state).toBe("ready");
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(0);

      const vendored = consumer
        .git("ls-tree", "-r", "HEAD", "--", DIR)
        .split("\n")
        .map((line) => line.replace(`\t${DIR}/`, "\t"))
        .filter((line) => !line.endsWith("\t.vendor.json"));
      const upstreamTree = consumer.git("ls-tree", "-r", `${sha}:${SUBPATH}`).split("\n");
      expect(vendored).toEqual(upstreamTree);
      expect(upstreamTree.some((l) => l.startsWith("100755 ") && l.endsWith("\trun.sh"))).toBe(
        true,
      );
      expect(upstreamTree.some((l) => l.startsWith("120000 ") && l.endsWith("\tlink"))).toBe(true);

      const committed = consumer.git("show", "--name-only", "--format=", "HEAD").split("\n");
      for (const path of committed) {
        expect(path.startsWith(`${DIR}/`) || path.startsWith(".vendor-sync/")).toBe(true);
      }
      expect(res.json).toEqual({
        state: "added",
        ...identity(upstream),
        sha,
        commit: consumer.git("rev-parse", "HEAD"),
        files: ["SKILL.md", "a.md", "link", "nested/b.md", "run.sh"],
      });
      expect(Object.keys(res.json)).toEqual([
        "state",
        "dir",
        "slug",
        "repo",
        "path",
        "ref",
        "sha",
        "commit",
        "files",
      ]);
    });

    it("a directory holding only an ignored file counts as empty", () => {
      const { upstream, consumer, sha } = setup({ ".gitignore": "*.log\n" });
      consumer.write({ [`${DIR}/debug.log`]: "noise\n" });
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(0);
      expect(res.json.state).toBe("ready");
      expect(res.json.files).toEqual(["SKILL.md", "a.md", "nested/b.md"]);
      expect(readManifest(consumer, DIR).in_progress).toEqual({
        action: "add",
        state: "ready",
        target_sha: sha,
      });
      expect(readFileSync(join(consumer.root, DIR, "debug.log"), "utf8")).toBe("noise\n");
    });

    it("a directory holding only an empty subdirectory counts as empty", () => {
      const { upstream, consumer } = setup();
      mkdirSync(join(consumer.root, DIR, "sub"), { recursive: true });
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(0);
      expect(res.json.state).toBe("ready");
    });

    it("a directory that is a file stops the start", () => {
      const { upstream, consumer } = setup({ [DIR]: "a file\n" });
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe(`${DIR} is not a directory`);
      expect(res.json.error.hint).toBe("choose another directory");
      expect(trackingRefOf(consumer)).toBeNull();
    });

    it("AC-38 ignored files at upstream's paths stop the start", () => {
      const { upstream, consumer } = setup({ ".gitignore": `/${DIR}/a.md\n/${DIR}/nested\n` });
      consumer.write({ [`${DIR}/a.md`]: "mine\n", [`${DIR}/nested`]: "a file\n" });
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe(
        `${DIR} holds files upstream would overwrite: a.md, nested`,
      );
      expect(res.json.error.hint).toBe(`move them out of ${DIR}, then re-run`);
      expect(readFileSync(join(consumer.root, DIR, "a.md"), "utf8")).toBe("mine\n");
      expect(readFileSync(join(consumer.root, DIR, "nested"), "utf8")).toBe("a file\n");
      expectNoTrace(consumer);
    });

    it.skipIf(!CASE_INSENSITIVE_FS)(
      `an ignored file whose name differs from an upstream path only in case stops the start ${NEEDS_CASE_INSENSITIVE_FS}`,
      () => {
        const { upstream, consumer } = setup({ ".gitignore": `/${DIR}/readme.md\n` });
        upstream.commit("upstream: readme", { [`${SUBPATH}/README.md`]: "up\n" });
        consumer.write({ [`${DIR}/readme.md`]: "mine\n" });
        const res = start(upstream, consumer);
        expect(res.exitCode).toBe(2);
        expect(res.json.error.message).toBe(
          `${DIR} holds files upstream would overwrite: readme.md`,
        );
        expect(res.json.error.hint).toBe(`move them out of ${DIR}, then re-run`);
        expect(readdirSync(join(consumer.root, DIR))).toEqual(["readme.md"]);
        expect(readFileSync(join(consumer.root, DIR, "readme.md"), "utf8")).toBe("mine\n");
        expectNoTrace(consumer);
      },
    );

    it("a user edit to a written file after the start is committed by --continue", () => {
      const { upstream, consumer, sha } = setup();
      expect(start(upstream, consumer).json.state).toBe("ready");
      consumer.write({ [`${DIR}/a.md`]: "mine\n" });
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(0);
      expect(res.json.state).toBe("added");
      expect(res.json.files).toEqual(["SKILL.md", "a.md", "nested/b.md"]);
      expect(consumer.git("show", `HEAD:${DIR}/a.md`)).toBe("mine");
      expect(consumer.git("show", `HEAD:${DIR}/SKILL.md`)).toBe(
        consumer.git("show", `${sha}:${SUBPATH}/SKILL.md`),
      );
      expect(consumer.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    });

    it("an unmerged file in the directory stops --continue on ready and commits nothing", () => {
      const { upstream, consumer } = setup();
      expect(start(upstream, consumer).json.state).toBe("ready");
      plantUnmerged(consumer, `${DIR}/a.md`);
      const before = { ...snapshot(consumer), head: consumer.git("rev-parse", "HEAD") };
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe(`1 files in ${DIR} are still unmerged`);
      expect(res.json.error.data).toEqual({ unresolved: ["a.md"] });
      expect({ ...snapshot(consumer), head: consumer.git("rev-parse", "HEAD") }).toEqual(before);
      expect(readManifest(consumer, DIR).in_progress?.state).toBe("ready");
    });

    it("an ignored file beside upstream's paths survives the add", () => {
      const { upstream, consumer } = setup({ ".gitignore": "*.log\n" });
      consumer.write({ [`${DIR}/nested/debug.log`]: "noise\n" });
      expect(start(upstream, consumer).json.state).toBe("ready");
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(0);
      expect(res.json.state).toBe("added");
      expect(readFileSync(join(consumer.root, DIR, "nested/debug.log"), "utf8")).toBe("noise\n");
      expect(consumer.git("ls-files", "--", `${DIR}/nested`)).toBe(`${DIR}/nested/b.md`);
    });

    it("an upstream manifest at the directory's root is not listed", () => {
      const { upstream, consumer } = setup();
      const sha = upstream.commit("upstream: vendored elsewhere", {
        [`${SUBPATH}/.vendor.json`]: "{}\n",
      });
      const ready = start(upstream, consumer);
      expect(ready.json.files).toEqual(["SKILL.md", "a.md", "nested/b.md"]);
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(0);
      expect(res.json.sha).toBe(sha);
      expect(res.json.files).toEqual(["SKILL.md", "a.md", "nested/b.md"]);
    });

    it("AC-21 an upstream submodule entry is left out of the add and its base", () => {
      const { upstream, consumer } = setup();
      const sm = upstream.git("rev-parse", "HEAD");
      upstream.git("update-index", "--add", "--cacheinfo", `160000,${sm},${SUBPATH}/sm`);
      upstream.git("commit", "-q", "-m", "upstream: add a submodule entry");
      const ready = start(upstream, consumer);
      expect(ready.json.state).toBe("ready");
      expect(ready.json.skipped_submodules).toEqual(["sm"]);
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(0);
      expect(res.json.state).toBe("added");
      expect(res.json).not.toHaveProperty("skipped_submodules");
      expect(consumer.git("ls-files", "-s", "--", DIR, ".vendor-sync")).not.toMatch(/^160000/m);
      expect(consumer.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    });

    it("a rejected commit at --continue leaves the ready add open with its files in place", () => {
      const { upstream, consumer } = setup();
      expect(start(upstream, consumer).json.state).toBe("ready");
      const hooks = join(consumer.root, ".git", "reject-hooks");
      mkdirSync(hooks);
      writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho rejected >&2\nexit 1\n", {
        mode: 0o755,
      });
      consumer.git("config", "core.hooksPath", hooks);
      const before = snapshot(consumer);
      const manifest = readFileSync(join(consumer.root, DIR, ".vendor.json"), "utf8");

      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe("the commit failed; the action is still open");
      expect(snapshot(consumer)).toEqual(before);
      expect(existsSync(join(consumer.root, ".vendor-sync/base"))).toBe(false);
      expect(listFiles(join(consumer.root, DIR))).toEqual([
        ".vendor.json",
        "SKILL.md",
        "a.md",
        "nested/b.md",
      ]);
      expect(readFileSync(join(consumer.root, DIR, ".vendor.json"), "utf8")).toBe(manifest);

      expect(add(consumer, [DIR, "--abort"]).exitCode).toBe(0);
      expect(consumer.git("status", "--porcelain", "--untracked-files=all")).toBe("");
      expect(existsSync(join(consumer.root, DIR))).toBe(false);
    });

    it("AC-3 the commit stores the base with its dotfiles and attributes", () => {
      const { upstream, consumer } = setup();
      const { slug, sha, manifest } = establish(upstream, consumer);
      const base = consumer.git("rev-parse", `HEAD:.vendor-sync/base/${slug}`);
      expect(base).toBe(manifest.base_tree);
      expect(base).toBe(consumer.git("rev-parse", `${sha}:${SUBPATH}`));
      expect(consumer.git("show", "HEAD:.vendor-sync/.gitignore")).toBe("/scratch/");
      expect(consumer.git("show", "HEAD:.vendor-sync/.gitattributes")).toBe(
        "base/** -diff -merge linguist-generated",
      );
      const attrs = consumer.git(
        "check-attr",
        "diff",
        "merge",
        "linguist-generated",
        "--",
        `.vendor-sync/base/${slug}/a.md`,
      );
      expect(attrs.split("\n").map((line) => line.split(": ")[2])).toEqual([
        "unset",
        "unset",
        "set",
      ]);
    });

    it("AC-27 --continue makes exactly one commit holding only the tool's paths", () => {
      const { upstream, consumer } = setup();
      const before = Number(consumer.git("rev-list", "--count", "HEAD"));
      const { slug, sha, manifest } = establish(upstream, consumer);
      expect(Number(consumer.git("rev-list", "--count", "HEAD"))).toBe(before + 1);
      expect(consumer.git("log", "-1", "--format=%P").split(" ")).toHaveLength(1);
      expect(consumer.git("log", "-1", "--format=%s")).toBe(
        `vendor-sync: add ${DIR} to ${sha.slice(0, 7)}`,
      );
      const committed = consumer.git("show", "--name-only", "--format=", "HEAD").split("\n").sort();
      const files = ["SKILL.md", "a.md", "nested/b.md"];
      expect(committed).toEqual(
        [
          ...files.map((f) => `${DIR}/${f}`),
          `${DIR}/.vendor.json`,
          ...files.map((f) => `.vendor-sync/base/${slug}/${f}`),
          ".vendor-sync/.gitignore",
          ".vendor-sync/.gitattributes",
        ].sort(),
      );
      expect(manifest.in_progress).toBeNull();
      expect(JSON.parse(consumer.git("show", `HEAD:${DIR}/.vendor.json`)).in_progress).toBeNull();
      expect(existsSync(scratchOf(consumer, slug))).toBe(false);
    });
  });

  describe("a change staged outside <dir>", () => {
    const outside = `staged changes outside ${DIR}: other.txt`;
    // `show --name-only` would hide a gitlink under a submodule ignore config.
    const committedPaths = (repo: Repo) =>
      repo
        .git("diff-tree", "-r", "--name-only", "--ignore-submodules=none", "HEAD~1", "HEAD")
        .split("\n");

    it("stops the start before anything is written", () => {
      const { upstream, consumer } = setup({ "other.txt": "o\n" });
      consumer.write({ "other.txt": "staged\n" });
      consumer.git("add", "--", "other.txt");
      const before = snapshot(consumer);
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe(outside);
      expect(res.json.error.hint).toBe("commit or unstage them, then re-run");
      expect(snapshot(consumer)).toEqual(before);
      expectNoTrace(consumer);
    });

    it("an unstaged edit or an untracked file outside <dir> does not stop the start", () => {
      const { upstream, consumer } = setup({ "other.txt": "o\n" });
      consumer.write({ "other.txt": "unstaged\n", "untracked.txt": "u\n" });
      expect(start(upstream, consumer).json.state).toBe("ready");
    });

    it("stops --continue on ready before anything is written; after unstaging it commits", () => {
      const { upstream, consumer } = setup({ "other.txt": "o\n" });
      expect(start(upstream, consumer).json.state).toBe("ready");
      consumer.write({ "other.txt": "staged\n" });
      consumer.git("add", "--", "other.txt");
      const before = { ...snapshot(consumer), head: consumer.git("rev-parse", "HEAD") };
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe(outside);
      expect({ ...snapshot(consumer), head: consumer.git("rev-parse", "HEAD") }).toEqual(before);
      expect(readManifest(consumer, DIR).in_progress?.state).toBe("ready");

      consumer.git("restore", "--staged", "--", "other.txt");
      expect(add(consumer, [DIR, "--continue"]).json.state).toBe("added");
      for (const path of committedPaths(consumer)) {
        expect(path).toMatch(new RegExp(`^(${DIR}|\\.vendor-sync)/`));
      }
      expect(consumer.git("diff", "--name-only")).toBe("other.txt");
      expect(consumer.git("diff", "--cached", "--name-only")).toBe("");
    });

    it("stops --continue on merge_staged before anything is written; after unstaging it commits", () => {
      const { upstream, consumer } = setup({ ...LOCAL_CONTENT, "other.txt": "o\n" });
      expect(start(upstream, consumer).json.state).toBe("merge_staged");
      consumer.write({ [`${DIR}/a.md`]: "resolved\n", "other.txt": "staged\n" });
      consumer.git("add", "--", `${DIR}/a.md`, "other.txt");
      const before = { ...snapshot(consumer), head: consumer.git("rev-parse", "HEAD") };
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe(outside);
      expect({ ...snapshot(consumer), head: consumer.git("rev-parse", "HEAD") }).toEqual(before);
      expect(readManifest(consumer, DIR).in_progress?.state).toBe("merge_staged");

      consumer.git("restore", "--staged", "--", "other.txt");
      expect(add(consumer, [DIR, "--continue"]).json.state).toBe("added");
      for (const path of committedPaths(consumer)) {
        expect(path).toMatch(new RegExp(`^(${DIR}|\\.vendor-sync)/`));
      }
      expect(committedPaths(consumer)).toContain(`${DIR}/a.md`);
      expect(consumer.git("diff", "--name-only")).toBe("other.txt");
      expect(consumer.git("diff", "--cached", "--name-only")).toBe("");
    });
  });

  describe("start onto committed content", () => {
    it("AC-13 merges against the empty tree", () => {
      const { upstream, consumer, sha } = setup(LOCAL_CONTENT);
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(0);
      expect(statusV2(consumer)).toEqual([
        `1 A. ${DIR}/nested/b.md`,
        `? ?? ${DIR}/.vendor.json`,
        `u AA ${DIR}/a.md`,
      ]);
      expect(indexStages(consumer, `${DIR}/a.md`).map((s) => s.stage)).toEqual([2, 3]);
      expect(res.json).toEqual({
        state: "merge_staged",
        ...identity(upstream),
        base: null,
        sha,
        files: [
          { path: "a.md", presence: "both" },
          { path: "nested/b.md", presence: "upstream" },
        ],
        skipped_submodules: [],
        notes: ["no_base"],
      });
      expect(Object.keys(res.json)).toEqual([
        "state",
        "dir",
        "slug",
        "repo",
        "path",
        "ref",
        "base",
        "sha",
        "files",
        "skipped_submodules",
        "notes",
      ]);
    });

    it("merge_staged reports upstream's submodule entries as skipped_submodules", () => {
      const { upstream, consumer } = setup(LOCAL_CONTENT);
      const sm = upstream.git("rev-parse", "HEAD");
      for (const path of [`${SUBPATH}/sm`, `${SUBPATH}/nested/deep`]) {
        upstream.git("update-index", "--add", "--cacheinfo", `160000,${sm},${path}`);
      }
      upstream.git("commit", "-q", "-m", "upstream: add submodule entries");
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(0);
      expect(res.json.state).toBe("merge_staged");
      expect(res.json.skipped_submodules).toEqual(["nested/deep", "sm"]);
      consumer.git("add", `${DIR}/a.md`);
      const done = add(consumer, [DIR, "--continue"]);
      expect(done.json.state).toBe("added");
      expect(done.json).not.toHaveProperty("skipped_submodules");
    });

    it("AC-38 an ignored file at a path upstream adds stops the merge start before any write", () => {
      const { upstream, consumer } = setup({ ...LOCAL_CONTENT, ".gitignore": "*.log\n" });
      consumer.write({ [`${DIR}/new.log`]: "MINE\n" });
      upstream.commit("upstream: add new.log", { [`${SUBPATH}/new.log`]: "up\n" });
      const before = snapshot(consumer);
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe(`${DIR} holds files upstream would overwrite: new.log`);
      expect(res.json.error.hint).toBe(`move them out of ${DIR}, then re-run`);
      expect(snapshot(consumer)).toEqual(before);
      expect(readFileSync(join(consumer.root, DIR, "new.log"), "utf8")).toBe("MINE\n");
      expectNoTrace(consumer);
      expect(listRefs(consumer, "refs/vendor-*")).toEqual([]);
    });

    it("AC-9 a second add start on an open add offers resume, abort and leave", () => {
      const { upstream, consumer } = setup(LOCAL_CONTENT);
      expect(start(upstream, consumer).json.state).toBe("merge_staged");
      const before = snapshot(consumer);
      const manifest = readFileSync(join(consumer.root, DIR, ".vendor.json"), "utf8");
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.data.choices).toEqual(["resume", "abort", "leave"]);
      expect(snapshot(consumer)).toEqual(before);
      expect(readFileSync(join(consumer.root, DIR, ".vendor.json"), "utf8")).toBe(manifest);
    });

    it("AC-9 (add on an open sync) an add start offers abort and leave", () => {
      const { upstream, consumer } = setup();
      establish(upstream, consumer);
      consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: "local a\n" });
      upstream.commit("upstream: edit a.md", { [`${SUBPATH}/a.md`]: "upstream a\n" });
      const opened = runScript("vendor-sync", [DIR], consumer.root);
      expect(opened.json.state).toBe("merge_staged");
      expect(consumer.git("ls-files", "-u", "--", DIR)).not.toBe("");
      const before = snapshot(consumer);
      const manifest = readFileSync(join(consumer.root, DIR, ".vendor.json"), "utf8");
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.data.choices).toEqual(["abort", "leave"]);
      expect(snapshot(consumer)).toEqual(before);
      expect(readFileSync(join(consumer.root, DIR, ".vendor.json"), "utf8")).toBe(manifest);
    });

    it("AC-10 an uncommitted edit in the directory stops the start", () => {
      const { upstream, consumer } = setup(LOCAL_CONTENT);
      consumer.write({ [`${DIR}/local.md`]: "edited\n", [`${DIR}/new.txt`]: "untracked\n" });
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe(
        `${DIR} has uncommitted changes: ${DIR}/local.md, ${DIR}/new.txt`,
      );
      expect(res.json.error.hint).toBe("commit or discard them, then re-run");
      expectNoTrace(consumer);
    });

    it("AC-10 a staged deletion of the manifest stops the start and is named", () => {
      const { upstream, consumer } = setup();
      establish(upstream, consumer);
      consumer.git("rm", "-q", "--", `${DIR}/.vendor.json`);
      // The working tree and the index; the tracking ref a failed add deletes is not compared.
      const before = repoState(consumer).slice(0, 2);
      const res = start(upstream, consumer);
      expect(res.exitCode, res.stdout).toBe(2);
      expect(res.json.error.message).toBe(`${DIR} has uncommitted changes: ${DIR}/.vendor.json`);
      expect(res.json.error.hint).toBe("commit or discard them, then re-run");
      expect(repoState(consumer).slice(0, 2)).toEqual(before);
    });

    for (const name of GIT_OPERATIONS) {
      it(`AC-10 a git operation in progress stops the start (${name})`, () => {
        const { upstream, consumer } = setup(LOCAL_CONTENT);
        plantGitOperation(consumer, name);
        const res = start(upstream, consumer);
        expect(res.exitCode).toBe(2);
        expect(res.json.error.message).toBe(`another git operation is in progress: ${name}`);
        expectNoTrace(consumer);
      });

      it(`AC-10 a git operation in progress stops a ready start (${name})`, () => {
        const { upstream, consumer } = setup();
        plantGitOperation(consumer, name);
        const before = snapshot(consumer);
        const res = start(upstream, consumer);
        expect(res.exitCode).toBe(2);
        expect(res.json.error.message).toBe(`another git operation is in progress: ${name}`);
        expect(snapshot(consumer)).toEqual(before);
        expect(existsSync(join(consumer.root, DIR))).toBe(false);
        expectNoTrace(consumer);
      });
    }

    it("AC-10 --continue stops while another git operation is in progress", () => {
      const { upstream, consumer } = setup(LOCAL_CONTENT);
      expect(start(upstream, consumer).json.state).toBe("merge_staged");
      consumer.write({ [`${DIR}/a.md`]: "resolved\n" });
      consumer.git("add", `${DIR}/a.md`);
      plantGitOperation(consumer, "MERGE_HEAD");
      const before = snapshot(consumer);
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe("another git operation is in progress: MERGE_HEAD");
      expect(snapshot(consumer)).toEqual(before);
    });

    it("--continue refuses while a file is unmerged, then commits the resolution", () => {
      const { upstream, consumer, sha } = setup(LOCAL_CONTENT);
      expect(start(upstream, consumer).json.state).toBe("merge_staged");
      const before = snapshot(consumer);
      const manifest = readFileSync(join(consumer.root, DIR, ".vendor.json"), "utf8");
      const refused = add(consumer, [DIR, "--continue"]);
      expect(refused.exitCode).toBe(1);
      expect(refused.json.error.message).toBe(`1 files in ${DIR} are still unmerged`);
      expect(refused.json.error.data.unresolved).toEqual(["a.md"]);
      expect(snapshot(consumer)).toEqual(before);
      expect(readFileSync(join(consumer.root, DIR, ".vendor.json"), "utf8")).toBe(manifest);

      // The user resolves the conflict.
      writeFileSync(join(consumer.root, DIR, "a.md"), "combined a\n");
      consumer.git("add", `${DIR}/a.md`);
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(0);
      expect(res.json).toEqual({
        state: "added",
        ...identity(upstream),
        sha,
        commit: consumer.git("rev-parse", "HEAD"),
        files: ["a.md", "nested/b.md"],
      });
      expect(readManifest(consumer, DIR).in_progress).toBeNull();
    });
  });

  describe("start errors", () => {
    it("--ref naming a missing branch lists the remote's branches", () => {
      const { upstream, consumer } = setup();
      upstream.git("branch", "dev");
      const res = start(upstream, consumer, ["--ref", "nope"]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe("branch not found on the remote: nope");
      expect(res.json.error.data.branches).toEqual(["dev", "main"]);
      expectNoTrace(consumer);
    });

    it("--sha that is not an ancestor of the tracked branch fails", () => {
      const { upstream, consumer } = setup();
      upstream.git("checkout", "-q", "-b", "side");
      const side = upstream.commit("upstream: side", { "side.md": "side\n" });
      upstream.git("checkout", "-q", "main");
      const res = start(upstream, consumer, ["--sha", side]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe("sha is not an ancestor of the tracked branch");
      expectNoTrace(consumer);
    });

    it("--sha that is not a revision fails", () => {
      const { upstream, consumer } = setup();
      const res = start(upstream, consumer, ["--sha", "zzz"]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe("not a well-formed revision");
      expectNoTrace(consumer);
    });

    it("--sha that git rejects as fatal still fails 1", () => {
      const { upstream, consumer } = setup();
      const res = start(upstream, consumer, ["--sha", "HEAD@{99}"]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe("not a well-formed revision");
      expectNoTrace(consumer);
    });

    it("an upstream path outside the repository still fails 1", () => {
      const { upstream, consumer, sha } = setup();
      const res = add(consumer, [upstream.root, "../x", DIR]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe(`upstream path absent at ${sha}: ../x`);
      expect(res.json.error.data.entries).toEqual([]);
      expectNoTrace(consumer);
    });

    it("a mistyped upstream path lists the siblings", () => {
      const { upstream, consumer, sha } = setup();
      const res = add(consumer, [upstream.root, "plugins/demo/skills/dmeo", DIR]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe(
        `upstream path absent at ${sha}: plugins/demo/skills/dmeo`,
      );
      expect(res.json.error.data.entries).toEqual(["demo"]);
      expectNoTrace(consumer);
    });

    it("an upstream path that is a file fails", () => {
      const { upstream, consumer } = setup();
      const res = add(consumer, [upstream.root, `${SUBPATH}/a.md`, DIR]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe("upstream path is a file, not a directory");
      expectNoTrace(consumer);
    });

    it("an already vendored, closed directory stops the start", () => {
      const { upstream, consumer } = setup();
      establish(upstream, consumer);
      const res = start(upstream, consumer);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe(`already vendored: ${DIR}`);
      expect(res.json.error.hint).toBe("use sync to update it");
    });

    it("a directory whose slug another connection uses fails", () => {
      const { upstream, consumer } = setup();
      establish(upstream, consumer, "skills/demo");
      const before = snapshot(consumer);
      const res = start(upstream, consumer, [], "skills-demo");
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe('slug "skills-demo" is already used by skills/demo');
      expect(snapshot(consumer)).toEqual(before);
    });

    it("--continue without an open add fails", () => {
      const { upstream, consumer } = setup();
      establish(upstream, consumer);
      const res = add(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe(`no unfinished add on ${DIR}`);
    });
  });

  describe("onto a directory that contains another connection", () => {
    it("AC-39 exits 2 naming the inner connection and changes nothing", () => {
      const { upstream, consumer } = setup();
      establish(upstream, consumer, "vendor/foo");
      const before = repoState(consumer);
      const res = start(upstream, consumer, [], "vendor");
      expect(res.exitCode, res.stdout).toBe(2);
      expect(res.json.error.message).toBe("vendor contains the vendored directory vendor/foo");
      expect(res.json.error.hint).toBe("choose a directory that holds no vendored directory");
      expect(repoState(consumer)).toEqual(before);
      expect(trackingRefOf(consumer, "vendor")).toBeNull();
      expect(existsSync(join(consumer.root, "vendor", ".vendor.json"))).toBe(false);
      expect(readManifest(consumer, "vendor/foo").in_progress).toBeNull();
    });

    it.skipIf(!CASE_INSENSITIVE_FS)(
      `AC-39 a <dir> that names the outer directory in another case exits 2 ${NEEDS_CASE_INSENSITIVE_FS}`,
      () => {
        const { upstream, consumer } = setup();
        establish(upstream, consumer, "vendor/foo");
        const before = repoState(consumer);
        const res = start(upstream, consumer, [], "Vendor");
        expect(res.exitCode, res.stdout).toBe(2);
        expect(res.json.error.message).toBe("Vendor contains the vendored directory vendor/foo");
        expect(repoState(consumer)).toEqual(before);
        expect(trackingRefOf(consumer, "Vendor")).toBeNull();
        expect(readManifest(consumer, "vendor/foo").in_progress).toBeNull();
      },
    );

    it("AC-39 a sibling connection does not stop the start", () => {
      const { upstream, consumer } = setup();
      establish(upstream, consumer, "vendor-foo");
      const res = start(upstream, consumer, [], "vendor");
      expect(res.exitCode, res.stdout).toBe(0);
      expect(res.json.state).toBe("ready");
    });

    it("AC-39 a connection that only shares a name prefix does not stop the start", () => {
      const { upstream, consumer } = setup();
      establish(upstream, consumer, "vendor/foo");
      const res = start(upstream, consumer, [], "vend");
      expect(res.exitCode, res.stdout).toBe(0);
      expect(res.json.state).toBe("ready");
    });
  });

  describe("onto a symbolic link", () => {
    const HINT = "choose a directory that is not a symbolic link or inside one";
    // `other` is the link target; `content` is committed into it first.
    const linked = (link: string, content: Record<string, string>) => {
      const { upstream, consumer } = setup(content);
      mkdirSync(join(consumer.root, "other"), { recursive: true });
      symlinkSync("other", join(consumer.root, link));
      return { upstream, consumer };
    };
    const cases: [string, string, string, Record<string, string>][] = [
      ["AC-40 a symlink to an empty directory", "lnk", "lnk", {}],
      ["AC-40 a symlink to a directory with content", "lnk", "lnk", { "other/x.md": "x\n" }],
      ["AC-40 a <dir> under a symlinked ancestor", "lnk", "lnk/sub", { "other/x.md": "x\n" }],
      ["AC-40 an absent <dir> under a symlinked ancestor", "lnk", "lnk/a/b", {}],
    ];
    for (const [name, link, dir, content] of cases) {
      it(`${name} exits 1 and writes nothing`, () => {
        const { upstream, consumer } = linked(link, content);
        const before = repoState(consumer);
        const targetBefore = listFiles(join(consumer.root, "other"));
        const res = start(upstream, consumer, [], dir);
        expect(res.exitCode, res.stdout).toBe(1);
        expect(res.json.error.message).toBe(`${link} is a symbolic link`);
        expect(res.json.error.hint).toBe(HINT);
        expect(repoState(consumer)).toEqual(before);
        const slug = dir.replace(/\//g, "-");
        expect(trackingRefOf(consumer, slug)).toBeNull();
        expect(existsSync(scratchOf(consumer, slug))).toBe(false);
        expect(existsSync(join(consumer.root, "other", ".vendor.json"))).toBe(false);
        expect(existsSync(join(consumer.root, dir, ".vendor.json"))).toBe(false);
        expect(lstatSync(join(consumer.root, link)).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(consumer.root, link))).toBe("other");
        expect(listFiles(join(consumer.root, "other"))).toEqual(targetBefore);
      });
    }

    it("AC-40 a sibling that is not a symbolic link still starts", () => {
      const { upstream, consumer } = linked("lnk", {});
      const res = start(upstream, consumer, [], "real");
      expect(res.exitCode, res.stdout).toBe(0);
      expect(res.json.state).toBe("ready");
      expect(lstatSync(join(consumer.root, "lnk")).isSymbolicLink()).toBe(true);
    });
  });

  describe("onto a path inside another connection's directory", () => {
    const nested = () => {
      const upstream = buildUpstream(nestedUpstreamFiles());
      const consumer = buildConsumer();
      repos.push(upstream, consumer);
      establish(upstream, consumer, "outer");
      return { upstream, consumer };
    };
    const cases: [string, string, (up: Repo) => string[]][] = [
      ["a start onto a nested manifest", "outer/inner", (up) => [up.root, SUBPATH, "outer/inner"]],
      ["a start onto a new directory", "outer/fresh", (up) => [up.root, SUBPATH, "outer/fresh"]],
      ["--continue", "outer/inner", () => ["outer/inner", "--continue"]],
      ["--abort", "outer/inner", () => ["outer/inner", "--abort"]],
    ];
    for (const [name, dir, args] of cases) {
      it(`${name} exits 2 and changes nothing`, () => {
        const { upstream, consumer } = nested();
        const before = repoState(consumer);
        const res = add(consumer, args(upstream));
        expect(res.exitCode, res.stdout).toBe(2);
        expect(res.json.error.message).toBe(`${dir} is inside the vendored directory outer`);
        expect(res.json.error.hint).toBe("choose a directory outside it");
        expect(repoState(consumer)).toEqual(before);
      });
    }

    it("the guard runs before an invalid nested manifest is read", () => {
      const upstream = buildUpstream({
        ...demoUpstreamFiles(),
        [`${SUBPATH}/inner/.vendor.json`]: JSON.stringify({ slug: "inner" }) + "\n",
      });
      const consumer = buildConsumer();
      repos.push(upstream, consumer);
      establish(upstream, consumer, "outer");
      const before = repoState(consumer);
      const res = add(consumer, [upstream.root, SUBPATH, "outer/inner"]);
      expect(res.exitCode, res.stdout).toBe(2);
      expect(res.json.error.message).toBe("outer/inner is inside the vendored directory outer");
      expect(repoState(consumer)).toEqual(before);
    });
  });
});
