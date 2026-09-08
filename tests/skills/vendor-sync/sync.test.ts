import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  gitShim,
  listFiles,
  listRefs,
  LONG_A,
  NEEDS_CASE_INSENSITIVE_FS,
  nestedUpstreamFiles,
  patchManifest,
  plantGitOperation,
  plantUnmerged,
  readManifest,
  type Repo,
  repoState,
  runScript,
  scratchOf,
  SUBPATH,
} from "./_support/fixtures.js";

const DIR = "vendored";
const BASE = `.vendor-sync/base/${DIR}`;
const GIT_OPERATIONS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];
// LONG_A with one line changed.
const editLine = (n: number, text: string) =>
  LONG_A.split("\n")
    .map((line, i) => (i === n - 1 ? text : line))
    .join("\n");

const sync = (consumer: Repo, args: string[], env?: Record<string, string>) =>
  runScript("vendor-sync", args, consumer.root, { env });
const identity = (upstream: Repo) => ({
  dir: DIR,
  slug: DIR,
  repo: upstream.root,
  path: SUBPATH,
  ref: "main",
});
const statusAll = (repo: Repo) => repo.git("status", "--porcelain", "--untracked-files=all");
// `<xy> <path>` per changed path; Repo.git trims, so the short format would lose its leading space.
const changes = (repo: Repo) =>
  repo
    .git("status", "--porcelain=v2", "--untracked-files=all")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const fields = line.split(" ");
      return fields[0] === "?" ? `?? ${fields[1]}` : `${fields[1]} ${fields.slice(8).join(" ")}`;
    });
const manifestBytes = (repo: Repo) => readFileSync(join(repo.root, DIR, ".vendor.json"), "utf8");
const snapshot = (repo: Repo) => ({
  status: repo.git("status", "--porcelain=v2", "--untracked-files=all"),
  index: repo.git("ls-files", "-s"),
  manifest: manifestBytes(repo),
  files: listFiles(join(repo.root, DIR)).map((path) => [
    path,
    readFileSync(join(repo.root, DIR, path), "utf8"),
  ]),
});
const upstreamEditsA = (upstream: Repo, line = 2) =>
  upstream.commit("upstream: edit a.md", { [`${SUBPATH}/a.md`]: editLine(line, "upstream") });

describe("vendor-sync start", () => {
  const repos: Repo[] = [];
  const shims: { cleanup(): void }[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
    for (const shim of shims.splice(0)) shim.cleanup();
  });
  function setup(upstreamFiles = demoUpstreamFiles()) {
    const upstream = buildUpstream(upstreamFiles);
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    const { sha } = establish(upstream, consumer);
    return { upstream, consumer, sha };
  }

  it("AC-15 right after establish the start is up_to_date and writes nothing", () => {
    const { upstream, consumer, sha } = setup();
    const res = sync(consumer, [DIR]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({ state: "up_to_date", ...identity(upstream), sha });
    expect(Object.keys(res.json)).toEqual(["state", "dir", "slug", "repo", "path", "ref", "sha"]);
    expect(statusAll(consumer)).toBe("");
  });

  it("AC-15 a tip that leaves the path alone is pin_ready, writing only the marker", () => {
    const { upstream, consumer, sha } = setup();
    const tip = upstream.commit("upstream: readme", { "plugins/demo/README.md": "new\n" });
    const res = sync(consumer, [DIR]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({
      state: "pin_ready",
      ...identity(upstream),
      sha_before: sha,
      sha_after: tip,
      commits_behind: 0,
      skipped_submodules: [],
    });
    expect(Object.keys(res.json)).toEqual([
      "state",
      "dir",
      "slug",
      "repo",
      "path",
      "ref",
      "sha_before",
      "sha_after",
      "commits_behind",
      "skipped_submodules",
    ]);
    expect(changes(consumer)).toEqual([`.M ${DIR}/.vendor.json`]);
    expect(readManifest(consumer, DIR).in_progress).toEqual({
      action: "sync",
      state: "pin_ready",
      target_sha: tip,
    });
  });

  it("pin_ready via an ignored difference: only an upstream manifest was added", () => {
    const { upstream, consumer } = setup();
    upstream.commit("upstream: manifest", { [`${SUBPATH}/.vendor.json`]: "{}\n" });
    const res = sync(consumer, [DIR]);
    expect(res.exitCode).toBe(0);
    expect(res.json.state).toBe("pin_ready");
    expect(res.json.commits_behind).toBe(1);
    expect(changes(consumer)).toEqual([`.M ${DIR}/.vendor.json`]);
  });

  it("merge_staged (sync) reports the base, both commits and what each side changed", () => {
    const { upstream, consumer, sha } = setup();
    consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: editLine(7, "local") });
    const tip = upstreamEditsA(upstream);
    const res = sync(consumer, [DIR]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({
      state: "merge_staged",
      ...identity(upstream),
      base: sha,
      sha_before: sha,
      sha_after: tip,
      commits_behind: 1,
      files: [{ path: "a.md", upstream_changes: "modified", local_changes: "modified" }],
      skipped_submodules: [],
      notes: [],
    });
    expect(Object.keys(res.json)).toEqual([
      "state",
      "dir",
      "slug",
      "repo",
      "path",
      "ref",
      "base",
      "sha_before",
      "sha_after",
      "commits_behind",
      "files",
      "skipped_submodules",
      "notes",
    ]);
    expect(readFileSync(join(consumer.root, DIR, "a.md"), "utf8")).toBe(
      editLine(7, "local").replace("line2", "upstream"),
    );
    expect(readManifest(consumer, DIR).in_progress).toEqual({
      action: "sync",
      state: "merge_staged",
      target_sha: tip,
    });
  });

  it("commits_behind is null when upstream rewrote the pinned commit away", () => {
    const { upstream, consumer, sha } = setup();
    // Precondition: the old pinned commit stays in the consumer's object store.
    expect(() => consumer.git("cat-file", "-e", `${sha}^{commit}`)).not.toThrow();
    upstream.write({ [`${SUBPATH}/a.md`]: editLine(2, "upstream") });
    upstream.git("add", "-A");
    upstream.git("commit", "-q", "--amend", "-m", "upstream: rewritten");
    const res = sync(consumer, [DIR]);
    expect(res.exitCode).toBe(0);
    expect(res.json.state).toBe("merge_staged");
    expect(res.json.sha_before).toBe(sha);
    expect(res.json.sha_after).toBe(upstream.git("rev-parse", "HEAD"));
    expect(res.json.commits_behind).toBeNull();
    expect(() => consumer.git("cat-file", "-e", `${sha}^{commit}`)).not.toThrow();
  });

  it("AC-4 a merge start leaves nothing under scratch in git status", () => {
    const { upstream, consumer } = setup();
    upstreamEditsA(upstream);
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    expect(existsSync(join(scratchOf(consumer, DIR), "plan.json"))).toBe(true);
    const status = statusAll(consumer);
    expect(status).toContain(`${DIR}/a.md`);
    const lines = status.split("\n");
    for (const line of lines) expect(line).not.toContain(".vendor-sync/scratch/");
  });

  it("AC-8 (sync) an old git stops the start before it writes anything", () => {
    const { upstream, consumer } = setup();
    upstreamEditsA(upstream);
    const shim = gitShim({ version: "2.34.1" });
    shims.push(shim);
    const before = [statusAll(consumer), consumer.git("for-each-ref")];
    const res = sync(consumer, [DIR], shim.env);
    expect(res.exitCode).toBe(2);
    expect(res.json.error.message).toBe("vendor-sync needs git 2.40.0 or newer; found 2.34.1");
    expect([statusAll(consumer), consumer.git("for-each-ref")]).toEqual(before);
  });

  it("a failing git status stops the start before it writes anything", () => {
    const { upstream, consumer } = setup();
    upstreamEditsA(upstream);
    const shim = gitShim({ failOn: ["status"] });
    shims.push(shim);
    const before = [statusAll(consumer), consumer.git("for-each-ref")];
    const res = sync(consumer, [DIR], shim.env);
    expect(res.exitCode).toBe(2);
    expect(res.json.error.message).toBe("git status failed");
    expect([statusAll(consumer), consumer.git("for-each-ref")]).toEqual(before);
  });

  describe("AC-9 (sync) an open action", () => {
    it("AC-9 (sync) a sync start on an open sync offers resume, abort and leave", () => {
      const { upstream, consumer } = setup();
      consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: editLine(2, "local") });
      upstreamEditsA(upstream);
      expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
      expect(consumer.git("ls-files", "-u", "--", DIR)).not.toBe("");
      const before = snapshot(consumer);
      const res = sync(consumer, [DIR]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.data.choices).toEqual(["resume", "abort", "leave"]);
      expect(snapshot(consumer)).toEqual(before);
    });

    it("AC-9 (sync) a sync start on an open add offers abort and leave", () => {
      const upstream = buildUpstream(demoUpstreamFiles());
      const consumer = buildConsumer({
        [`${DIR}/a.md`]: "local a\n",
        [`${DIR}/SKILL.md`]: "# demo skill\n",
        [`${DIR}/local.md`]: "local only\n",
      });
      repos.push(upstream, consumer);
      const add = runScript("vendor-add", [upstream.root, SUBPATH, DIR], consumer.root);
      expect(add.json.state).toBe("merge_staged");
      const before = snapshot(consumer);
      const res = sync(consumer, [DIR]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.data.choices).toEqual(["abort", "leave"]);
      expect(snapshot(consumer)).toEqual(before);
    });
  });

  describe("a change staged outside <dir>", () => {
    it("stops the start before anything is written", () => {
      const { upstream, consumer } = setup();
      upstreamEditsA(upstream);
      consumer.write({ "other.txt": "staged\n" });
      consumer.git("add", "--", "other.txt");
      const before = [snapshot(consumer), consumer.git("for-each-ref")];
      const res = sync(consumer, [DIR]);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe(`staged changes outside ${DIR}: other.txt`);
      expect(res.json.error.hint).toBe("commit or unstage them, then re-run");
      expect([snapshot(consumer), consumer.git("for-each-ref")]).toEqual(before);
      expect(readManifest(consumer, DIR).in_progress).toBeNull();
      expect(existsSync(scratchOf(consumer, DIR))).toBe(false);
    });

    it("an unstaged edit or an untracked file outside <dir> does not stop the start", () => {
      const { upstream, consumer } = setup();
      upstreamEditsA(upstream);
      consumer.write({ ".keep": "unstaged\n", "untracked.txt": "u\n" });
      expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    });

    it("a staged gitlink stops the start despite diff.ignoreSubmodules=all", () => {
      const { upstream, consumer } = setup();
      upstreamEditsA(upstream);
      consumer.git("config", "diff.ignoreSubmodules", "all");
      const oid = consumer.git("rev-parse", "HEAD");
      consumer.git("update-index", "--add", "--cacheinfo", `160000,${oid},sm`);
      const res = sync(consumer, [DIR]);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe(`staged changes outside ${DIR}: sm`);
      expect(readManifest(consumer, DIR).in_progress).toBeNull();
    });

    it("a git operation in progress is reported before the staged change", () => {
      const { upstream, consumer } = setup();
      upstreamEditsA(upstream);
      consumer.write({ "other.txt": "staged\n" });
      consumer.git("add", "--", "other.txt");
      plantGitOperation(consumer, "MERGE_HEAD");
      const res = sync(consumer, [DIR]);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe("another git operation is in progress: MERGE_HEAD");
    });
  });

  describe("AC-10 (sync) a dirty directory or a git operation", () => {
    it("AC-10 (sync) an uncommitted edit in the directory stops the start", () => {
      const { upstream, consumer } = setup();
      upstreamEditsA(upstream);
      consumer.write({
        [`${DIR}/a.md`]: "dirty\n",
        [`${DIR}/SKILL.md`]: "staged\n",
        [`${DIR}/new.txt`]: "untracked\n",
      });
      consumer.git("add", "--", `${DIR}/SKILL.md`);
      const before = [snapshot(consumer), consumer.git("for-each-ref")];
      const res = sync(consumer, [DIR]);
      expect(res.exitCode).toBe(2);
      expect(res.json.error.message).toBe(
        `${DIR} has uncommitted changes: ${DIR}/SKILL.md, ${DIR}/a.md, ${DIR}/new.txt`,
      );
      expect(res.json.error.hint).toBe("commit or discard them, then re-run");
      expect([snapshot(consumer), consumer.git("for-each-ref")]).toEqual(before);
      expect(readManifest(consumer, DIR).in_progress).toBeNull();
    });

    for (const name of GIT_OPERATIONS) {
      it(`AC-10 (sync) a git operation in progress stops the start (${name})`, () => {
        const { upstream, consumer } = setup();
        upstreamEditsA(upstream);
        plantGitOperation(consumer, name);
        const before = [snapshot(consumer), consumer.git("for-each-ref")];
        const res = sync(consumer, [DIR]);
        expect(res.exitCode).toBe(2);
        expect(res.json.error.message).toBe(`another git operation is in progress: ${name}`);
        expect([snapshot(consumer), consumer.git("for-each-ref")]).toEqual(before);
        expect(readManifest(consumer, DIR).in_progress).toBeNull();
      });
    }
  });

  describe("AC-16 base check", () => {
    const missing = `the stored base for ${DIR} is missing from HEAD`;
    const mismatch = (sha: string) =>
      `the stored base for ${DIR} does not match the pinned upstream commit ${sha}`;

    function expectBaseCheckFails(consumer: Repo, message: string, choices: string[]) {
      const before = snapshot(consumer);
      const res = sync(consumer, [DIR]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe(message);
      expect(res.json.error.data.choices).toEqual(choices);
      expect(snapshot(consumer)).toEqual(before);
      expect(existsSync(scratchOf(consumer, DIR))).toBe(false);
    }

    it("AC-16 a base that was never committed", () => {
      const { upstream, consumer } = setup();
      consumer.git("rm", "-r", "-q", "--cached", "--", BASE);
      consumer.git("commit", "-q", "-m", "consumer: uncommit the base");
      expect(existsSync(join(consumer.root, BASE, "a.md"))).toBe(true);
      upstreamEditsA(upstream);
      expectBaseCheckFails(consumer, missing, ["base_from_pin", "leave"]);
    });

    it("AC-16 a base deleted and committed", () => {
      const { upstream, consumer } = setup();
      consumer.commitDeletion("consumer: delete the base", [BASE]);
      upstreamEditsA(upstream);
      expectBaseCheckFails(consumer, missing, ["base_from_pin", "leave"]);
    });

    it("AC-16 a base file edited and committed", () => {
      const { upstream, consumer, sha } = setup();
      consumer.commit("consumer: edit the base", { [`${BASE}/a.md`]: "edited\n" });
      upstreamEditsA(upstream);
      expectBaseCheckFails(consumer, mismatch(sha), ["base_from_pin", "leave"]);
    });

    it("AC-16 a base committed from another pinned commit", () => {
      const upstream = buildUpstream(demoUpstreamFiles());
      const older = upstream.git("rev-parse", "HEAD");
      upstream.commit("upstream: edit b.md", { [`${SUBPATH}/nested/b.md`]: "b2\n" });
      const consumer = buildConsumer();
      repos.push(upstream, consumer);
      establish(upstream, consumer);
      patchManifest(consumer, DIR, {
        sha: older,
        base_tree: consumer.git("rev-parse", `${older}:${SUBPATH}`),
      });
      consumer.commit("consumer: pin the older commit", {});
      upstreamEditsA(upstream);
      expectBaseCheckFails(consumer, mismatch(older), ["base_from_pin", "leave"]);
    });

    // A deleted base, an upstream that rewrote its history, and a consumer that dropped the
    // tracking ref and pruned: the pinned commit is gone from the object store.
    function gcFixture() {
      const { upstream, consumer, sha } = setup();
      consumer.commitDeletion("consumer: delete the base", [BASE]);
      upstream.write({ [`${SUBPATH}/a.md`]: editLine(2, "upstream") });
      upstream.git("add", "-A");
      upstream.git("commit", "-q", "--amend", "-m", "upstream: rewritten");
      consumer.git("update-ref", "-d", `refs/vendor/${DIR}`);
      consumer.git("reflog", "expire", "--expire=now", "--all");
      consumer.git("gc", "-q", "--prune=now");
      expect(() => consumer.git("cat-file", "-e", `${sha}^{commit}`)).toThrow();
      return { upstream, consumer, sha };
    }

    it("AC-16 a pinned commit gone from the object store offers without_base", () => {
      const { consumer } = gcFixture();
      expectBaseCheckFails(consumer, missing, ["without_base", "leave"]);
    });

    it("--base-from-pin without the pinned commit exits 1", () => {
      const { consumer, sha } = gcFixture();
      const before = snapshot(consumer);
      const res = sync(consumer, [DIR, "--base-from-pin"]);
      expect(res.exitCode).toBe(1);
      expect(res.json.error.message).toBe(
        `the pinned commit ${sha} is not available; choose without_base instead`,
      );
      expect(snapshot(consumer)).toEqual(before);
      expect(existsSync(scratchOf(consumer, DIR))).toBe(false);
    });
  });

  it("--base-from-pin merges against the pinned commit without the base check", () => {
    const { upstream, consumer, sha } = setup();
    consumer.commitDeletion("consumer: delete the base", [BASE]);
    consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: editLine(7, "local") });
    upstreamEditsA(upstream);
    const res = sync(consumer, [DIR, "--base-from-pin"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.state).toBe("merge_staged");
    expect(res.json.base).toBe(sha);
    expect(res.json.notes).toEqual([]);
    expect(res.json.files).toEqual([
      { path: "a.md", upstream_changes: "modified", local_changes: "modified" },
    ]);
    expect(consumer.git("ls-files", "-u", "--", DIR)).toBe("");
    expect(consumer.git("status", "--porcelain", "--", ".vendor-sync/base")).toBe("");
  });

  it("AC-18 --without-base merges against the empty tree", () => {
    const { upstream, consumer } = setup();
    consumer.commitDeletion("consumer: delete the base", [BASE]);
    consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: editLine(7, "local") });
    upstreamEditsA(upstream);
    const res = sync(consumer, [DIR, "--without-base"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.state).toBe("merge_staged");
    expect(res.json.base).toBeNull();
    expect(res.json.files).toEqual([{ path: "a.md", presence: "both" }]);
    expect(res.json.notes).toEqual(["no_base"]);
    const a = consumer.git("status", "--porcelain=v2", "--", `${DIR}/a.md`);
    expect(a.split(" ").slice(0, 2)).toEqual(["u", "AA"]);
  });

  it("flags only matter when merging: --without-base on an up-to-date connection", () => {
    const { upstream, consumer, sha } = setup();
    const res = sync(consumer, [DIR, "--without-base"]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({ state: "up_to_date", ...identity(upstream), sha });
    expect(statusAll(consumer)).toBe("");
  });

  it("an upstream path gone at the tip stops the start", () => {
    const { upstream, consumer } = setup();
    upstream.commitDeletion("upstream: drop the skill", [SUBPATH]);
    const before = snapshot(consumer);
    const res = sync(consumer, [DIR]);
    expect(res.exitCode).toBe(2);
    expect(res.json.error.message).toBe(
      `upstream path absent at ${upstream.git("rev-parse", "HEAD")}: ${SUBPATH}`,
    );
    expect(snapshot(consumer)).toEqual(before);
  });

  it("AC-38 an ignored file at a path upstream adds stops the start before any write", () => {
    const { upstream, consumer } = setup();
    consumer.commit("consumer: ignore logs", { ".gitignore": "*.log\n" });
    consumer.write({ [`${DIR}/new.log`]: "MINE\n" });
    upstreamEditsA(upstream);
    upstream.commit("upstream: add new.log", { [`${SUBPATH}/new.log`]: "up\n" });
    const before = snapshot(consumer);
    const res = sync(consumer, [DIR]);
    expect(res.exitCode).toBe(2);
    expect(res.json.error.message).toBe(`${DIR} holds files upstream would overwrite: new.log`);
    expect(res.json.error.hint).toBe(`move them out of ${DIR}, then re-run`);
    expect(snapshot(consumer)).toEqual(before);
    expect(readFileSync(join(consumer.root, DIR, "new.log"), "utf8")).toBe("MINE\n");
    expect(readManifest(consumer, DIR).in_progress).toBeNull();
    expect(existsSync(scratchOf(consumer, DIR))).toBe(false);
    expect(listRefs(consumer, "refs/vendor-*")).toEqual([]);
  });

  it.skipIf(!CASE_INSENSITIVE_FS)(
    `a tracked file upstream renames only in case is no collision ${NEEDS_CASE_INSENSITIVE_FS}`,
    () => {
      const { upstream, consumer } = setup({
        ...demoUpstreamFiles(),
        [`${SUBPATH}/Readme.md`]: "readme\n",
      });
      upstream.git("mv", `${SUBPATH}/Readme.md`, `${SUBPATH}/README.md`);
      upstream.commit("upstream: rename Readme.md", { [`${SUBPATH}/README.md`]: "README\n" });
      const res = sync(consumer, [DIR]);
      expect(res.exitCode).toBe(0);
      expect(res.json.state).toBe("merge_staged");
      const names = readdirSync(join(consumer.root, DIR));
      expect(names).toContain("README.md");
      expect(names).not.toContain("Readme.md");
      expect(readFileSync(join(consumer.root, DIR, "README.md"), "utf8")).toBe("README\n");
      expect(consumer.git("ls-files", "-s", "--", `${DIR}/README.md`, `${DIR}/Readme.md`)).toBe(
        `100644 ${consumer.git("rev-parse", `${upstream.git("rev-parse", "HEAD")}:${SUBPATH}/README.md`)} 0\t${DIR}/README.md`,
      );
    },
  );

  it.skipIf(!CASE_INSENSITIVE_FS)(
    `a tracked file whose on-disk name differs only in case is no collision ${NEEDS_CASE_INSENSITIVE_FS}`,
    () => {
      const { upstream, consumer } = setup({
        ...demoUpstreamFiles(),
        [`${SUBPATH}/Readme.md`]: "readme\n",
      });
      const abs = join(consumer.root, DIR);
      rmSync(join(abs, "Readme.md"));
      writeFileSync(join(abs, "README.md"), "readme\n");
      expect(statusAll(consumer)).toBe("");
      upstream.git("mv", `${SUBPATH}/Readme.md`, `${SUBPATH}/README.md`);
      upstream.git("commit", "-q", "-m", "upstream: rename Readme.md, content unchanged");
      const res = sync(consumer, [DIR]);
      expect(res.exitCode).toBe(0);
      expect(res.json.state).toBe("merge_staged");
    },
  );

  it.skipIf(!CASE_INSENSITIVE_FS)(
    `AC-20 --abort of a case-only rename writes HEAD's name back, and the next start runs ${NEEDS_CASE_INSENSITIVE_FS}`,
    () => {
      const { upstream, consumer } = setup({
        ...demoUpstreamFiles(),
        [`${SUBPATH}/Readme.md`]: "readme\n",
      });
      upstream.git("mv", `${SUBPATH}/Readme.md`, `${SUBPATH}/README.md`);
      upstream.git("commit", "-q", "-m", "upstream: rename Readme.md, content unchanged");
      expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
      const res = sync(consumer, [DIR, "--abort"]);
      expect(res.exitCode).toBe(0);
      expect(res.json.restored).toEqual(["Readme.md"]);
      expect(res.json.removed).toEqual(["README.md"]);
      const names = readdirSync(join(consumer.root, DIR));
      expect(names).toContain("Readme.md");
      expect(names).not.toContain("README.md");
      expect(readFileSync(join(consumer.root, DIR, "Readme.md"), "utf8")).toBe("readme\n");
      expect(statusAll(consumer)).toBe("");
      const again = sync(consumer, [DIR]);
      expect(again.exitCode).toBe(0);
      expect(again.json.state).toBe("merge_staged");
    },
  );
});

describe("vendor-sync --continue", () => {
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
  const head = (repo: Repo) => repo.git("rev-parse", "HEAD");
  const resolveA = (consumer: Repo, content = "resolved\n") => {
    writeFileSync(join(consumer.root, DIR, "a.md"), content);
    consumer.git("add", "--", `${DIR}/a.md`);
  };
  // A sync whose a.md conflicts: both sides changed line 2.
  function conflicted() {
    const f = setup();
    f.consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: editLine(2, "local") });
    const tip = upstreamEditsA(f.upstream);
    expect(sync(f.consumer, [DIR]).json.state).toBe("merge_staged");
    expect(f.consumer.git("ls-files", "-u", "--", DIR)).not.toBe("");
    return { ...f, tip };
  }
  // A sync that merges cleanly: the local side changed line 7, upstream line 2.
  function clean() {
    const f = setup();
    f.consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: editLine(7, "local") });
    const tip = upstreamEditsA(f.upstream);
    expect(sync(f.consumer, [DIR]).json.state).toBe("merge_staged");
    return { ...f, tip };
  }

  it("an unmerged file in the directory stops --continue on pin_ready and commits nothing", () => {
    const { upstream, consumer } = setup();
    upstream.commit("upstream: readme", { "plugins/demo/README.md": "new\n" });
    expect(sync(consumer, [DIR]).json.state).toBe("pin_ready");
    plantUnmerged(consumer, `${DIR}/a.md`);
    const before = [head(consumer), consumer.git("ls-files", "-s"), statusAll(consumer)];
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(1);
    expect(res.json.error.message).toBe(`1 files in ${DIR} are still unmerged`);
    expect(res.json.error.data).toEqual({ unresolved: ["a.md"] });
    expect([head(consumer), consumer.git("ls-files", "-s"), statusAll(consumer)]).toEqual(before);
    expect(readManifest(consumer, DIR).in_progress?.state).toBe("pin_ready");
  });

  it("AC-15 AC-30 --continue after pin_ready commits only the pin and the base, files []", () => {
    const { upstream, consumer, sha } = setup();
    const tip = upstream.commit("upstream: readme", { "plugins/demo/README.md": "new\n" });
    expect(sync(consumer, [DIR]).json.state).toBe("pin_ready");
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({
      state: "synced",
      ...identity(upstream),
      sha_before: sha,
      sha_after: tip,
      commit: head(consumer),
      files: [],
    });
    expect(Object.keys(res.json)).toEqual([
      "state",
      "dir",
      "slug",
      "repo",
      "path",
      "ref",
      "sha_before",
      "sha_after",
      "commit",
      "files",
    ]);
    const committed = JSON.parse(consumer.git("show", `HEAD:${DIR}/.vendor.json`));
    expect(committed.sha).toBe(tip);
    expect(committed.in_progress).toBeNull();
    expect(consumer.git("rev-parse", `HEAD:${BASE}`)).toBe(
      consumer.git("rev-parse", `${tip}:${SUBPATH}`),
    );
    expect(statusAll(consumer)).toBe("");
  });

  it("AC-3 (sync) the commit stores the new base with its attributes", () => {
    const { upstream, consumer } = setup();
    consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: editLine(7, "local") });
    upstream.write({ [`${SUBPATH}/a.md`]: editLine(2, "upstream") });
    upstream.git("rm", "-q", "--", `${SUBPATH}/nested/b.md`);
    const tip = upstream.commit("upstream: edit a.md, drop b.md", {});
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    expect(sync(consumer, [DIR, "--continue"]).exitCode).toBe(0);
    const base = consumer.git("rev-parse", `HEAD:${BASE}`);
    expect(base).toBe(readManifest(consumer, DIR).base_tree);
    expect(base).toBe(consumer.git("rev-parse", `${tip}:${SUBPATH}`));
    expect(consumer.git("ls-tree", "-r", "--name-only", "HEAD", "--", BASE).split("\n")).toEqual([
      `${BASE}/SKILL.md`,
      `${BASE}/a.md`,
    ]);
    expect(existsSync(join(consumer.root, BASE, "nested/b.md"))).toBe(false);
    const attrs = consumer.git(
      "check-attr",
      "diff",
      "merge",
      "linguist-generated",
      "--",
      `${BASE}/a.md`,
    );
    expect(attrs.split("\n").map((line) => line.split(": ")[2])).toEqual(["unset", "unset", "set"]);
  });

  it("AC-17 --base-from-pin merges, and after --continue the base check passes again", () => {
    const { upstream, consumer } = setup();
    consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: editLine(8, "local") });
    upstreamEditsA(upstream, 1);
    consumer.commitDeletion("consumer: delete the base", [BASE]);
    const start = sync(consumer, [DIR, "--base-from-pin"]);
    expect(start.exitCode).toBe(0);
    expect(start.json.state).toBe("merge_staged");
    expect(changes(consumer)).toEqual([`.M ${DIR}/.vendor.json`, `M. ${DIR}/a.md`]);
    expect(consumer.git("status", "--porcelain", "--", ".vendor-sync/base")).toBe("");

    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.state).toBe("synced");

    upstream.commit("upstream: edit a.md again", { [`${SUBPATH}/a.md`]: "again\n" });
    const next = sync(consumer, [DIR]);
    expect(next.exitCode).toBe(0);
    expect(["merge_staged", "pin_ready"]).toContain(next.json.state);
  });

  it("AC-19 (sync) --continue refuses while a file is unmerged and writes nothing", () => {
    const { consumer } = conflicted();
    writeFileSync(join(consumer.root, DIR, "a.md.orig"), "backup\n");
    const before = { ...snapshot(consumer), head: head(consumer) };
    const plan = readFileSync(join(scratchOf(consumer, DIR), "plan.json"), "utf8");
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(1);
    expect(res.json.error.message).toBe(`1 files in ${DIR} are still unmerged`);
    expect(res.json.error.data.unresolved).toEqual(["a.md"]);
    expect({ ...snapshot(consumer), head: head(consumer) }).toEqual(before);
    expect(listFiles(scratchOf(consumer, DIR))).toEqual([".gitignore", "plan.json"]);
    expect(readFileSync(join(scratchOf(consumer, DIR), "plan.json"), "utf8")).toBe(plan);
  });

  it("AC-10 (sync) --continue stops while another git operation is in progress", () => {
    const { consumer } = conflicted();
    resolveA(consumer);
    plantGitOperation(consumer, "MERGE_HEAD");
    const before = { ...snapshot(consumer), head: head(consumer) };
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(2);
    expect(res.json.error.message).toBe("another git operation is in progress: MERGE_HEAD");
    expect({ ...snapshot(consumer), head: head(consumer) }).toEqual(before);
  });

  it("a plan for another target stops --continue", () => {
    const { consumer, tip } = clean();
    const planPath = join(scratchOf(consumer, DIR), "plan.json");
    const other = "f".repeat(40);
    writeFileSync(planPath, readFileSync(planPath, "utf8").replace(tip, other));
    const before = head(consumer);
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(2);
    expect(res.json.error.message).toBe(
      `plan.json targets ${other}, but the open sync targets ${tip}`,
    );
    expect(res.json.error.hint).toBe("discard it with --abort");
    expect(head(consumer)).toBe(before);
  });

  it("a missing plan stops --continue", () => {
    const { consumer } = clean();
    const planPath = join(scratchOf(consumer, DIR), "plan.json");
    rmSync(planPath);
    const before = head(consumer);
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(2);
    expect(res.json.error.message).toBe(`scratch is missing: ${planPath}`);
    expect(head(consumer)).toBe(before);
  });

  it("AC-27 (sync) --continue makes exactly one commit holding only the tool's paths", () => {
    const { upstream, consumer, sha, tip } = conflicted();
    resolveA(consumer);
    const before = Number(consumer.git("rev-list", "--count", "HEAD"));
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    expect(res.json).toEqual({
      state: "synced",
      ...identity(upstream),
      sha_before: sha,
      sha_after: tip,
      commit: head(consumer),
      files: ["a.md"],
    });
    expect(Number(consumer.git("rev-list", "--count", "HEAD"))).toBe(before + 1);
    expect(consumer.git("log", "-1", "--format=%P").split(" ")).toHaveLength(1);
    expect(consumer.git("log", "-1", "--format=%s")).toBe(
      `vendor-sync: sync ${DIR} to ${tip.slice(0, 7)}`,
    );
    const committed = consumer.git("show", "--name-only", "--format=", "HEAD").split("\n");
    for (const path of committed) expect(path).toMatch(new RegExp(`^(${DIR}|\\.vendor-sync)/`));
    expect(committed).toContain(`${DIR}/a.md`);
    expect(committed).toContain(`${DIR}/.vendor.json`);
    expect(readManifest(consumer, DIR).in_progress).toBeNull();
    expect(existsSync(scratchOf(consumer, DIR))).toBe(false);
    expect(statusAll(consumer)).toBe("");
  });

  it("AC-28 --continue refuses a staged change outside, then commits without it or the untracked backup", () => {
    const { consumer } = conflicted();
    resolveA(consumer);
    consumer.write({ "other.txt": "staged\n" });
    consumer.git("add", "--", "other.txt");
    writeFileSync(join(consumer.root, DIR, "a.md.orig"), "backup\n");
    const before = { ...snapshot(consumer), head: head(consumer) };
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(1);
    expect(res.json.error.message).toBe(`staged changes outside ${DIR}: other.txt`);
    expect(res.json.error.hint).toBe("commit or unstage them, then re-run");
    expect({ ...snapshot(consumer), head: head(consumer) }).toEqual(before);
    expect(readManifest(consumer, DIR).in_progress?.state).toBe("merge_staged");

    consumer.git("rm", "-q", "--cached", "--", "other.txt");
    expect(sync(consumer, [DIR, "--continue"]).exitCode).toBe(0);
    const committed = consumer
      .git("diff-tree", "-r", "--name-only", "--ignore-submodules=none", "HEAD~1", "HEAD")
      .split("\n");
    for (const path of committed) expect(path).toMatch(new RegExp(`^(${DIR}|\\.vendor-sync)/`));
    expect(committed).not.toContain(`${DIR}/a.md.orig`);
    expect(changes(consumer)).toEqual(["?? other.txt", `?? ${DIR}/a.md.orig`]);
  });

  it("--continue refuses a staged gitlink outside despite diff.ignoreSubmodules=all", () => {
    const { consumer } = conflicted();
    resolveA(consumer);
    consumer.git("config", "diff.ignoreSubmodules", "all");
    const oid = consumer.git("rev-parse", "HEAD");
    consumer.git("update-index", "--add", "--cacheinfo", `160000,${oid},sm`);
    const before = head(consumer);
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(1);
    expect(res.json.error.message).toBe(`staged changes outside ${DIR}: sm`);
    expect(head(consumer)).toBe(before);
    expect(readManifest(consumer, DIR).in_progress?.state).toBe("merge_staged");
  });

  it("AC-29 a rejected commit leaves the sync open and as it was; a re-run succeeds", () => {
    const { consumer } = clean();
    const gitDir = consumer.git("rev-parse", "--absolute-git-dir");
    writeFileSync(
      join(gitDir, "hooks", "pre-commit"),
      "#!/bin/sh\n" +
        "if [ -f .git/fail-once ]; then\n" +
        "  rm .git/fail-once\n" +
        "  echo 'hook: rejected once' >&2\n" +
        "  exit 1\n" +
        "fi\n",
      { mode: 0o755 },
    );
    writeFileSync(join(gitDir, "fail-once"), "");
    const before = {
      ...snapshot(consumer),
      head: head(consumer),
      base: listFiles(join(consumer.root, BASE)),
    };
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("hook: rejected once");
    expect(readManifest(consumer, DIR).in_progress?.state).toBe("merge_staged");
    expect({
      ...snapshot(consumer),
      head: head(consumer),
      base: listFiles(join(consumer.root, BASE)),
    }).toEqual(before);

    const again = sync(consumer, [DIR, "--continue"]);
    expect(again.exitCode).toBe(0);
    expect(again.json.state).toBe("synced");
  });

  it("AC-30 files lists the paths the commit changed, whatever the resolution", () => {
    const names = ["u", "l", "c", "r", "same"];
    const side = (prefix: string, text: (n: string) => string) =>
      Object.fromEntries(names.map((n) => [`${prefix}/${n}.md`, text(n)]));
    const { upstream, consumer } = setup({
      ...demoUpstreamFiles(),
      ...side(SUBPATH, (n) => `orig ${n}\n`),
    });
    consumer.commit("consumer: local edits", {
      ...side(DIR, (n) => `local ${n}\n`),
      [`${DIR}/same.md`]: "both\n",
    });
    upstream.commit("upstream: edits", {
      ...side(SUBPATH, (n) => `up ${n}\n`),
      [`${SUBPATH}/same.md`]: "both\n",
    });
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    consumer.write({
      [`${DIR}/u.md`]: "up u\n",
      [`${DIR}/l.md`]: "local l\n",
      [`${DIR}/c.md`]: "local c\nup c\n",
    });
    consumer.git("add", "--", `${DIR}/u.md`, `${DIR}/l.md`, `${DIR}/c.md`);
    consumer.git("rm", "-q", "--", `${DIR}/r.md`);
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    // l.md kept local and same.md equal on both sides: the commit leaves them as they were.
    expect(res.json.files).toEqual(["c.md", "r.md", "u.md"]);
  });

  it("AC-30 a file outside the plan that the user edits before --continue is in files", () => {
    const { consumer } = clean();
    consumer.write({ [`${DIR}/SKILL.md`]: "edited during the review\n" });
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.files).toEqual(["SKILL.md", "a.md"]);
  });

  it("AC-30 a mode-only upstream change with a local edit is in files", () => {
    const { upstream, consumer } = setup();
    consumer.commit("consumer: local edit", { [`${DIR}/a.md`]: editLine(7, "local") });
    upstream.chmodX(`${SUBPATH}/a.md`);
    upstream.commit("upstream: chmod +x a.md", {});
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.files).toEqual(["a.md"]);
    expect(consumer.git("ls-tree", "HEAD", "--", `${DIR}/a.md`).split(" ")[0]).toBe("100755");
  });

  it("a local chmod +x kept with an upstream content change is in files", () => {
    const { upstream, consumer } = setup();
    consumer.chmodX(`${DIR}/a.md`);
    consumer.commit("consumer: chmod +x a.md", {});
    upstreamEditsA(upstream);
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    resolveA(consumer, editLine(2, "upstream"));
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.files).toEqual(["a.md"]);
    expect(consumer.git("ls-tree", "HEAD", "--", `${DIR}/a.md`).split(" ")[0]).toBe("100755");
  });
});

describe("vendor-sync --continue commits what git's --only mode cannot", () => {
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
  const tracked = (repo: Repo, ...pathspec: string[]) =>
    repo.git("ls-tree", "-r", "--name-only", "HEAD", "--", ...pathspec).split("\n");

  it("AC-21 an upstream file that became a directory commits at --continue", () => {
    const { upstream, consumer } = setup();
    upstream.git("rm", "-q", "--", `${SUBPATH}/a.md`);
    const tip = upstream.commit("upstream: a.md becomes a directory", {
      [`${SUBPATH}/a.md/x`]: "x\n",
    });
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.state).toBe("synced");
    expect(tracked(consumer, DIR)).toContain(`${DIR}/a.md/x`);
    expect(tracked(consumer, DIR)).not.toContain(`${DIR}/a.md`);
    expect(consumer.git("rev-parse", `HEAD:${BASE}`)).toBe(
      consumer.git("rev-parse", `${tip}:${SUBPATH}`),
    );
    expect(statusAll(consumer)).toBe("");
  });

  it.skipIf(!CASE_INSENSITIVE_FS)(
    `AC-21 a case-only rename commits at --continue ${NEEDS_CASE_INSENSITIVE_FS}`,
    () => {
      const { upstream, consumer } = setup({
        ...demoUpstreamFiles(),
        [`${SUBPATH}/Readme.md`]: "readme\n",
      });
      upstream.git("mv", `${SUBPATH}/Readme.md`, `${SUBPATH}/README.md`);
      upstream.commit("upstream: rename Readme.md", { [`${SUBPATH}/README.md`]: "README\n" });
      expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
      const res = sync(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(0);
      expect(res.json.state).toBe("synced");
      expect(tracked(consumer, DIR)).toContain(`${DIR}/README.md`);
      expect(tracked(consumer, DIR)).not.toContain(`${DIR}/Readme.md`);
      expect(tracked(consumer, BASE)).toContain(`${BASE}/README.md`);
      expect(tracked(consumer, BASE)).not.toContain(`${BASE}/Readme.md`);
      expect(statusAll(consumer)).toBe("");
    },
  );

  it("AC-21 an upstream that gained a submodule entry syncs, leaving the gitlink out", () => {
    const { upstream, consumer } = setup();
    const sm = upstream.git("rev-parse", "HEAD");
    upstream.git("update-index", "--add", "--cacheinfo", `160000,${sm},${SUBPATH}/sm`);
    upstream.git("commit", "-q", "-m", "upstream: add a submodule entry");
    const pin = sync(consumer, [DIR]);
    expect(pin.json.state).toBe("pin_ready");
    expect(pin.json.skipped_submodules).toEqual(["sm"]);
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.state).toBe("synced");
    expect(res.json).not.toHaveProperty("skipped_submodules");
    expect(consumer.git("ls-files", "-s", "--", DIR, ".vendor-sync")).not.toMatch(/^160000/m);
    expect(statusAll(consumer)).toBe("");
  });

  it("merge_staged reports upstream's submodule entries as skipped_submodules", () => {
    const { upstream, consumer } = setup();
    // The edit goes first: Repo.commit stages with `add -A`, which drops an unpopulated gitlink.
    const sm = upstreamEditsA(upstream);
    for (const path of [`${SUBPATH}/sm`, `${SUBPATH}/nested/deep`]) {
      upstream.git("update-index", "--add", "--cacheinfo", `160000,${sm},${path}`);
    }
    upstream.git("commit", "-q", "-m", "upstream: add submodule entries");
    const res = sync(consumer, [DIR]);
    expect(res.exitCode).toBe(0);
    expect(res.json.state).toBe("merge_staged");
    expect(res.json.skipped_submodules).toEqual(["nested/deep", "sm"]);
    const done = sync(consumer, [DIR, "--continue"]);
    expect(done.json.state).toBe("synced");
    expect(done.json).not.toHaveProperty("skipped_submodules");
  });

  it("AC-21 a submodule entry the user tracks inside <dir> survives the sync", () => {
    const { upstream, consumer } = setup();
    const sm = consumer.git("rev-parse", "HEAD");
    consumer.git("update-index", "--add", "--cacheinfo", `160000,${sm},${DIR}/sm`);
    consumer.git("commit", "-q", "-m", "consumer: add a submodule entry");
    // An unpopulated submodule: git status reports a missing directory as a deletion.
    mkdirSync(join(consumer.root, DIR, "sm"));
    upstreamEditsA(upstream);
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.state).toBe("synced");
    expect(consumer.git("ls-tree", "HEAD", "--", `${DIR}/sm`)).toBe(
      `160000 commit ${sm}\t${DIR}/sm`,
    );
    expect(statusAll(consumer)).toBe("");
  });

  it("AC-29 a rejected commit after an unstaged edit inside <dir> leaves the files as they were and the edit staged", () => {
    const { upstream, consumer } = setup();
    upstream.git("rm", "-q", "--", `${SUBPATH}/a.md`);
    upstream.commit("upstream: a.md becomes a directory", { [`${SUBPATH}/a.md/x`]: "x\n" });
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    writeFileSync(join(consumer.root, DIR, "SKILL.md"), "edited, unstaged\n");
    const gitDir = consumer.git("rev-parse", "--absolute-git-dir");
    writeFileSync(join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\necho 'hook: no' >&2\nexit 1\n", {
      mode: 0o755,
    });
    // Every status record (with its index and HEAD oids) but SKILL.md's must stay the same.
    const otherStatus = () =>
      snapshot(consumer)
        .status.split("\n")
        .filter((line) => !line.endsWith(` ${DIR}/SKILL.md`));
    const before = {
      files: snapshot(consumer).files,
      manifest: manifestBytes(consumer),
      head: consumer.git("rev-parse", "HEAD"),
      status: otherStatus(),
    };
    expect(changes(consumer)).toContain(`.M ${DIR}/SKILL.md`);
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("hook: no");
    expect({
      files: snapshot(consumer).files,
      manifest: manifestBytes(consumer),
      head: consumer.git("rev-parse", "HEAD"),
      status: otherStatus(),
    }).toEqual(before);
    expect(before.status.some((line) => line.endsWith(` ${DIR}/.vendor.json`))).toBe(true);
    expect(before.status.some((line) => line.endsWith(` ${DIR}/a.md/x`))).toBe(true);
    expect(changes(consumer)).toContain(`M. ${DIR}/SKILL.md`);
    expect(readManifest(consumer, DIR).in_progress?.state).toBe("merge_staged");
    expect(consumer.git("status", "--porcelain", "--", BASE)).toBe("");
    expect(consumer.git("diff", "--name-only", "--", `${DIR}/SKILL.md`)).toBe("");
    expect(consumer.git("show", `:${DIR}/SKILL.md`)).toBe("edited, unstaged");
  });
});

describe("vendor-sync: an upstream directory that became a file", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  // Upstream gains sub2/q (synced), then replaces the directory sub2/ with the file sub2.
  function dirToFile() {
    const upstream = buildUpstream(demoUpstreamFiles());
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    establish(upstream, consumer);
    upstream.commit("upstream: add sub2/q", { [`${SUBPATH}/sub2/q`]: "q\n" });
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    expect(sync(consumer, [DIR, "--continue"]).json.state).toBe("synced");
    upstream.git("rm", "-r", "-q", "--", `${SUBPATH}/sub2`);
    upstream.commit("upstream: sub2 becomes a file", { [`${SUBPATH}/sub2`]: "f\n" });
    return { upstream, consumer };
  }

  it("AC-21 the start stages the file and --continue commits it", () => {
    const { consumer } = dirToFile();
    const start = sync(consumer, [DIR]);
    expect(start.exitCode).toBe(0);
    expect(start.json.state).toBe("merge_staged");
    expect(readFileSync(join(consumer.root, DIR, "sub2"), "utf8")).toBe("f\n");
    const res = sync(consumer, [DIR, "--continue"]);
    expect(res.exitCode).toBe(0);
    expect(res.json.state).toBe("synced");
    expect(consumer.git("ls-tree", "-r", "--name-only", "HEAD", "--", DIR).split("\n")).toContain(
      `${DIR}/sub2`,
    );
    expect(statusAll(consumer)).toBe("");
  });

  it("AC-20 --abort after the start puts the directory back", () => {
    const { consumer } = dirToFile();
    const before = snapshot(consumer);
    expect(sync(consumer, [DIR]).json.state).toBe("merge_staged");
    const res = sync(consumer, [DIR, "--abort"]);
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(consumer.root, DIR, "sub2/q"), "utf8")).toBe("q\n");
    expect(snapshot(consumer)).toEqual(before);
  });

  it("an ignored file inside the directory still stops the start", () => {
    const { consumer } = dirToFile();
    consumer.commit("consumer: ignore logs", { ".gitignore": "*.log\n" });
    writeFileSync(join(consumer.root, DIR, "sub2", "debug.log"), "mine\n");
    const res = sync(consumer, [DIR]);
    expect(res.exitCode).toBe(2);
    expect(res.json.error.message).toBe(
      `${DIR} holds files upstream would overwrite: sub2/debug.log`,
    );
    expect(readFileSync(join(consumer.root, DIR, "sub2", "debug.log"), "utf8")).toBe("mine\n");
  });
});

describe("vendor-sync: an upstream change of the executable bit alone", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  const mode = (repo: Repo, rev: string, path: string) =>
    repo.git("ls-tree", rev, "--", path).split(" ")[0];

  for (const [name, from, to] of [
    ["chmod -x", 0o755, "100644"],
    ["chmod +x", 0o644, "100755"],
  ] as const) {
    it(`AC-21 ${name} upstream is merged, listed as modified, and committed`, () => {
      const upstream = buildUpstream({
        ...demoUpstreamFiles(),
        [`${SUBPATH}/run.sh`]: "#!/bin/sh\n",
      });
      if (from === 0o755) {
        chmodSync(join(upstream.root, SUBPATH, "run.sh"), from);
        upstream.commit("upstream: make run.sh executable", {});
      }
      const consumer = buildConsumer();
      repos.push(upstream, consumer);
      establish(upstream, consumer);
      chmodSync(join(upstream.root, SUBPATH, "run.sh"), from === 0o755 ? 0o644 : 0o755);
      const tip = upstream.commit(`upstream: ${name} run.sh`, {});
      const start = sync(consumer, [DIR]);
      expect(start.exitCode).toBe(0);
      expect(start.json.state).toBe("merge_staged");
      expect(start.json.files).toEqual([
        { path: "run.sh", upstream_changes: "modified", local_changes: "unchanged" },
      ]);
      const res = sync(consumer, [DIR, "--continue"]);
      expect(res.exitCode).toBe(0);
      expect(res.json.state).toBe("synced");
      expect(mode(consumer, "HEAD", `${DIR}/run.sh`)).toBe(to);
      expect(mode(consumer, "HEAD", `${BASE}/run.sh`)).toBe(to);
      expect(mode(upstream, tip, `${SUBPATH}/run.sh`)).toBe(to);
      expect(statusAll(consumer)).toBe("");
    });
  }
});

describe("vendor-sync on a manifest nested inside another connection", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });

  for (const args of [[], ["--continue"], ["--abort"]]) {
    it(`${["start", ...args].join(" ")} exits 2 and changes nothing`, () => {
      const upstream = buildUpstream(nestedUpstreamFiles());
      const consumer = buildConsumer();
      repos.push(upstream, consumer);
      establish(upstream, consumer, "outer");
      const before = repoState(consumer);
      const res = sync(consumer, ["outer/inner", ...args]);
      expect(res.exitCode, res.stdout).toBe(2);
      expect(res.json.error.message).toBe("outer/inner is inside the vendored directory outer");
      expect(res.json.error.hint).toBe("choose a directory outside it");
      expect(repoState(consumer)).toEqual(before);
    });
  }
});
