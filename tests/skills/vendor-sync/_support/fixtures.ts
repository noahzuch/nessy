// Building blocks for the vendor-sync test suite: throwaway repositories, a spawner for the
// entry scripts, readers of git state, and a git shim for faking versions and failures.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPTS_DIR = join(REPO_ROOT, ".claude/skills/vendor-sync/scripts");

export type ScriptResult = { exitCode: number; stdout: string; stderr: string; json: any };

export function runScript(
  name: string,
  args: string[],
  cwd: string,
  opts: { env?: Record<string, string> } = {},
): ScriptResult {
  const res = spawnSync("node", [join(SCRIPTS_DIR, `${name}.mjs`), ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...opts.env },
  });
  const stdout = res.stdout ?? "";
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { exitCode: res.status ?? -1, stdout, stderr: res.stderr ?? "", json };
}

export type Repo = {
  root: string;
  git(...args: string[]): string;
  commit(msg: string, files: Record<string, string>): string;
  commitDeletion(msg: string, paths: string[]): string;
  write(files: Record<string, string>): void;
  chmodX(rel: string): void;
  symlink(rel: string, target: string): void;
  cleanup(): void;
};

function runGit(root: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

function buildRepo(): Repo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vendor-")));
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Test"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  const repo: Repo = {
    root,
    git: (...args) => runGit(root, args),
    write(files) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(root, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    },
    commit(msg, files) {
      repo.write(files);
      runGit(root, ["add", "-A"]);
      runGit(root, ["commit", "-q", "-m", msg]);
      return runGit(root, ["rev-parse", "HEAD"]);
    },
    commitDeletion(msg, paths) {
      runGit(root, ["rm", "-q", "-r", "--", ...paths]);
      runGit(root, ["commit", "-q", "-m", msg]);
      return runGit(root, ["rev-parse", "HEAD"]);
    },
    chmodX(rel) {
      chmodSync(join(root, rel), 0o755);
    },
    symlink(rel, target) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      symlinkSync(target, abs);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return repo;
}

// Whether the temp directory's filesystem folds case (the macOS default): tests about names
// that differ only in case are meaningful only there.
export const CASE_INSENSITIVE_FS: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-case-"));
  try {
    writeFileSync(join(dir, "probe"), "");
    return existsSync(join(dir, "PROBE"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
// Appended to the names of tests that vitest skips on a case-sensitive filesystem.
export const NEEDS_CASE_INSENSITIVE_FS = "(skipped unless the filesystem is case-insensitive)";

export const SUBPATH = "plugins/demo/skills/demo";
export const LONG_A = Array.from({ length: 8 }, (_, i) => `line${i + 1}\n`).join("");

export function demoUpstreamFiles(): Record<string, string> {
  return {
    [`${SUBPATH}/SKILL.md`]: "# demo skill\n",
    [`${SUBPATH}/a.md`]: LONG_A,
    [`${SUBPATH}/nested/b.md`]: "b\n",
    "plugins/demo/README.md": "demo plugin\n",
  };
}

export function buildUpstream(files: Record<string, string>): Repo {
  const repo = buildRepo();
  repo.commit("upstream: initial", files);
  return repo;
}

export function buildConsumer(files: Record<string, string> = {}): Repo {
  const repo = buildRepo();
  repo.commit("consumer: initial", { ".keep": "", ...files });
  return repo;
}

export function porcelainV2(repo: Repo, dir: string): string[] {
  return repo
    .git("status", "--porcelain=v2", "--untracked-files=all", "--", dir)
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith(".vendor.json"))
    .sort();
}

export function indexStages(
  repo: Repo,
  repoPath: string,
): { mode: string; oid: string; stage: number }[] {
  const out = repo.git("ls-files", "-s", "--", repoPath);
  if (out === "") return [];
  return out.split("\n").map((line) => {
    const [mode, oid, stage] = line.split("\t")[0].split(" ");
    return { mode, oid, stage: Number(stage) };
  });
}

export function blobOid(repo: Repo, content: string): string {
  const res = spawnSync("git", ["hash-object", "--stdin"], {
    cwd: repo.root,
    input: content,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`git hash-object failed: ${res.stderr}`);
  return res.stdout.trim();
}

// A `git stash pop`-style conflict on `repoPath`: its stage-0 entry gives way to stages 2 and 3.
export function plantUnmerged(repo: Repo, repoPath: string): void {
  const ours = blobOid(repo, "ours\n");
  const theirs = blobOid(repo, "theirs\n");
  const lines = [
    `0 ${"0".repeat(40)}\t${repoPath}`,
    `100644 ${ours} 2\t${repoPath}`,
    `100644 ${theirs} 3\t${repoPath}`,
  ];
  const res = spawnSync("git", ["update-index", "--index-info"], {
    cwd: repo.root,
    input: lines.join("\n") + "\n",
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`git update-index failed: ${res.stderr}`);
}

export function refSha(repo: Repo, ref: string): string | null {
  const res = spawnSync("git", ["rev-parse", "--verify", "-q", ref], {
    cwd: repo.root,
    encoding: "utf8",
  });
  return res.status === 0 ? res.stdout.trim() : null;
}

export function listRefs(repo: Repo, prefix: string): string[] {
  const out = repo.git("for-each-ref", "--format=%(refname)", prefix);
  return out === "" ? [] : out.split("\n");
}

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const child = join(abs, name);
      const st = lstatSync(child);
      if (st.isDirectory()) walk(child);
      else if (st.isFile() || st.isSymbolicLink()) out.push(relative(dir, child));
    }
  };
  walk(dir);
  return out.sort();
}

export function plantGitOperation(repo: Repo, name: string): void {
  const gitDirPath = repo.git("rev-parse", "--absolute-git-dir");
  if (name === "rebase-merge" || name === "rebase-apply") {
    mkdirSync(join(gitDirPath, name), { recursive: true });
  } else {
    writeFileSync(join(gitDirPath, name), repo.git("rev-parse", "HEAD") + "\n");
  }
}

export function gitShim(opts: { version?: string; failOn?: string[] } = {}): {
  dir: string;
  env: Record<string, string>;
  cleanup(): void;
} {
  const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  if (!realGit.startsWith("/")) throw new Error(`could not resolve git: ${realGit}`);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vendor-shim-")));
  const script = [
    "#!/bin/bash",
    'if [ -n "$SHIM_VERSION" ] && [ "$1" = "--version" ]; then echo "git version $SHIM_VERSION"; exit 0; fi',
    'if [ -n "$SHIM_FAIL" ] && [[ "$*" == "$SHIM_FAIL"* ]]; then echo "shim: refused $*" >&2; exit 128; fi',
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(dir, "git"), script);
  chmodSync(join(dir, "git"), 0o755);
  const env: Record<string, string> = { PATH: `${dir}:${process.env.PATH ?? ""}` };
  if (opts.version !== undefined) env.SHIM_VERSION = opts.version;
  if (opts.failOn !== undefined) env.SHIM_FAIL = opts.failOn.join(" ");
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export type Marker = {
  action: "add" | "sync";
  state: string;
  target_sha: string;
};

export type Manifest = {
  slug: string;
  repo: string;
  path: string;
  ref: string;
  sha: string;
  base_tree: string;
  in_progress: Marker | null;
};

const MANIFEST_FIELDS = ["slug", "repo", "path", "ref", "sha", "base_tree", "in_progress"] as const;

function manifestPath(repo: Repo, dir: string): string {
  return join(repo.root, dir, ".vendor.json");
}

export function readManifest(repo: Repo, dir: string): Manifest {
  return JSON.parse(readFileSync(manifestPath(repo, dir), "utf8"));
}

export function patchManifest(repo: Repo, dir: string, patch: Partial<Manifest>): void {
  const merged: Record<string, unknown> = { ...readManifest(repo, dir), ...patch };
  const ordered: Record<string, unknown> = {};
  for (const field of MANIFEST_FIELDS) ordered[field] = merged[field];
  writeFileSync(manifestPath(repo, dir), JSON.stringify(ordered, null, 2) + "\n");
}

export type Plan = {
  version: 1;
  action: "add" | "sync";
  base: string | null;
  target: string;
  touched: { path: string; local_oid: string | null }[];
};

export function scratchOf(repo: Repo, slug: string): string {
  return join(repo.root, ".vendor-sync/scratch", slug);
}

export function readPlan(repo: Repo, slug: string): Plan {
  return JSON.parse(readFileSync(join(scratchOf(repo, slug), "plan.json"), "utf8"));
}

// Vendors SUBPATH of `upstream` into `dir` of `consumer` through the real entry script: the
// add start (expects `ready`), then `--continue` (expects `added`), which commits by itself.
export function establish(
  upstream: Repo,
  consumer: Repo,
  dir = "vendored",
): { dir: string; slug: string; sha: string; manifest: Manifest } {
  const steps: [string[], string][] = [
    [[upstream.root, SUBPATH, dir], "ready"],
    [[dir, "--continue"], "added"],
  ];
  let slug = "";
  let sha = "";
  for (const [args, state] of steps) {
    const res = runScript("vendor-add", args, consumer.root);
    if (res.exitCode !== 0 || res.json?.state !== state) {
      throw new Error(
        `vendor-add ${args.join(" ")}: expected ${state}, got exit ${res.exitCode}\n` +
          `stdout: ${res.stdout}\nstderr: ${res.stderr}`,
      );
    }
    slug = res.json.slug;
    sha = res.json.sha;
  }
  return { dir, slug, sha, manifest: readManifest(consumer, dir) };
}

// Upstream files whose SUBPATH carries a valid manifest in `inner/`: vendored into `<dir>`, it is
// upstream content of that connection, never a connection of its own.
export function nestedUpstreamFiles(): Record<string, string> {
  const inner = {
    slug: "inner",
    repo: "/does/not/exist",
    path: "x",
    ref: "main",
    sha: "a".repeat(40),
    base_tree: "b".repeat(40),
    in_progress: null,
  };
  return {
    ...demoUpstreamFiles(),
    [`${SUBPATH}/inner/.vendor.json`]: JSON.stringify(inner, null, 2) + "\n",
  };
}

// Everything a refused run must leave as it was: index, working tree (ignored files too) and refs.
export function repoState(repo: Repo): string[] {
  return [
    repo.git("status", "--porcelain=v2", "--untracked-files=all", "--ignored"),
    repo.git("ls-files", "-s"),
    repo.git("for-each-ref"),
  ];
}
