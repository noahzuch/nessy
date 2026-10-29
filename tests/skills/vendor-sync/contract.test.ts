import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildConsumer,
  buildUpstream,
  demoUpstreamFiles,
  establish,
  type Repo,
  runScript,
  type ScriptResult,
  SUBPATH,
} from "./_support/fixtures.js";
// contract.mjs is plain JS with no declarations, so this import is implicitly `any`.
// @ts-expect-error TS7016
import * as contract from "../../../.claude/skills/vendor-sync/scripts/contract.mjs";

const { EXIT, ScriptError, fail, run, parseArgv, parseArgvOrFail, resumeMode, usageFailure } =
  contract;

function caught(fn: () => unknown): any {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("contract.mjs", () => {
  describe("EXIT", () => {
    it("is frozen with the codes 0, 1 and 2", () => {
      try {
        EXIT.OK = 5;
      } catch {
        // assignment to a frozen object throws in strict mode
      }
      expect(EXIT.OK).toBe(0);
      expect(Object.isFrozen(EXIT)).toBe(true);
      expect(EXIT).toEqual({ OK: 0, FIX: 1, STOP: 2 });
    });
  });

  describe("HEX40", () => {
    it("matches exactly 40 lowercase hex digits", () => {
      expect(contract.HEX40.test("a".repeat(40))).toBe(true);
      for (const value of ["a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), ""]) {
        expect(contract.HEX40.test(value)).toBe(false);
      }
    });
  });

  describe("isPlainObject", () => {
    it("accepts an object and rejects null, arrays and primitives", () => {
      expect(contract.isPlainObject({})).toBe(true);
      expect(contract.isPlainObject({ a: 1 })).toBe(true);
      for (const value of [null, undefined, [], "x", 1, true]) {
        expect(contract.isPlainObject(value)).toBe(false);
      }
    });
  });

  describe("ScriptError", () => {
    it("carries its fields", () => {
      const err = new ScriptError(1, "m", { hint: "h", data: { a: 1 }, gitStderr: "e" });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("ScriptError");
      expect(err.message).toBe("m");
      expect(err.exit).toBe(1);
      expect(err.hint).toBe("h");
      expect(err.data).toEqual({ a: 1 });
      expect(err.gitStderr).toBe("e");
    });
  });

  describe("fail", () => {
    it("throws a ScriptError built from its arguments", () => {
      let caught: unknown;
      try {
        fail(2, "x", { hint: "y" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ScriptError);
      const err = caught as { exit: number; message: string; hint: string };
      expect(err.exit).toBe(2);
      expect(err.message).toBe("x");
      expect(err.hint).toBe("y");
    });
  });

  describe("run", () => {
    const spyStdout = () => vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const spyStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spyExit = () => vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    let stdout: ReturnType<typeof spyStdout>;
    let stderr: ReturnType<typeof spyStderr>;
    let exit: ReturnType<typeof spyExit>;

    beforeEach(() => {
      stdout = spyStdout();
      stderr = spyStderr();
      exit = spyExit();
    });

    afterEach(() => {
      // Every case must end without process.exit().
      expect(exit).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    const parsedStdout = () => {
      expect(stdout).toHaveBeenCalledTimes(1);
      return JSON.parse(String(stdout.mock.calls[0][0]));
    };

    it("prints the returned object and exits 0", () => {
      run(() => ({ state: "ok", n: 1 }));
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(stdout).toHaveBeenCalledWith(JSON.stringify({ state: "ok", n: 1 }, null, 2) + "\n");
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    });

    it("prints a ScriptError with hint, data and git's stderr", () => {
      run(() => {
        throw new ScriptError(1, "bad", {
          hint: "h",
          data: { unresolved: ["a"] },
          gitStderr: "fatal: x",
        });
      });
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith("fatal: x\n");
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(stdout).toHaveBeenCalledWith(
        JSON.stringify(
          { error: { message: "bad", hint: "h", data: { unresolved: ["a"] } } },
          null,
          2,
        ) + "\n",
      );
      expect(process.exitCode).toBe(1);
    });

    it("omits hint and data when absent", () => {
      run(() => {
        throw new ScriptError(2, "stop");
      });
      const out = parsedStdout();
      expect(Object.keys(out)).toEqual(["error"]);
      expect(Object.keys(out.error)).toEqual(["message"]);
      expect(out.error.message).toBe("stop");
      expect("hint" in out.error).toBe(false);
      expect("data" in out.error).toBe(false);
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    });

    it("keeps an existing trailing newline on git's stderr", () => {
      run(() => {
        throw new ScriptError(2, "stop", { gitStderr: "out\n" });
      });
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith("out\n");
    });

    it("writes nothing to stderr for an empty gitStderr", () => {
      run(() => {
        throw new ScriptError(2, "stop", { gitStderr: "" });
      });
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    });

    it("turns a foreign error into a message and exits 2", () => {
      run(() => {
        throw new TypeError("boom");
      });
      expect(parsedStdout()).toEqual({ error: { message: "boom" } });
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    });
  });

  describe("parseArgv", () => {
    it("separates positionals from bool flags", () => {
      expect(parseArgv(["a", "--continue", "b"], { value: [], bool: ["continue"] })).toEqual({
        positionals: ["a", "b"],
        flags: { continue: true },
        problems: [],
      });
    });

    it("reads values given inline or as the next token", () => {
      const res = parseArgv(["--ref=dev", "--sha", "abc"], { value: ["ref", "sha"], bool: [] });
      expect(res.flags).toEqual({ ref: "dev", sha: "abc" });
      expect(res.positionals).toEqual([]);
      expect(res.problems).toEqual([]);
    });

    it("reports a value missing at the end of argv", () => {
      const res = parseArgv(["--ref"], { value: ["ref"], bool: [] });
      expect(res.problems).toEqual(["missing value for --ref"]);
      expect(res.flags).toEqual({});
    });

    it("reports a value missing before another flag and keeps that flag", () => {
      const res = parseArgv(["--ref", "--continue"], { value: ["ref"], bool: ["continue"] });
      expect(res.problems).toContain("missing value for --ref");
      expect(res.flags).toEqual({ continue: true });
    });

    it("reports an unknown flag", () => {
      const res = parseArgv(["--nope"], { value: ["ref"], bool: ["continue"] });
      expect(res.problems).toEqual(["unknown flag: --nope"]);
      expect(res.flags).toEqual({});
    });

    it("reports a bool flag given a value", () => {
      const res = parseArgv(["--continue=x"], { value: [], bool: ["continue"] });
      expect(res.problems).toEqual(["--continue takes no value"]);
      expect(res.flags).toEqual({});
    });

    it("returns an empty result for an empty argv", () => {
      expect(parseArgv([], { value: [], bool: [] })).toEqual({
        positionals: [],
        flags: {},
        problems: [],
      });
    });
  });

  describe("usageFailure", () => {
    it("fails 1 with the message and the usage as hint", () => {
      const err = caught(() => usageFailure("U")("bad"));
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.exit).toBe(1);
      expect(err.message).toBe("bad");
      expect(err.hint).toBe("U");
    });
  });

  describe("parseArgvOrFail", () => {
    it("returns positionals and flags when there is no problem", () => {
      expect(parseArgvOrFail(["a", "--ref", "x"], { value: ["ref"], bool: [] }, "U")).toEqual({
        positionals: ["a"],
        flags: { ref: "x" },
      });
    });

    it("fails 1 with every problem joined and the usage", () => {
      const err = caught(() =>
        parseArgvOrFail(["--nope", "--ref"], { value: ["ref"], bool: [] }, "U"),
      );
      expect(err.exit).toBe(1);
      expect(err.message).toBe("unknown flag: --nope; missing value for --ref");
      expect(err.hint).toBe("U");
    });
  });

  describe("resumeMode", () => {
    const START = ["ref", "sha"];
    it("returns null for a start, whatever its positionals", () => {
      expect(resumeMode(["a", "b", "c"], { ref: "x" }, START, "U")).toBeNull();
      expect(resumeMode([], {}, START, "U")).toBeNull();
    });

    it("returns the mode for <dir> alone", () => {
      expect(resumeMode(["d"], { continue: true }, START, "U")).toBe("continue");
      expect(resumeMode(["d"], { abort: true }, START, "U")).toBe("abort");
    });

    it("fails 1 with the usage, the exclusion first", () => {
      const cases: [string[], Record<string, unknown>, string][] = [
        [["a", "b"], { continue: true, abort: true }, "--continue and --abort exclude each other"],
        [[], { continue: true }, "--continue takes only <dir>"],
        [["a", "b"], { abort: true }, "--abort takes only <dir>"],
        [["d"], { continue: true, sha: "x" }, "--continue takes only <dir>"],
        [["d"], { abort: true, ref: "" }, "--abort takes only <dir>"],
      ];
      for (const [positionals, flags, message] of cases) {
        const err = caught(() => resumeMode(positionals, flags, START, "U"));
        expect(err.exit, message).toBe(1);
        expect(err.message).toBe(message);
        expect(err.hint).toBe("U");
      }
    });
  });
});

// Exactly one JSON value: it parses, and nothing follows its closing brace.
function expectOneObject(res: ScriptResult) {
  expect(() => JSON.parse(res.stdout)).not.toThrow();
  expect(res.stdout.endsWith("}\n")).toBe(true);
  expect(res.stdout.indexOf("}\n", res.stdout.lastIndexOf("}"))).toBe(res.stdout.length - 2);
}
function expectErrorShape(res: ScriptResult) {
  expect(Object.keys(res.json)).toEqual(["error"]);
  expect(typeof res.json.error.message).toBe("string");
  for (const key of Object.keys(res.json.error)) {
    expect(["message", "hint", "data"]).toContain(key);
  }
}

const ADD_USAGE = [
  "usage: node scripts/vendor-add.mjs <repo> <path> <dir> [--ref <branch>] [--sha <commit>]",
  "       node scripts/vendor-add.mjs <dir> --continue",
  "       node scripts/vendor-add.mjs <dir> --abort",
].join("\n");

describe("vendor-add contract", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  function setup() {
    const upstream = buildUpstream(demoUpstreamFiles());
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    return { upstream, consumer };
  }
  const add = (consumer: Repo, args: string[]) => runScript("vendor-add", args, consumer.root);

  it("AC-6 vendor-add prints one JSON object and exits 0, 1 or 2", () => {
    const { upstream, consumer } = setup();

    const ready = add(consumer, [upstream.root, SUBPATH, "vendored"]);
    expect(ready.exitCode).toBe(0);
    expectOneObject(ready);
    expect(ready.json.state).toBe("ready");

    const missing = add(consumer, [upstream.root, SUBPATH]);
    expect(missing.exitCode).toBe(1);
    expectOneObject(missing);
    expectErrorShape(missing);
    expect(missing.stderr).toBe("");

    const noManifest = add(consumer, ["elsewhere", "--continue"]);
    expect(noManifest.exitCode).toBe(2);
    expectOneObject(noManifest);
    expectErrorShape(noManifest);
  });

  it("AC-7 vendor-add rejects bad arguments with the usage and writes nothing", () => {
    const { upstream, consumer } = setup();
    const up = upstream.root;
    const cases = [
      [up, SUBPATH, "vendored", "--bogus"],
      [up, SUBPATH, "vendored", "--ref"],
      [up, "vendored"],
      [up, SUBPATH, "vendored", "extra"],
      ["vendored", "--continue", "--abort"],
      ["vendored", "--continue", "--ref", "x"],
      [up, SUBPATH, "vendored", "--continue"],
    ];
    const state = () => [
      consumer.git("status", "--porcelain", "--untracked-files=all"),
      consumer.git("for-each-ref"),
    ];
    const before = state();
    for (const args of cases) {
      const res = add(consumer, args);
      expect(res.exitCode, args.join(" ")).toBe(1);
      expect(res.json.error.hint, args.join(" ")).toBe(ADD_USAGE);
      expect(state(), args.join(" ")).toEqual(before);
    }
  });
});

// The one place the expected vendor-sync usage is spelled out.
const SYNC_USAGE = [
  "usage: node scripts/vendor-sync.mjs <dir> [--base-from-pin | --without-base]",
  "       node scripts/vendor-sync.mjs <dir> --continue",
  "       node scripts/vendor-sync.mjs <dir> --abort",
].join("\n");

describe("vendor-sync contract", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  function setup() {
    const upstream = buildUpstream(demoUpstreamFiles());
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    establish(upstream, consumer);
    return { upstream, consumer };
  }
  const sync = (consumer: Repo, args: string[]) => runScript("vendor-sync", args, consumer.root);

  it("AC-6 vendor-sync prints one JSON object and exits 0, 1 or 2", () => {
    const { consumer } = setup();

    const upToDate = sync(consumer, ["vendored"]);
    expect(upToDate.exitCode).toBe(0);
    expectOneObject(upToDate);
    expect(upToDate.json.state).toBe("up_to_date");

    const missing = sync(consumer, []);
    expect(missing.exitCode).toBe(1);
    expectOneObject(missing);
    expectErrorShape(missing);
    expect(missing.stderr).toBe("");

    const noManifest = sync(consumer, ["x"]);
    expect(noManifest.exitCode).toBe(2);
    expectOneObject(noManifest);
    expectErrorShape(noManifest);
    expect(noManifest.json.error.message).toBe("not a vendored directory: x");
  });

  it("AC-7 vendor-sync rejects bad arguments with the usage and writes nothing", () => {
    const { consumer } = setup();
    const cases = [
      ["vendored", "--bogus"],
      ["vendored", "other"],
      ["vendored", "--base-from-pin", "--without-base"],
      ["vendored", "--abort", "--without-base"],
      ["vendored", "--continue", "--abort"],
      ["vendored", "--continue", "--without-base"],
    ];
    const state = () => [
      consumer.git("status", "--porcelain", "--untracked-files=all"),
      consumer.git("for-each-ref"),
    ];
    const before = state();
    for (const args of cases) {
      const res = sync(consumer, args);
      expect(res.exitCode, args.join(" ")).toBe(1);
      expect(res.json.error.hint, args.join(" ")).toBe(SYNC_USAGE);
      expect(state(), args.join(" ")).toEqual(before);
    }
  });

  it("AC-7 vendor-add and vendor-sync give the same message for a resume with a wrong <dir> count", () => {
    const { consumer } = setup();
    const scripts = [
      { name: "vendor-add", usage: ADD_USAGE },
      { name: "vendor-sync", usage: SYNC_USAGE },
    ];
    const cases = [
      { args: ["vendored", "other", "--continue"], message: "--continue takes only <dir>" },
      { args: ["vendored", "other", "--abort"], message: "--abort takes only <dir>" },
      { args: ["--continue"], message: "--continue takes only <dir>" },
      { args: ["--abort"], message: "--abort takes only <dir>" },
      {
        args: ["vendored", "other", "--continue", "--abort"],
        message: "--continue and --abort exclude each other",
      },
    ];
    for (const { name, usage } of scripts) {
      for (const { args, message } of cases) {
        const label = `${name} ${args.join(" ")}`;
        const res = runScript(name, args, consumer.root);
        expect(res.exitCode, label).toBe(1);
        expect(res.json.error.message, label).toBe(message);
        expect(res.json.error.hint, label).toBe(usage);
      }
    }
    // A start with the wrong <dir> count keeps its own message.
    const start = sync(consumer, ["vendored", "other"]);
    expect(start.json.error.message).toBe("expected exactly one <dir>");
  });
});

// The one place the expected vendor-remove usage is spelled out.
const REMOVE_USAGE = "usage: node scripts/vendor-remove.mjs <dir>";

describe("vendor-remove contract", () => {
  const repos: Repo[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.cleanup();
  });
  function setup() {
    const upstream = buildUpstream(demoUpstreamFiles());
    const consumer = buildConsumer();
    repos.push(upstream, consumer);
    establish(upstream, consumer);
    return { upstream, consumer };
  }
  const remove = (consumer: Repo, args: string[]) =>
    runScript("vendor-remove", args, consumer.root);

  it("AC-6 vendor-remove prints one JSON object and exits 0, 1 or 2", () => {
    const { consumer } = setup();

    const missing = remove(consumer, []);
    expect(missing.exitCode).toBe(1);
    expectOneObject(missing);
    expectErrorShape(missing);
    expect(missing.stderr).toBe("");
    expect(missing.json.error.hint).toBe(REMOVE_USAGE);

    const bogus = remove(consumer, ["vendored", "--bogus"]);
    expect(bogus.exitCode).toBe(1);
    expectOneObject(bogus);
    expectErrorShape(bogus);

    const noManifest = remove(consumer, ["x"]);
    expect(noManifest.exitCode).toBe(2);
    expectOneObject(noManifest);
    expectErrorShape(noManifest);
    expect(noManifest.json.error.message).toBe("not a vendored directory: x");

    const removed = remove(consumer, ["vendored"]);
    expect(removed.exitCode).toBe(0);
    expectOneObject(removed);
    expect(removed.json.state).toBe("removed");
  });

  it("AC-7 vendor-remove rejects bad arguments with the usage and writes nothing", () => {
    const { consumer } = setup();
    const cases = [[], ["vendored", "--bogus"], ["vendored", "other"], ["vendored", "--abort"]];
    const state = () => [
      consumer.git("status", "--porcelain", "--untracked-files=all"),
      consumer.git("for-each-ref"),
    ];
    const before = state();
    for (const args of cases) {
      const res = remove(consumer, args);
      expect(res.exitCode, args.join(" ")).toBe(1);
      expect(res.json.error.hint, args.join(" ")).toBe(REMOVE_USAGE);
      expect(state(), args.join(" ")).toEqual(before);
    }
  });
});

// The one place the expected vendor-list usage is spelled out.
const LIST_USAGE = "usage: node scripts/vendor-list.mjs";

describe("vendor-list contract", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });
  function setup() {
    const consumer = buildConsumer();
    cleanups.push(() => consumer.cleanup());
    return consumer;
  }
  const list = (cwd: string, args: string[]) => runScript("vendor-list", args, cwd);

  it("AC-6 vendor-list prints one JSON object and exits 0, 1 or 2", () => {
    const consumer = setup();

    const empty = list(consumer.root, []);
    expect(empty.exitCode).toBe(0);
    expectOneObject(empty);
    expect(empty.json).toEqual({ state: "listed", connections: [] });

    const extra = list(consumer.root, ["extra"]);
    expect(extra.exitCode).toBe(1);
    expectOneObject(extra);
    expectErrorShape(extra);
    expect(extra.stderr).toBe("");

    const outside = realpathSync(mkdtempSync(join(tmpdir(), "vendor-nogit-")));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const noRepo = list(outside, []);
    expect(noRepo.exitCode).toBe(2);
    expectOneObject(noRepo);
    expectErrorShape(noRepo);
    expect(noRepo.json.error.message).toBe("not inside a git repository");
  });

  it("AC-7 vendor-list rejects bad arguments with the usage and writes nothing", () => {
    const consumer = setup();
    const cases = [["extra"], ["--bogus"]];
    const state = () => [
      consumer.git("status", "--porcelain", "--untracked-files=all"),
      consumer.git("for-each-ref"),
    ];
    const before = state();
    for (const args of cases) {
      const res = list(consumer.root, args);
      expect(res.exitCode, args.join(" ")).toBe(1);
      expectOneObject(res);
      expect(res.json.error.hint, args.join(" ")).toBe(LIST_USAGE);
      expect(state(), args.join(" ")).toEqual(before);
    }
  });
});
