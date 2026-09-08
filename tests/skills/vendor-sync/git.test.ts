import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// git.mjs is plain JS with no declarations, so this import is implicitly `any`.
// @ts-expect-error TS7016
import * as gitm from "../../../.claude/skills/vendor-sync/scripts/git.mjs";
// contract.mjs is plain JS with no declarations, so this import is implicitly `any`.
// @ts-expect-error TS7016
import { ScriptError } from "../../../.claude/skills/vendor-sync/scripts/contract.mjs";
import {
  buildConsumer,
  buildUpstream,
  demoUpstreamFiles,
  gitShim,
  LONG_A,
  plantGitOperation,
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

describe("git.mjs part 1", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });
  const track = <T extends { cleanup(): void }>(x: T): T => {
    cleanups.push(() => x.cleanup());
    return x;
  };
  const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vendor-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  it("exports the empty tree and the minimum git version", () => {
    expect(gitm.EMPTY_TREE_OID).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(gitm.MIN_GIT_VERSION).toBe("2.40.0");
  });

  it("git never throws", () => {
    const repo = track(buildConsumer());
    const bad = gitm.git(["no-such-cmd"], repo.root);
    expect(bad.status).not.toBe(0);
    const head = gitm.git(["rev-parse", "HEAD"], repo.root);
    expect(head.status).toBe(0);
    expect(head.raw.endsWith("\n")).toBe(true);
    expect(head.stdout).toBe(head.raw.trim());
    expect(head.stdout).toMatch(/^[0-9a-f]{40}$/);
  });

  it("git env", () => {
    const repo = track(buildConsumer());
    const res = gitm.git(["var", "GIT_AUTHOR_IDENT"], repo.root, {
      env: { GIT_AUTHOR_NAME: "Zed" },
    });
    expect(res.stdout.startsWith("Zed")).toBe(true);
  });

  it("gitBuffer keeps NULs", () => {
    const repo = track(buildConsumer({ "two.txt": "2\n" }));
    const res = gitm.gitBuffer(["ls-files", "-z"], repo.root);
    expect(Buffer.isBuffer(res.stdout)).toBe(true);
    expect([...res.stdout].filter((b: number) => b === 0).length).toBe(2);
    expect(typeof res.stderr).toBe("string");
  });

  it("nulRecords keeps empty middle records and drops the trailing one", () => {
    expect(gitm.nulRecords(Buffer.alloc(0))).toEqual([]);
    expect(gitm.nulRecords(Buffer.from("a\0\0b\0"))).toEqual(["a", "", "b"]);
    expect(gitm.nulRecords(Buffer.from("a\0b"))).toEqual(["a", "b"]);
    expect(gitm.nulRecords(Buffer.from("ä\nx\0"))).toEqual(["ä\nx"]);
  });

  it("gitOrFail fails 2 with git's stderr", () => {
    const repo = track(buildConsumer());
    const err = caught(() => gitm.gitOrFail(["rev-parse", "nope"], "msg", repo.root));
    expect(err).toBeInstanceOf(ScriptError);
    expect(err.exit).toBe(2);
    expect(err.message).toBe("msg");
    expect(typeof err.gitStderr).toBe("string");
    expect(err.gitStderr.length).toBeGreaterThan(0);
  });

  it("repoRoot", () => {
    const repo = track(buildConsumer());
    const sub = join(repo.root, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(gitm.repoRoot(sub)).toBe(repo.root);
    const link = join(tempDir(), "link");
    symlinkSync(repo.root, link);
    expect(gitm.repoRoot(join(link, "a", "b"))).toBe(repo.root);
    const outside = tempDir();
    const err = caught(() => gitm.repoRoot(outside));
    expect(err).toBeInstanceOf(ScriptError);
    expect(err.exit).toBe(2);
    expect(err.message).toBe("not inside a git repository");
    expect(typeof err.gitStderr).toBe("string");
    expect(err.gitStderr.length).toBeGreaterThan(0);
  });

  it("gitDir", () => {
    const repo = track(buildConsumer());
    expect(gitm.gitDir(repo.root)).toBe(join(repo.root, ".git"));
  });

  it("AC-8 requireGitVersion", () => {
    const repo = track(buildConsumer());
    const withVersion = (version: string, fn: () => void) => {
      const shim = gitShim({ version });
      const savedPath = process.env.PATH;
      const savedVersion = process.env.SHIM_VERSION;
      process.env.PATH = shim.env.PATH;
      process.env.SHIM_VERSION = version;
      try {
        fn();
      } finally {
        process.env.PATH = savedPath;
        if (savedVersion === undefined) delete process.env.SHIM_VERSION;
        else process.env.SHIM_VERSION = savedVersion;
        shim.cleanup();
      }
    };
    for (const old of ["2.34.1", "2.39.5"]) {
      withVersion(old, () => {
        const err = caught(() => gitm.requireGitVersion(repo.root));
        expect(err).toBeInstanceOf(ScriptError);
        expect(err.exit).toBe(2);
        expect(err.message).toBe(`vendor-sync needs git 2.40.0 or newer; found ${old}`);
        expect(err.hint).toBe("upgrade git, then re-run");
      });
    }
    for (const ok of ["2.40.0", "2.50.1 (Apple Git-155)"]) {
      withVersion(ok, () => {
        expect(() => gitm.requireGitVersion(repo.root)).not.toThrow();
      });
    }
    withVersion("garbage", () => {
      const err = caught(() => gitm.requireGitVersion(repo.root));
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.exit).toBe(2);
      expect(err.message).toBe("vendor-sync needs git 2.40.0 or newer; found git version garbage");
      expect(err.hint).toBe("upgrade git, then re-run");
    });
  });

  it("requireRepository", () => {
    const repo = track(buildConsumer());
    const sub = join(repo.root, "a");
    mkdirSync(sub, { recursive: true });
    expect(gitm.requireRepository(sub)).toBe(repo.root);
    const outside = caught(() => gitm.requireRepository(tempDir()));
    expect(outside.exit).toBe(2);
    expect(outside.message).toBe("not inside a git repository");
    const shim = gitShim({ version: "2.34.1" });
    const savedPath = process.env.PATH;
    const savedVersion = process.env.SHIM_VERSION;
    process.env.PATH = shim.env.PATH;
    process.env.SHIM_VERSION = "2.34.1";
    try {
      const old = caught(() => gitm.requireRepository(sub));
      expect(old.exit).toBe(2);
      expect(old.message).toBe("vendor-sync needs git 2.40.0 or newer; found 2.34.1");
    } finally {
      process.env.PATH = savedPath;
      if (savedVersion === undefined) delete process.env.SHIM_VERSION;
      else process.env.SHIM_VERSION = savedVersion;
      shim.cleanup();
    }
  });

  it("requireNoGitOperation", () => {
    for (const name of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ]) {
      const repo = track(buildConsumer());
      plantGitOperation(repo, name);
      const err = caught(() => gitm.requireNoGitOperation(repo.root));
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.exit).toBe(2);
      expect(err.message).toBe(`another git operation is in progress: ${name}`);
      expect(err.hint).toBe("finish or abort it, then re-run");
    }
    const clean = track(buildConsumer());
    expect(() => gitm.requireNoGitOperation(clean.root)).not.toThrow();
  });

  it("requireNoGitOperation names the first marker in order", () => {
    const repo = track(buildConsumer());
    plantGitOperation(repo, "rebase-merge");
    plantGitOperation(repo, "MERGE_HEAD");
    const err = caught(() => gitm.requireNoGitOperation(repo.root));
    expect(err.message).toBe("another git operation is in progress: MERGE_HEAD");
  });

  it("uncommittedPaths", () => {
    const repo = track(
      buildConsumer({ "d/f.txt": "f\n", "d/g.txt": "g\n", ".gitignore": "*.log\n" }),
    );
    expect(gitm).not.toHaveProperty("workingTreeClean");
    expect(gitm.uncommittedPaths("d", repo.root)).toEqual([]);
    repo.write({ "d/ignored.log": "x\n" });
    expect(gitm.uncommittedPaths("d", repo.root)).toEqual([]);
    repo.write({ "d/new.txt": "n\n" });
    expect(gitm.uncommittedPaths("d", repo.root)).toEqual(["d/new.txt"]);
    rmSync(join(repo.root, "d/new.txt"));
    expect(gitm.uncommittedPaths("d", repo.root)).toEqual([]);
    repo.write({ "d/f.txt": "changed\n", "outside.txt": "o\n" });
    expect(gitm.uncommittedPaths("d", repo.root)).toEqual(["d/f.txt"]);
    // A staged deletion, a staged rename (both sides, no rename record) and names with spaces.
    repo.git("rm", "-q", "--", "d/g.txt");
    repo.write({ "d/a b.txt": "s\n" });
    expect(gitm.uncommittedPaths("d", repo.root)).toEqual(["d/a b.txt", "d/f.txt", "d/g.txt"]);
    repo.git("checkout", "-q", "HEAD", "--", "d/g.txt");
    rmSync(join(repo.root, "d/a b.txt"));
    repo.git("mv", "d/g.txt", "d/h.txt");
    expect(gitm.uncommittedPaths("d", repo.root)).toEqual(["d/f.txt", "d/g.txt", "d/h.txt"]);
  });

  it("uncommittedPaths treats the directory as a literal pathspec", () => {
    const repo = track(buildConsumer({ "d*/f.txt": "f\n", "dx/f.txt": "f\n" }));
    repo.write({ "dx/f.txt": "changed\n" });
    expect(gitm.uncommittedPaths("d*", repo.root)).toEqual([]);
  });

  it("uncommittedPaths sees untracked files despite status.showUntrackedFiles=no", () => {
    const repo = track(buildConsumer({ "d/f.txt": "f\n", ".gitignore": "*.log\n" }));
    repo.git("config", "status.showUntrackedFiles", "no");
    repo.write({ "d/ignored.log": "x\n" });
    expect(gitm.uncommittedPaths("d", repo.root)).toEqual([]);
    repo.write({ "d/sub/new.txt": "n\n" });
    expect(gitm.uncommittedPaths("d", repo.root)).toEqual(["d/sub/new.txt"]);
  });

  it("uncommittedPaths fails 2 when git status fails", () => {
    const repo = track(buildConsumer({ "d/f.txt": "f\n" }));
    const shim = track(gitShim({ failOn: ["status"] }));
    const savedPath = process.env.PATH;
    process.env.PATH = shim.env.PATH;
    process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
    try {
      const err = caught(() => gitm.uncommittedPaths("d", repo.root));
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.exit).toBe(2);
      expect(err.message).toBe("git status failed");
      expect(err.gitStderr).toContain("shim: refused status");
    } finally {
      process.env.PATH = savedPath;
      delete process.env.SHIM_FAIL;
    }
  });

  it("refs", () => {
    const repo = track(buildConsumer());
    const head = repo.git("rev-parse", "HEAD");
    expect(gitm.trackingRef("x")).toBe("refs/vendor/x");
    expect(gitm.readRef("refs/vendor/x", repo.root)).toBeNull();
    gitm.setRef("refs/vendor/x", head, repo.root);
    expect(gitm.readRef("refs/vendor/x", repo.root)).toBe(head);
    gitm.deleteRef("refs/vendor/x", repo.root);
    expect(gitm.readRef("refs/vendor/x", repo.root)).toBeNull();
    expect(() => gitm.deleteRef("refs/vendor/x", repo.root)).not.toThrow();
  });

  it("fetchTracking", () => {
    const up = track(buildUpstream(demoUpstreamFiles()));
    up.git("tag", "v1");
    const consumer = track(buildConsumer());
    const refsBefore = consumer.git(
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      "refs/tags",
    );
    gitm.fetchTracking(up.root, "main", "s", consumer.root);
    expect(gitm.readRef("refs/vendor/s", consumer.root)).toBe(up.git("rev-parse", "HEAD"));
    expect(consumer.git("for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags")).toBe(
      refsBefore,
    );

    up.write({ "plugins/demo/README.md": "rewritten\n" });
    up.git("add", "-A");
    up.git("commit", "-q", "--amend", "-m", "upstream: rewritten");
    const rewritten = up.git("rev-parse", "HEAD");
    gitm.fetchTracking(up.root, "main", "s", consumer.root);
    expect(gitm.readRef("refs/vendor/s", consumer.root)).toBe(rewritten);

    const err = caught(() => gitm.fetchTracking(up.root, "nope", "s", consumer.root));
    expect(err).toBeInstanceOf(ScriptError);
    expect(err.exit).toBe(2);
    expect(err.message).toBe(`fetch failed: repo=${up.root} ref=nope`);
    expect(err.gitStderr.length).toBeGreaterThan(0);
  });

  it("listRemoteBranches", () => {
    const up = track(buildUpstream(demoUpstreamFiles()));
    up.git("branch", "dev");
    const consumer = track(buildConsumer());
    expect(gitm.listRemoteBranches(up.root, consumer.root)).toEqual(["dev", "main"]);
    expect(gitm.listRemoteBranches(join(tempDir(), "missing"), consumer.root)).toEqual([]);
  });

  it("commit queries", () => {
    const repo = track(buildConsumer());
    const first = repo.git("rev-parse", "HEAD");
    const second = repo.commit("second", { "s.txt": "s\n" });
    expect(gitm.commitExists(second, repo.root)).toBe(true);
    expect(gitm.commitExists("0".repeat(40), repo.root)).toBe(false);
    expect(gitm.resolveCommit("HEAD", repo.root)).toBe(second);
    expect(gitm.resolveCommit("nope", repo.root)).toBeNull();
    expect(gitm.isWellFormedRev("0".repeat(40), repo.root)).toBe(true);
    expect(gitm.isAncestor(first, second, repo.root)).toBe(true);
    expect(gitm.isAncestor(second, first, repo.root)).toBe(false);
  });

  it("commitsBehind", () => {
    const up = track(buildUpstream(demoUpstreamFiles()));
    const first = up.git("rev-parse", "HEAD");
    up.commit("touch a", { [`${SUBPATH}/a.md`]: "a2\n" });
    up.commit("touch readme", { "plugins/demo/README.md": "readme2\n" });
    up.commit("add c", { [`${SUBPATH}/c.md`]: "c\n" });
    const consumer = track(buildConsumer());
    gitm.fetchTracking(up.root, "main", "s", consumer.root);
    const tip = gitm.readRef("refs/vendor/s", consumer.root);
    expect(gitm.commitsBehind(first, tip, SUBPATH, consumer.root)).toBe(2);
  });

  it("pathKind and siblingListing", () => {
    const up = track(buildUpstream(demoUpstreamFiles()));
    const sha = up.git("rev-parse", "HEAD");
    expect(gitm.pathKind(sha, SUBPATH, up.root)).toBe("tree");
    expect(gitm.pathKind(sha, `${SUBPATH}/a.md`, up.root)).toBe("blob");
    expect(gitm.pathKind(sha, "plugins/missing", up.root)).toBeNull();
    expect(gitm.siblingListing(sha, "plugins/demo/nope", up.root)).toEqual(["README.md", "skills"]);
    expect(gitm.siblingListing(sha, "nowhere/at/all", up.root)).toEqual([]);
  });

  it("treeOid", () => {
    const up = track(buildUpstream(demoUpstreamFiles()));
    const sha = up.git("rev-parse", "HEAD");
    expect(gitm.treeOid(sha, SUBPATH, up.root)).toBe(up.git("rev-parse", `${sha}:${SUBPATH}`));
    expect(gitm.treeOid(sha, "", up.root)).toBe(up.git("rev-parse", `${sha}^{tree}`));
    expect(gitm.treeOid(sha, "missing", up.root)).toBeNull();
  });

  it("siblingListing returns unusual names unquoted", () => {
    const up = track(buildUpstream({ "d/ä.md": "a\n", "d/b c.md": "b\n" }));
    const sha = up.git("rev-parse", "HEAD");
    expect(gitm.siblingListing(sha, "d/nope", up.root)).toEqual(["b c.md", "ä.md"]);
  });

  describe("readers fail 2 on a status other than their documented answer", () => {
    // Runs `fn` with git failing (exit 128) on commands starting with `failOn`.
    const withShim = (failOn: string[], fn: () => unknown): any => {
      const shim = track(gitShim({ failOn }));
      const savedPath = process.env.PATH;
      process.env.PATH = shim.env.PATH;
      process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
      try {
        return caught(fn);
      } finally {
        process.env.PATH = savedPath;
        delete process.env.SHIM_FAIL;
      }
    };
    const expectStop = (err: any, failOn: string[]): void => {
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.exit).toBe(2);
      expect(typeof err.gitStderr).toBe("string");
      expect(err.gitStderr).toContain(`shim: refused ${failOn.join(" ")}`);
    };

    it("rev-parse readers: exit 1 is the absent answer, 128 fails 2", () => {
      const repo = track(buildConsumer({ "d/f.txt": "f\n" }));
      const head = repo.git("rev-parse", "HEAD");
      expect(gitm.readRef("refs/vendor/none", repo.root)).toBeNull();
      expect(gitm.treeOid("HEAD", "missing", repo.root)).toBeNull();
      expect(gitm.resolveCommit("nope", repo.root)).toBeNull();
      expect(gitm.isWellFormedRev("a..b", repo.root)).toBe(false);
      // User input: a fatal status (here `HEAD@{99}`, exit 128) is "not well-formed" too.
      expect(gitm.isWellFormedRev("HEAD@{99}", repo.root)).toBe(false);
      expect(gitm.commitExists("1".repeat(40), repo.root)).toBe(false);
      const tree = repo.git("rev-parse", "HEAD^{tree}");
      expect(gitm.commitExists(tree, repo.root)).toBe(false);
      expect(gitm.commitExists(head, repo.root)).toBe(true);
      const failOn = ["rev-parse", "--verify"];
      expectStop(
        withShim(failOn, () => gitm.readRef("HEAD", repo.root)),
        failOn,
      );
      expectStop(
        withShim(failOn, () => gitm.treeOid("HEAD", "d", repo.root)),
        failOn,
      );
      expectStop(
        withShim(failOn, () => gitm.resolveCommit("HEAD", repo.root)),
        failOn,
      );
      expectStop(
        withShim(failOn, () => gitm.commitExists(head, repo.root)),
        failOn,
      );
    });

    it("pathKind: an unresolved path or a submodule entry is null; a failing cat-file fails 2", () => {
      const repo = track(buildConsumer({ "d/f.txt": "f\n" }));
      repo.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sm`);
      repo.git("commit", "-q", "-m", "submodule entry");
      expect(gitm.pathKind("HEAD", "d", repo.root)).toBe("tree");
      expect(gitm.pathKind("HEAD", "d/f.txt", repo.root)).toBe("blob");
      expect(gitm.pathKind("HEAD", "d/missing", repo.root)).toBeNull();
      expect(gitm.pathKind("HEAD", "sm", repo.root)).toBeNull();
      // User input: a path git refuses as fatal (exit 128) does not resolve either.
      expect(gitm.pathKind("HEAD", "../x", repo.root)).toBeNull();
      const failOn = ["cat-file", "-t"];
      expectStop(
        withShim(failOn, () => gitm.pathKind("HEAD", "d", repo.root)),
        failOn,
      );
    });

    it("ignoresCase: unset reads false, a bad value fails 2", () => {
      const repo = track(buildConsumer());
      repo.git("config", "core.ignorecase", "true");
      expect(gitm.ignoresCase(repo.root)).toBe(true);
      repo.git("config", "core.ignorecase", "false");
      expect(gitm.ignoresCase(repo.root)).toBe(false);
      repo.git("config", "--unset", "core.ignorecase");
      expect(gitm.ignoresCase(repo.root)).toBe(false);
      repo.git("config", "core.ignorecase", "maybe");
      const err = caught(() => gitm.ignoresCase(repo.root));
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.exit).toBe(2);
      expect(err.gitStderr).toContain("bad boolean config value");
    });

    it("isAncestor: a commit missing from the object store is false; another failure fails 2", () => {
      const repo = track(buildConsumer());
      const first = repo.git("rev-parse", "HEAD");
      const second = repo.commit("second", { "s.txt": "s\n" });
      expect(gitm.isAncestor("1".repeat(40), second, repo.root)).toBe(false);
      expect(gitm.isAncestor(first, second, repo.root)).toBe(true);
      expect(gitm.isAncestor(second, first, repo.root)).toBe(false);
      const failOn = ["merge-base"];
      expectStop(
        withShim(failOn, () => gitm.isAncestor(first, second, repo.root)),
        failOn,
      );
    });
  });
});

describe("git.mjs part 2", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });
  const track = <T extends { cleanup(): void }>(x: T): T => {
    cleanups.push(() => x.cleanup());
    return x;
  };
  const ZERO = "0".repeat(40);

  // Splits a `-z` Buffer into its NUL-terminated records, decoded one by one.
  const records = (buf: Buffer): string[] => {
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0) {
        out.push(buf.subarray(start, i).toString("utf8"));
        start = i + 1;
      }
    }
    return out;
  };

  it("treeEntries keeps blobs, drops the manifest and submodules", () => {
    const up = track(
      buildUpstream({
        [`${SUBPATH}/f.txt`]: "f\n",
        [`${SUBPATH}/x.sh`]: "#!/bin/sh\n",
        [`${SUBPATH}/.vendor.json`]: "{}\n",
        [`${SUBPATH}/sub/.vendor.json`]: "{}\n",
      }),
    );
    up.chmodX(`${SUBPATH}/x.sh`);
    up.symlink(`${SUBPATH}/ln`, "f.txt");
    up.git("add", "-A");
    const anyCommit = up.git("rev-parse", "HEAD");
    up.git("update-index", "--add", "--cacheinfo", `160000,${anyCommit},${SUBPATH}/mod`);
    up.git("commit", "-q", "-m", "more");
    const sha = up.git("rev-parse", "HEAD");

    const entries = gitm.treeEntries(sha, SUBPATH, up.root);
    expect([...entries.keys()].sort()).toEqual(["f.txt", "ln", "sub/.vendor.json", "x.sh"]);
    expect(entries.get("f.txt")).toEqual({
      mode: "100644",
      oid: up.git("rev-parse", `${sha}:${SUBPATH}/f.txt`),
    });
    expect(entries.get("x.sh").mode).toBe("100755");
    expect(entries.get("ln").mode).toBe("120000");
    expect(entries.has(".vendor.json")).toBe(false);
    expect(entries.has("mod")).toBe(false);

    const tree = gitm.treeOid(sha, SUBPATH, up.root);
    expect([...gitm.treeEntries(tree, "", up.root).keys()].sort()).toEqual([
      "f.txt",
      "ln",
      "sub/.vendor.json",
      "x.sh",
    ]);

    // The message names the tree spec it listed: the caller may be reading HEAD or the stored
    // base, not upstream.
    const missing = "0".repeat(40);
    for (const [rev, path, spec] of [
      [sha, "plugins/missing", `${sha}:plugins/missing`],
      [missing, "", `${missing}^{tree}`],
    ]) {
      const err = caught(() => gitm.treeEntries(rev, path, up.root));
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.exit).toBe(2);
      expect(err.message).toBe(`cannot list the tree ${spec}`);
      expect(typeof err.gitStderr).toBe("string");
    }
  });

  // U+FF21 sorts before U+1F600 in UTF-8 bytes, after it in UTF-16 code units.
  it("gitlinkPaths lists the submodule entries under the path, byte-sorted", () => {
    const up = track(buildUpstream({ [`${SUBPATH}/f.txt`]: "f\n", "outside/g.txt": "g\n" }));
    const anyCommit = up.git("rev-parse", "HEAD");
    for (const path of [
      `${SUBPATH}/mod`,
      `${SUBPATH}/deep/Zed`,
      `${SUBPATH}/deep/\u{1F600}`,
      `${SUBPATH}/deep/\uFF21`,
      "outside/sm",
    ]) {
      up.git("update-index", "--add", "--cacheinfo", `160000,${anyCommit},${path}`);
    }
    up.git("commit", "-q", "-m", "submodules");
    const sha = up.git("rev-parse", "HEAD");
    expect(gitm.gitlinkPaths(sha, SUBPATH, up.root)).toEqual([
      "deep/Zed",
      "deep/\uFF21",
      "deep/\u{1F600}",
      "mod",
    ]);
    expect(gitm.gitlinkPaths(anyCommit, SUBPATH, up.root)).toEqual([]);
    expect(gitm.gitlinkPaths(sha, "", up.root)).toContain("outside/sm");
  });

  it("gitlinkPaths fails 2 when git ls-tree fails", () => {
    const up = track(buildUpstream({ [`${SUBPATH}/f.txt`]: "f\n" }));
    const sha = up.git("rev-parse", "HEAD");
    const shim = track(gitShim({ failOn: ["ls-tree"] }));
    const savedPath = process.env.PATH;
    process.env.PATH = shim.env.PATH;
    process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
    try {
      const err = caught(() => gitm.gitlinkPaths(sha, SUBPATH, up.root));
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.exit).toBe(2);
      expect(err.message).toBe("git ls-tree failed");
      expect(err.gitStderr).toContain("shim: refused ls-tree");
    } finally {
      process.env.PATH = savedPath;
      delete process.env.SHIM_FAIL;
    }
  });

  it("prefixedTree re-roots and omits the manifest", () => {
    const repo = track(
      buildConsumer({
        [`${SUBPATH}/.vendor.json`]: "{}\n",
        [`${SUBPATH}/a.md`]: "a\n",
        "plain/a.md": "a\n",
        "vendored/old.md": "old\n",
      }),
    );
    const tree = gitm.treeOid("HEAD", SUBPATH, repo.root);
    const indexBefore = repo.git("ls-files", "-s");
    const lsr = (t: string) => repo.git("ls-tree", "-r", "--name-only", t).split("\n");

    const omitted = gitm.prefixedTree(tree, "vendored", repo.root, { omitManifest: true });
    expect(lsr(omitted)).toEqual(["vendored/a.md"]);
    const kept = gitm.prefixedTree(tree, "vendored", repo.root);
    expect(lsr(kept)).toEqual(["vendored/.vendor.json", "vendored/a.md"]);
    const plain = gitm.treeOid("HEAD", "plain", repo.root);
    const plainPrefixed = gitm.prefixedTree(plain, "vendored", repo.root, { omitManifest: true });
    expect(repo.git("rev-parse", `${plainPrefixed}:vendored`)).toBe(plain);

    expect(repo.git("ls-files", "-s")).toBe(indexBefore);
    const leftovers = readdirSync(join(repo.root, ".git")).filter((n) =>
      n.startsWith("vendor-sync-index"),
    );
    expect(leftovers).toEqual([]);
  });

  it("prefixedTree omits the manifest while a different local manifest sits at that path", () => {
    const repo = track(
      buildConsumer({
        [`${SUBPATH}/.vendor.json`]: '{ "upstream": true }\n',
        [`${SUBPATH}/a.md`]: "a\n",
        "vendored/.vendor.json": '{ "local": true }\n',
      }),
    );
    const tree = gitm.treeOid("HEAD", SUBPATH, repo.root);
    const omitted = gitm.prefixedTree(tree, "vendored", repo.root, { omitManifest: true });
    expect(repo.git("ls-tree", "-r", "--name-only", omitted)).toBe("vendored/a.md");
  });

  it("commitTree", () => {
    const repo = track(buildConsumer({ "d/a.md": "a\n" }));
    const tree = gitm.treeOid("HEAD", "d", repo.root);
    const commit = gitm.commitTree(tree, repo.root);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.git("log", "--format=%P", "-1", commit)).toBe("");
    expect(repo.git("rev-parse", `${commit}^{tree}`)).toBe(tree);
  });

  it("mergeTree clean and conflicted", () => {
    const repo = track(buildConsumer({ "dir/a.md": LONG_A }));
    const base = gitm.treeOid("HEAD", "dir", repo.root);
    const variant = (msg: string, content: string) => {
      repo.commit(msg, { "dir/a.md": content });
      return gitm.treeOid("HEAD", "dir", repo.root);
    };
    const localEdit = variant("local", LONG_A.replace("line1\n", "LOCAL1\n"));
    const upstreamFar = variant("up far", LONG_A.replace("line8\n", "UP8\n"));
    const upstreamNear = variant("up near", LONG_A.replace("line1\n", "UP1\n"));
    const name = (ref: string, tree: string) => {
      gitm.setRef(
        ref,
        gitm.commitTree(gitm.prefixedTree(tree, "dir", repo.root), repo.root),
        repo.root,
      );
    };
    name("refs/vendor-base", base);
    name("refs/vendor-local", localEdit);

    name("refs/vendor-upstream", upstreamFar);
    const clean = gitm.mergeTree(
      "refs/vendor-base",
      "refs/vendor-local",
      "refs/vendor-upstream",
      repo.root,
    );
    expect(clean.conflicted).toBe(false);
    expect(Buffer.isBuffer(clean.stdout)).toBe(true);
    expect(records(clean.stdout)[0]).toMatch(/^[0-9a-f]{40}$/);

    name("refs/vendor-upstream", upstreamNear);
    const conflicted = gitm.mergeTree(
      "refs/vendor-base",
      "refs/vendor-local",
      "refs/vendor-upstream",
      repo.root,
    );
    expect(conflicted.conflicted).toBe(true);
    const recs = records(conflicted.stdout);
    expect(recs[0]).toMatch(/^[0-9a-f]{40}$/);
    const stages = recs
      .slice(1, recs.indexOf(""))
      .map((r) => /^(\d{6}) ([0-9a-f]{40}) (\d)\t(.*)$/s.exec(r))
      .filter((m) => m !== null && m[4] === "dir/a.md")
      .map((m) => Number(m![3]));
    expect(stages).toEqual([1, 2, 3]);
    const mergedBlob = repo.git("cat-file", "-p", `${recs[0]}:dir/a.md`);
    expect(mergedBlob).toMatch(/^\|{7}( |$)/m);

    const err = caught(() =>
      gitm.mergeTree("refs/vendor-nope", "refs/vendor-local", "refs/vendor-upstream", repo.root),
    );
    expect(err).toBeInstanceOf(ScriptError);
    expect(err.exit).toBe(2);
    expect(err.message).toBe("git merge-tree failed");
    expect(typeof err.gitStderr).toBe("string");
  });

  it("diffTreeNames", () => {
    const repo = track(
      buildConsumer({
        "keep.md": "keep\n",
        "change.md": "c1\n",
        "mode.sh": "m\n",
        "del.md": "d\n",
        "ren-old.md": "a file with enough distinct content to be detected as a rename\n",
      }),
    );
    const before = gitm.treeOid("HEAD", "", repo.root);
    rmSync(join(repo.root, "del.md"));
    rmSync(join(repo.root, "ren-old.md"));
    repo.chmodX("mode.sh");
    const after = repo.commit("change", {
      "change.md": "c2\n",
      "add.md": "new\n",
      "ren-new.md": "a file with enough distinct content to be detected as a rename\n",
    });
    expect(gitm.diffTreeNames(before, gitm.treeOid(after, "", repo.root), repo.root)).toEqual([
      "add.md",
      "change.md",
      "del.md",
      "mode.sh",
      "ren-new.md",
      "ren-old.md",
    ]);
    const err = caught(() => gitm.diffTreeNames(before, ZERO, repo.root));
    expect(err).toBeInstanceOf(ScriptError);
    expect(err.exit).toBe(2);
  });

  it("committedPaths lists what HEAD changed under <rel>, manifest aside", () => {
    // A root commit compares with the empty tree.
    const repo = track(
      buildConsumer({
        "d*/a.md": "a\n",
        "d*/.vendor.json": "{}\n",
        "d*/sub/.vendor.json": "{}\n",
        "dx/b.md": "b\n",
        "keep.md": "k\n",
      }),
    );
    expect(gitm.committedPaths("d*", repo.root)).toEqual(["a.md", "sub/.vendor.json"]);
    // A later commit compares with its parent: changed, added, deleted and mode-only paths.
    repo.write({ "d*/c.md": "c\n", "d*/sh": "s\n" });
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "more");
    rmSync(join(repo.root, "d*/c.md"));
    repo.chmodX("d*/sh");
    repo.commit("change", {
      "d*/a.md": "a2\n",
      "d*/\u00e4.md": "n\n",
      "d*/B.md": "n\n",
      "d*/.vendor.json": "{ }\n",
      "dx/b.md": "b2\n",
      "keep.md": "k2\n",
    });
    expect(gitm.committedPaths("d*", repo.root)).toEqual([
      "B.md",
      "a.md",
      "c.md",
      "sh",
      "\u00e4.md",
    ]);
    // Nothing under <rel> changed.
    repo.commit("outside", { "keep.md": "k3\n", "d*/.vendor.json": "{}\n" });
    expect(gitm.committedPaths("d*", repo.root)).toEqual([]);
  });

  it("committedPaths fails 2 when git diff-tree fails", () => {
    const repo = track(buildConsumer({ "d/f.txt": "f\n" }));
    const shim = track(gitShim({ failOn: ["diff-tree"] }));
    const savedPath = process.env.PATH;
    process.env.PATH = shim.env.PATH;
    process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
    try {
      const err = caught(() => gitm.committedPaths("d", repo.root));
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.exit).toBe(2);
      expect(err.message).toBe("cannot list the paths HEAD changed in d");
      expect(err.gitStderr).toContain("shim: refused diff-tree");
    } finally {
      process.env.PATH = savedPath;
      delete process.env.SHIM_FAIL;
    }
  });

  it("restoreTree", () => {
    const repo = track(
      buildConsumer({ "dir/a.md": "a\n", "dir/b.md": "b\n", "dir/.vendor.json": "{}\n" }),
    );
    repo.git("rm", "-q", "dir/b.md");
    const target = repo.commit("target", { "dir/a.md": "a2\n", "dir/n.md": "n\n" });
    const tree = gitm.treeOid(target, "", repo.root);
    repo.git("reset", "-q", "--hard", "HEAD~1");
    repo.write({ "dir/u.txt": "u\n", "dir/.vendor.json": '{"open":true}\n' });

    gitm.restoreTree(tree, ["dir", ":(exclude)dir/.vendor.json"], repo.root);

    const read = (rel: string) => readFileSync(join(repo.root, rel), "utf8");
    expect(read("dir/a.md")).toBe("a2\n");
    expect(read("dir/n.md")).toBe("n\n");
    expect(read("dir/u.txt")).toBe("u\n");
    expect(read("dir/.vendor.json")).toBe('{"open":true}\n');
    expect(repo.git("ls-files", "--", "dir").split("\n")).toEqual([
      "dir/.vendor.json",
      "dir/a.md",
      "dir/n.md",
    ]);
    expect(repo.git("ls-files", "-o", "--", "dir")).toBe("dir/u.txt");
    expect(() => readFileSync(join(repo.root, "dir/b.md"))).toThrow();
  });

  it("commitIndex stages unstaged edits under <rel> and commits the index", () => {
    const repo = track(buildConsumer({ "dir/f.md": "f\n", "other.txt": "o\n" }));
    repo.write({ "other.txt": "o2\n", ".vendor-sync/t.txt": "t\n" });
    repo.git("add", "--", ".vendor-sync/t.txt");
    repo.write({ "dir/f.md": "f2\n", "dir/x.orig": "backup\n" });

    const oid = gitm.commitIndex("m", "dir", repo.root);
    expect(oid).toBe(repo.git("rev-parse", "HEAD"));
    expect(repo.git("log", "--format=%B", "-1")).toBe("m");
    expect(repo.git("show", "HEAD:dir/f.md")).toBe("f2");
    expect(repo.git("show", "--name-only", "--format=", "HEAD").split("\n")).toEqual([
      ".vendor-sync/t.txt",
      "dir/f.md",
    ]);
    expect(repo.git("diff", "--cached", "--name-only")).toBe("");
    expect(repo.git("diff", "--name-only")).toBe("other.txt");
    expect(repo.git("ls-files", "-o", "--", "dir")).toBe("dir/x.orig");

    const hooks = join(repo.root, ".git", "test-hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho hook-says-no\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    repo.git("config", "core.hooksPath", hooks);
    repo.write({ "dir/f.md": "f3\n" });
    const err = caught(() => gitm.commitIndex("m2", "dir", repo.root));
    expect(err).toBeInstanceOf(ScriptError);
    expect(err.exit).toBe(1);
    expect(err.message).toBe("the commit failed; the action is still open");
    expect(err.gitStderr).toContain("hook-says-no");
    expect(repo.git("rev-parse", "HEAD")).toBe(oid);
  });

  it("stagedPaths lists the staged paths, also on an unborn HEAD", () => {
    const unborn = realpathSync(mkdtempSync(join(tmpdir(), "vendor-")));
    cleanups.push(() => rmSync(unborn, { recursive: true, force: true }));
    gitm.git(["init", "-q"], unborn);
    writeFileSync(join(unborn, "n.txt"), "n\n");
    gitm.git(["add", "n.txt"], unborn);
    expect(gitm.stagedPaths(unborn)).toEqual(["n.txt"]);

    const repo = track(buildConsumer({ "d/f.md": "f\n", "gone.txt": "g\n", "old.txt": "o\n" }));
    expect(gitm.stagedPaths(repo.root)).toEqual([]);
    repo.write({ "d/f.md": "f2\n", "z new.txt": "z\n", "unstaged.txt": "u\n" });
    repo.git("add", "--", "d/f.md", "z new.txt");
    repo.git("rm", "-q", "--cached", "--", "gone.txt");
    repo.git("mv", "old.txt", "new.txt");
    expect(gitm.stagedPaths(repo.root)).toEqual([
      "d/f.md",
      "gone.txt",
      "new.txt",
      "old.txt",
      "z new.txt",
    ]);
  });

  it("stagedPaths lists a staged gitlink despite submodule ignore config", () => {
    const repo = track(buildConsumer());
    repo.git("config", "diff.ignoreSubmodules", "all");
    const oid = repo.git("rev-parse", "HEAD");
    repo.git("update-index", "--add", "--cacheinfo", `160000,${oid},sm`);
    repo.git("config", "-f", ".gitmodules", "submodule.sm.path", "sm");
    repo.git("config", "-f", ".gitmodules", "submodule.sm.ignore", "all");
    repo.git("config", "submodule.sm.ignore", "all");
    expect(gitm.stagedPaths(repo.root)).toEqual(["sm"]);
  });

  it("stagedPaths fails 2 when git diff fails", () => {
    const repo = track(buildConsumer({ "d/f.txt": "f\n" }));
    const shim = track(gitShim({ failOn: ["diff", "--cached"] }));
    const savedPath = process.env.PATH;
    process.env.PATH = shim.env.PATH;
    process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
    try {
      const err = caught(() => gitm.stagedPaths(repo.root));
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.exit).toBe(2);
      expect(err.message).toBe("cannot list the staged paths");
      expect(err.gitStderr).toContain("shim: refused diff --cached");
    } finally {
      process.env.PATH = savedPath;
      delete process.env.SHIM_FAIL;
    }
  });

  it("worktreeDiffers", () => {
    const repo = track(buildConsumer({ "dir/a.md": "a\n", "dir/.vendor.json": "{}\n" }));
    const tree = gitm.prefixedTree(gitm.treeOid("HEAD", "dir", repo.root), "dir", repo.root);
    expect(gitm.worktreeDiffers(tree, "dir", repo.root)).toBe(false);
    repo.write({ "dir/a.md": "a2\n" });
    expect(gitm.worktreeDiffers(tree, "dir", repo.root)).toBe(true);
    repo.write({ "dir/a.md": "a\n", "dir/.vendor.json": '{"open":true}\n' });
    expect(gitm.worktreeDiffers(tree, "dir", repo.root)).toBe(false);
    repo.write({ "dir/.vendor.json": "{}\n", "dir/new.md": "n\n" });
    expect(gitm.worktreeDiffers(tree, "dir", repo.root)).toBe(false);
    const err = caught(() => gitm.worktreeDiffers("f".repeat(40), "dir", repo.root));
    expect(err).toBeInstanceOf(ScriptError);
    expect(err.exit).toBe(2);
    expect(typeof err.gitStderr).toBe("string");
  });

  it("untrackedFiles", () => {
    const repo = track(buildConsumer({ "dir/t.md": "t\n", ".gitignore": "*.log\n" }));
    repo.write({
      "dir/u2.md": "u\n",
      "dir/sub/u1.md": "u\n",
      "dir/x.log": "x\n",
      "dir/b c ä.md": "u\n",
      "other.md": "o\n",
    });
    expect(gitm.untrackedFiles("dir", repo.root)).toEqual(["b c ä.md", "sub/u1.md", "u2.md"]);
  });

  it("indexEntries and unmergedFiles", () => {
    const repo = track(
      buildConsumer({ "dir/a.md": "a\n", "dir/c.md": "c\n", "dir/.vendor.json": "{}\n" }),
    );
    const a = { mode: "100644", oid: repo.git("rev-parse", ":dir/a.md") };
    const c = { mode: "100644", oid: repo.git("rev-parse", ":dir/c.md") };
    expect(gitm.indexEntries("dir", repo.root)).toEqual(
      new Map([
        ["a.md", a],
        ["c.md", c],
      ]),
    );
    gitm.updateIndexInfo(
      [
        `0 ${ZERO}\tdir/c.md`,
        `100644 ${c.oid} 1\tdir/c.md`,
        `100644 ${a.oid} 2\tdir/c.md`,
        `100644 ${c.oid} 3\tdir/c.md`,
      ],
      repo.root,
    );
    expect(gitm.indexEntries("dir", repo.root)).toEqual(new Map([["a.md", a]]));
    expect(gitm.unmergedFiles("dir", repo.root)).toEqual(["c.md"]);
  });

  it("ls-files readers fail 2 when git ls-files fails", () => {
    const repo = track(buildConsumer({ "dir/a.md": "a\n" }));
    const shim = gitShim({ failOn: ["ls-files"] });
    const savedPath = process.env.PATH;
    process.env.PATH = shim.env.PATH;
    process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
    try {
      for (const read of [
        () => gitm.unmergedFiles("dir", repo.root),
        () => gitm.untrackedFiles("dir", repo.root),
      ]) {
        const err = caught(read);
        expect(err).toBeInstanceOf(ScriptError);
        expect(err.exit).toBe(2);
        expect(err.message).toBe("git ls-files failed");
        expect(typeof err.gitStderr).toBe("string");
      }
    } finally {
      process.env.PATH = savedPath;
      delete process.env.SHIM_FAIL;
      shim.cleanup();
    }
  });

  it("updateIndexInfo", () => {
    const repo = track(buildConsumer({ "dir/a.md": "a\n" }));
    const shim = gitShim({ failOn: ["update-index"] });
    const savedPath = process.env.PATH;
    process.env.PATH = shim.env.PATH;
    process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
    try {
      expect(() => gitm.updateIndexInfo([], repo.root)).not.toThrow();
      // The shim is live: a non-empty list does reach it and fails.
      const shimmed = caught(() => gitm.updateIndexInfo([`0 ${ZERO}\tdir/a.md`], repo.root));
      expect(shimmed.exit).toBe(2);
    } finally {
      process.env.PATH = savedPath;
      delete process.env.SHIM_FAIL;
      shim.cleanup();
    }
    const err = caught(() => gitm.updateIndexInfo(["not an index line"], repo.root));
    expect(err).toBeInstanceOf(ScriptError);
    expect(err.exit).toBe(2);
    expect(typeof err.gitStderr).toBe("string");
  });
});
