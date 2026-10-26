import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConsumer,
  buildUpstream,
  demoUpstreamFiles,
  gitShim,
  plantGitOperation,
  SUBPATH,
  type Repo,
} from "./fixtures.js";

describe("fixtures", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });
  const track = <T extends { cleanup(): void }>(x: T): T => {
    cleanups.push(() => x.cleanup());
    return x;
  };

  it("buildUpstream commits on main", () => {
    const up = track(buildUpstream(demoUpstreamFiles()));
    expect(up.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(up.git("ls-files").split("\n").sort()).toEqual(
      [
        `${SUBPATH}/SKILL.md`,
        `${SUBPATH}/a.md`,
        `${SUBPATH}/nested/b.md`,
        "plugins/demo/README.md",
      ].sort(),
    );
  });

  it("chmodX and symlink commit with their modes", () => {
    const repo: Repo = track(buildConsumer());
    repo.write({ "x.sh": "#!/bin/sh\n" });
    repo.chmodX("x.sh");
    repo.symlink("l", "x.sh");
    repo.commit("modes", {});
    const modes = Object.fromEntries(
      repo
        .git("ls-files", "-s")
        .split("\n")
        .map((line) => [line.split("\t")[1], line.split(" ")[0]]),
    );
    expect(modes["x.sh"]).toBe("100755");
    expect(modes["l"]).toBe("120000");
  });

  it("gitShim reports a fake version and fails a command", () => {
    const shim = track(gitShim({ version: "2.34.1", failOn: ["update-index", "--index-info"] }));
    const repo = track(buildConsumer());
    const env = { ...process.env, ...shim.env };
    const version = spawnSync("git", ["--version"], { env, encoding: "utf8" });
    expect(version.stdout.trim()).toBe("git version 2.34.1");
    const refused = spawnSync("git", ["update-index", "--index-info"], {
      cwd: repo.root,
      env,
      encoding: "utf8",
      input: "",
    });
    expect(refused.status).toBe(128);
    const status = spawnSync("git", ["status"], { cwd: repo.root, env, encoding: "utf8" });
    expect(status.status).toBe(0);
  });

  it("plantGitOperation", () => {
    const repo = track(buildConsumer());
    const gitDir = repo.git("rev-parse", "--absolute-git-dir");
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      plantGitOperation(repo, name);
      expect(statSync(join(gitDir, name)).isFile()).toBe(true);
    }
    for (const name of ["rebase-merge", "rebase-apply"]) {
      plantGitOperation(repo, name);
      expect(existsSync(join(gitDir, name)) && statSync(join(gitDir, name)).isDirectory()).toBe(
        true,
      );
    }
  });
});
