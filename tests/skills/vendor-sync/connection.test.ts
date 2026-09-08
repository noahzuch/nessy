import {
  existsSync,
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
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// connection.mjs is plain JS with no declarations, so this import is implicitly `any`.
// @ts-expect-error TS7016
import * as conn from "../../../.claude/skills/vendor-sync/scripts/connection.mjs";
// git.mjs is plain JS with no declarations, so this import is implicitly `any`.
// @ts-expect-error TS7016
import * as gitm from "../../../.claude/skills/vendor-sync/scripts/git.mjs";
import {
  buildConsumer,
  buildUpstream,
  demoUpstreamFiles,
  gitShim,
  type Repo,
  CASE_INSENSITIVE_FS,
  NEEDS_CASE_INSENSITIVE_FS,
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

const SHA_A = "9570870d5c94ccda6c694c0ce55b1b80a2e358e7";
const SHA_B = "6690958dfb864f61e01f7e56c9478426b02bb380";
const TREE = "4f1c2a9e0d3b7c6a5e8f9d0c1b2a3e4f5d6c7b8a";
const HEX40 = /^[0-9a-f]{40}$/;

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "skills-demo",
    repo: "https://github.com/example/upstream",
    path: "plugins/demo/skills/demo",
    ref: "main",
    sha: SHA_A,
    base_tree: TREE,
    in_progress: null,
    ...overrides,
  };
}

// A hand-written check of the manifest schema in spec § The manifest.
function schemaProblems(m: any): string[] {
  const problems: string[] = [];
  const fields = ["slug", "repo", "path", "ref", "sha", "base_tree", "in_progress"];
  if (typeof m !== "object" || m === null || Array.isArray(m)) return ["not an object"];
  if (JSON.stringify(Object.keys(m).sort()) !== JSON.stringify([...fields].sort())) {
    problems.push(`keys: ${Object.keys(m).join(",")}`);
  }
  if (typeof m.slug !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(m.slug)) {
    problems.push("slug");
  }
  for (const f of ["repo", "path", "ref"]) {
    if (typeof m[f] !== "string" || !/\S/.test(m[f])) problems.push(f);
  }
  for (const f of ["sha", "base_tree"]) {
    if (typeof m[f] !== "string" || !HEX40.test(m[f])) problems.push(f);
  }
  const ip = m.in_progress;
  if (ip !== null) {
    const states: Record<string, string[]> = {
      add: ["ready", "merging", "merge_staged"],
      sync: ["pin_ready", "merging", "merge_staged"],
    };
    if (typeof ip !== "object" || Array.isArray(ip)) {
      problems.push("in_progress");
    } else {
      if (JSON.stringify(Object.keys(ip).sort()) !== '["action","state","target_sha"]') {
        problems.push("in_progress keys");
      }
      if (!(ip.action in states) || !states[ip.action].includes(ip.state)) {
        problems.push("in_progress action/state");
      }
      if (typeof ip.target_sha !== "string" || !HEX40.test(ip.target_sha)) {
        problems.push("in_progress target_sha");
      }
    }
  }
  return problems;
}

describe("connection.mjs part 1", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });
  const tempDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vendor-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const put = (root: string, rel: string, content: string) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  it("exports the manifest and tool constants", () => {
    expect(conn.MANIFEST_NAME).toBe(".vendor.json");
    expect(conn.MANIFEST_FIELDS).toEqual([
      "slug",
      "repo",
      "path",
      "ref",
      "sha",
      "base_tree",
      "in_progress",
    ]);
    expect(conn.TOOL_ROOT).toBe(".vendor-sync");
  });

  it("AC-1 serializes the seven fields in schema order, the marker reduced, with a trailing newline", () => {
    const scrambled = {
      in_progress: { target_sha: SHA_B, extra: 1, state: "merge_staged", action: "sync" },
      extra: "dropped",
      base_tree: TREE,
      sha: SHA_A,
      ref: "main",
      path: "plugins/demo/skills/demo",
      repo: "https://github.com/example/upstream",
      slug: "skills-demo",
    };
    const out = conn.serializeManifest(scrambled);
    expect(out).toBe(
      "{\n" +
        '  "slug": "skills-demo",\n' +
        '  "repo": "https://github.com/example/upstream",\n' +
        '  "path": "plugins/demo/skills/demo",\n' +
        '  "ref": "main",\n' +
        `  "sha": "${SHA_A}",\n` +
        `  "base_tree": "${TREE}",\n` +
        '  "in_progress": {\n' +
        '    "action": "sync",\n' +
        '    "state": "merge_staged",\n' +
        `    "target_sha": "${SHA_B}"\n` +
        "  }\n" +
        "}\n",
    );
    expect(schemaProblems(JSON.parse(out))).toEqual([]);

    const { in_progress: _drop, ...noMarker } = validManifest();
    const closed = conn.serializeManifest(noMarker);
    expect(JSON.parse(closed).in_progress).toBeNull();
    expect(closed.endsWith('  "in_progress": null\n}\n')).toBe(true);
    expect(schemaProblems(JSON.parse(closed))).toEqual([]);
  });

  it("AC-1 writeManifest creates a missing directory and writes the serialized bytes", () => {
    const root = tempDir();
    const abs = join(root, "deep/new/dir");
    const manifest = validManifest({
      in_progress: { action: "add", state: "ready", target_sha: SHA_B },
    });
    conn.writeManifest(abs, manifest);
    expect(readFileSync(join(abs, ".vendor.json"), "utf8")).toBe(conn.serializeManifest(manifest));
    expect(conn.manifestExists(abs)).toBe(true);
    expect(conn.manifestExists(root)).toBe(false);
  });

  describe("AC-2 parse errors", () => {
    const P = "skills/demo/.vendor.json";
    const expectFail = (text: string, message: string) => {
      const err = caught(() => conn.parseManifest(text, P));
      expect(err.exit).toBe(2);
      expect(err.message.startsWith(`${P}: `)).toBe(true);
      expect(err.message).toContain(message);
    };

    it("AC-2 malformed JSON", () => {
      expectFail("{ not json", `${P}: malformed JSON: `);
    });

    it("AC-2 an array is not a JSON object", () => {
      expectFail("[]", `${P}: not a JSON object`);
    });

    for (const field of ["slug", "repo", "path", "ref", "sha", "base_tree"]) {
      it(`AC-2 missing, blank, null or non-string ${field}`, () => {
        const missing = validManifest();
        delete missing[field];
        expectFail(JSON.stringify(missing), `${P}: missing required field "${field}"`);
        for (const value of ["  ", null, 7]) {
          expectFail(
            JSON.stringify(validManifest({ [field]: value })),
            `${P}: missing required field "${field}"`,
          );
        }
      });
    }

    it("AC-2 a missing in_progress", () => {
      const missing = validManifest();
      delete missing.in_progress;
      expectFail(JSON.stringify(missing), `${P}: missing required field "in_progress"`);
    });

    const expectExact = (manifest: Record<string, unknown>, message: string) => {
      const err = caught(() => conn.parseManifest(JSON.stringify(manifest), P));
      expect(err.exit).toBe(2);
      expect(err.message).toBe(`${P}: ${message}`);
    };

    it("AC-2 a slug outside the schema's pattern", () => {
      for (const slug of ["-demo", "skills/demo", "a.b", "ü"]) {
        expectExact(validManifest({ slug }), "invalid slug");
      }
    });

    it("AC-2 a sha that is not 40 lowercase hex digits", () => {
      for (const sha of ["abc", SHA_A.toUpperCase(), `${SHA_A}0`]) {
        expectExact(validManifest({ sha }), "invalid sha");
      }
    });

    it("AC-2 a base_tree that is not 40 lowercase hex digits", () => {
      for (const base_tree of ["abc", TREE.toUpperCase(), `${TREE}0`]) {
        expectExact(validManifest({ base_tree }), "invalid base_tree");
      }
    });

    it("AC-2 the checks run in order: unknown key, missing field, pattern, marker", () => {
      const all = validManifest({ extra: 1, sha: "abc", in_progress: "open" });
      delete all.repo;
      expectExact(all, 'unknown field "extra"');
      delete all.extra;
      expectExact(all, 'missing required field "repo"');
      all.repo = "r";
      expectExact(all, "invalid sha");
      all.sha = SHA_A;
      expectExact(all, "invalid in_progress");
    });

    it("AC-2 invalid in_progress markers", () => {
      const bad = [
        { action: "remove", state: "ready", target_sha: SHA_B },
        { action: "add", state: "pin_ready", target_sha: SHA_B },
        { action: "sync", state: "ready", target_sha: SHA_B },
        { action: "sync", state: "merge_staged", target_sha: SHA_B.slice(0, 39) },
        { action: "sync", state: "pin_ready", target_sha: SHA_B, started: "today" },
        { action: "sync", state: "pin_ready" },
        "sync",
        [],
      ];
      for (const in_progress of bad) {
        const err = caught(() =>
          conn.parseManifest(JSON.stringify(validManifest({ in_progress })), P),
        );
        expect(err.exit).toBe(2);
        expect(err.message).toBe(`${P}: invalid in_progress`);
      }
    });

    it("AC-2 an unknown key", () => {
      const err = caught(() => conn.parseManifest(JSON.stringify(validManifest({ extra: 1 })), P));
      expect(err.exit).toBe(2);
      expect(err.message).toBe(`${P}: unknown field "extra"`);
    });

    it("AC-2 a valid manifest round-trips", () => {
      const m = validManifest({
        in_progress: { action: "sync", state: "pin_ready", target_sha: SHA_B },
      });
      expect(conn.parseManifest(JSON.stringify(m), P)).toEqual(m);
      expect(conn.parseManifest(JSON.stringify(validManifest()), P)).toEqual(validManifest());
    });

    it("AC-2 loadManifest on a directory without the file", () => {
      const root = tempDir();
      const err = caught(() => conn.loadManifest(join(root, "skills/demo"), "skills/demo"));
      expect(err.exit).toBe(2);
      expect(err.message).toBe("not a vendored directory: skills/demo");
      expect(err.hint).toBe("use add to vendor it");
    });

    it("AC-2 loadManifest names <rel>/.vendor.json in parse errors and parses a valid file", () => {
      const root = tempDir();
      put(root, "skills/demo/.vendor.json", "{");
      const err = caught(() => conn.loadManifest(join(root, "skills/demo"), "skills/demo"));
      expect(err.exit).toBe(2);
      expect(err.message.startsWith("skills/demo/.vendor.json: malformed JSON")).toBe(true);
      put(root, "skills/demo/.vendor.json", JSON.stringify(validManifest()));
      expect(conn.loadManifest(join(root, "skills/demo"), "skills/demo")).toEqual(validManifest());
    });
  });

  it("deriveSlug", () => {
    expect(conn.deriveSlug("skills/demo")).toBe("skills-demo");
    expect(conn.deriveSlug("a//b")).toBe("a-b");
    expect(conn.deriveSlug(".hidden/x.")).toBe("hidden-x");
    expect(conn.deriveSlug("ü")).toBe("");
    expect(conn.deriveSlug("a b")).toBe("a-b");
  });

  it("requireSlug", () => {
    const root = tempDir();
    const err = caught(() => conn.requireSlug("ü", root));
    expect(err.exit).toBe(1);
    expect(err.message).toBe("cannot derive a ref-safe slug from the directory name: ü");
    expect(err.hint).toBe("rename the directory and re-run");
    expect(conn.requireSlug("a..b", root)).toBe("a-b");
    expect(conn.requireSlug("skills/demo", root)).toBe("skills-demo");
  });

  it("requireSlugUnused", () => {
    const root = tempDir();
    put(root, "skills/demo/.vendor.json", JSON.stringify(validManifest()));
    put(root, "broken/.vendor.json", "{ unreadable");
    const connections = conn.findVendoredDirs(root);
    const err = caught(() =>
      conn.requireSlugUnused("skills-demo", "skills-demo", connections, root),
    );
    expect(err.exit).toBe(1);
    expect(err.message).toBe('slug "skills-demo" is already used by skills/demo');
    expect(err.hint).toBe("rename the directory and re-run");
    expect(conn.requireSlugUnused("skills-demo", "skills/demo", connections, root)).toBeUndefined();
    expect(conn.requireSlugUnused("other", "other", connections, root)).toBeUndefined();
  });

  it("isInside", () => {
    expect(conn.isInside("/r", "/r/a")).toBe(true);
    expect(conn.isInside("/r", "/r")).toBe(false);
    expect(conn.isInside("/r", "/x")).toBe(false);
    expect(conn.isInside("/r", "/r/../x")).toBe(false);
    expect(conn.isInside("/r", "/r/..foo")).toBe(true);
  });

  it("normalizeLocalDir", () => {
    const root = tempDir();
    expect(conn.normalizeLocalDir("vendored/", root)).toEqual({
      rel: "vendored",
      abs: join(root, "vendored"),
    });
    expect(conn.normalizeLocalDir("a/b", root)).toEqual({ rel: "a/b", abs: join(root, "a/b") });
    for (const arg of ["..", "/tmp", "."]) {
      const err = caught(() => conn.normalizeLocalDir(arg, root));
      expect(err.exit).toBe(1);
      expect(err.message).toBe(`${arg}: directory must lie inside the repository (${root})`);
    }
  });

  it("findVendoredDirs", () => {
    const root = tempDir();
    for (const rel of [
      "a/.vendor.json",
      "a/b/.vendor.json",
      "a/b/c/.vendor.json",
      "a/x/.vendor.json",
      "ab/.vendor.json",
      "f/g/.vendor.json",
      "node_modules/x/.vendor.json",
      ".vendor-sync/base/s/.vendor.json",
      ".git/y/.vendor.json",
      "c/d/other.json",
    ]) {
      put(root, rel, "{}");
    }
    mkdirSync(join(root, "e/.vendor.json"), { recursive: true });
    // A manifest below another connection's directory is upstream content, not a connection.
    expect(conn.findVendoredDirs(root)).toEqual(["a", "ab", "f/g"]);
    expect(conn.findVendoredDirs(join(root, "missing"))).toEqual([]);
    expect(existsSync(join(root, "missing"))).toBe(false);
  });

  it("requireNotNested", () => {
    const root = tempDir();
    for (const rel of [".vendor.json", "outer/.vendor.json", "outer/x/.vendor.json"]) {
      put(root, rel, "{}");
    }
    for (const [rel, outer] of [
      ["outer/inner", "outer"],
      ["outer/a/b", "outer"],
      ["outer/x", "outer"],
      ["outer/x/y", "outer"],
    ]) {
      const err = caught(() => conn.requireNotNested(rel, root));
      expect(err.exit).toBe(2);
      expect(err.message).toBe(`${rel} is inside the vendored directory ${outer}`);
      expect(err.hint).toBe("choose a directory outside it");
    }
    // The directory's own manifest and one at the repository root do not count.
    for (const rel of ["outer", "other", "other/inner", "outerx/y"]) {
      expect(conn.requireNotNested(rel, root)).toBeUndefined();
    }
  });

  it("requireNoSymlink", () => {
    const root = tempDir();
    put(root, "real/sub/x.md", "x\n");
    mkdirSync(join(root, "empty"));
    symlinkSync("empty", join(root, "to-empty"));
    symlinkSync("real", join(root, "to-real"));
    symlinkSync("../empty", join(root, "real/inner-link"));
    symlinkSync("missing", join(root, "dangling"));
    // The outermost symlinked component, inclusive of <dir>, is named.
    for (const [rel, link] of [
      ["to-empty", "to-empty"],
      ["to-real", "to-real"],
      ["to-real/sub", "to-real"],
      ["to-real/inner-link/new", "to-real"],
      ["real/inner-link", "real/inner-link"],
      ["real/inner-link/a/b", "real/inner-link"],
      ["dangling", "dangling"],
      ["dangling/new", "dangling"],
    ]) {
      const err = caught(() => conn.requireNoSymlink(rel, root));
      expect(err.exit).toBe(1);
      expect(err.message).toBe(`${link} is a symbolic link`);
      expect(err.hint).toBe("choose a directory that is not a symbolic link or inside one");
    }
    // Real directories, files and components that do not exist yet are fine.
    for (const rel of ["real", "real/sub", "real/sub/x.md", "real/new/deeper", "absent", "empty"]) {
      expect(conn.requireNoSymlink(rel, root)).toBeUndefined();
    }
  });

  const requireNoInner = (rel: string, root: string) =>
    conn.requireNoInnerConnection(rel, conn.findVendoredDirs(root), root);

  it("requireNoInnerConnection", () => {
    const root = tempDir();
    for (const rel of [
      ".vendor.json",
      "vendor/b/.vendor.json",
      "vendor/a/x/.vendor.json",
      "vendor-foo/.vendor.json",
      "node_modules/vendor/c/.vendor.json",
    ]) {
      put(root, rel, "{}");
    }
    // The first inner connection in findVendoredDirs' sorted order is named.
    for (const [rel, inner] of [
      ["vendor", "vendor/a/x"],
      ["vendor/a", "vendor/a/x"],
    ]) {
      const err = caught(() => requireNoInner(rel, root));
      expect(err.exit).toBe(2);
      expect(err.message).toBe(`${rel} contains the vendored directory ${inner}`);
      expect(err.hint).toBe("choose a directory that holds no vendored directory");
    }
    // The directory itself, a sibling, a name-prefix match and an unreached manifest do not count.
    for (const rel of ["vendor/b", "vend", "vendor-foo", "vendor/a/x", "other", "node_modules"]) {
      expect(requireNoInner(rel, root)).toBeUndefined();
    }
  });

  it.skipIf(!CASE_INSENSITIVE_FS)(
    `requireNoInnerConnection compares directories as the file system resolves them ${NEEDS_CASE_INSENSITIVE_FS}`,
    () => {
      const root = tempDir();
      put(root, "vendor/foo/.vendor.json", "{}");
      for (const rel of ["Vendor", "VENDOR"]) {
        const err = caught(() => requireNoInner(rel, root));
        expect(err.exit).toBe(2);
        expect(err.message).toBe(`${rel} contains the vendored directory vendor/foo`);
      }
      // The connection itself under another case is not inside itself.
      expect(requireNoInner("Vendor/Foo", root)).toBeUndefined();
    },
  );

  it("loadConnection", () => {
    const root = tempDir();
    put(root, "outer/.vendor.json", "{}");
    conn.writeManifest(join(root, "vendored"), validManifest());
    expect(conn).not.toHaveProperty("locateDir");
    expect(conn.loadConnection("vendored/", root)).toEqual({
      root,
      abs: join(root, "vendored"),
      rel: "vendored",
      manifest: validManifest(),
    });
    // The checks run in order: inside the repository, not nested, then the manifest.
    expect(caught(() => conn.loadConnection("..", root)).exit).toBe(1);
    const nested = caught(() => conn.loadConnection("outer/inner", root));
    expect(nested.exit).toBe(2);
    expect(nested.message).toBe("outer/inner is inside the vendored directory outer");
    // A nested path with a manifest of its own still fails as nested, before the manifest.
    conn.writeManifest(join(root, "outer/inner"), validManifest());
    expect(caught(() => conn.loadConnection("outer/inner", root)).message).toBe(
      "outer/inner is inside the vendored directory outer",
    );
    const missing = caught(() => conn.loadConnection("missing", root));
    expect(missing.exit).toBe(2);
    expect(missing.message).toBe("not a vendored directory: missing");
  });

  it("requireNotNested counts a manifest only where findVendoredDirs finds one", () => {
    const root = tempDir();
    for (const rel of [
      "node_modules/pkg/.vendor.json",
      "a/node_modules/pkg/.vendor.json",
      ".vendor-sync/base/s/.vendor.json",
    ]) {
      put(root, rel, "{}");
    }
    mkdirSync(join(root, "d/.vendor.json"), { recursive: true });
    expect(conn.findVendoredDirs(root)).toEqual([]);
    for (const rel of [
      "d/inner",
      "node_modules/pkg/inner",
      "a/node_modules/pkg/inner",
      ".vendor-sync/base/s/inner",
    ]) {
      expect(conn.requireNotNested(rel, root)).toBeUndefined();
    }
  });

  describe("requireNoOpenAction choices", () => {
    const marker = (action: string, state: string) =>
      validManifest({ in_progress: { action, state, target_sha: SHA_B } });

    it("a null marker returns", () => {
      expect(conn.requireNoOpenAction(validManifest(), "sync", "skills/demo")).toBeUndefined();
    });

    it("the same action offers resume", () => {
      const err = caught(() =>
        conn.requireNoOpenAction(marker("sync", "merge_staged"), "sync", "skills/demo"),
      );
      expect(err.exit).toBe(1);
      expect(err.message).toBe(
        `an unfinished sync is open on skills/demo, started against ${SHA_B}`,
      );
      expect(err.data.choices).toEqual(["resume", "abort", "leave"]);
    });

    it("another action offers abort and leave", () => {
      const err = caught(() =>
        conn.requireNoOpenAction(marker("sync", "merge_staged"), "add", "skills/demo"),
      );
      expect(err.exit).toBe(1);
      expect(err.message).toBe(
        `an unfinished sync is open on skills/demo, started against ${SHA_B}`,
      );
      expect(err.data.choices).toEqual(["abort", "leave"]);
    });

    it("an interrupted start offers abort and leave", () => {
      const err = caught(() =>
        conn.requireNoOpenAction(marker("sync", "merging"), "sync", "skills/demo"),
      );
      expect(err.exit).toBe(1);
      expect(err.data.choices).toEqual(["abort", "leave"]);
    });
  });

  describe("requireMarker", () => {
    const open = (action: string, state: string) => ({ action, state, target_sha: SHA_B });

    it("no marker", () => {
      const err = caught(() => conn.requireMarker(validManifest(), "sync", "skills/demo"));
      expect(err.exit).toBe(2);
      expect(err.message).toBe("no unfinished sync on skills/demo");
      expect(err.hint).toBe("run the start call first");
    });

    it("another action's marker", () => {
      const m = validManifest({ in_progress: open("add", "ready") });
      const err = caught(() => conn.requireMarker(m, "sync", "skills/demo"));
      expect(err.exit).toBe(2);
      expect(err.message).toBe("an unfinished add is open on skills/demo, not sync");
      expect(err.hint).toBe("finish it with --continue, or discard it with --abort");
    });

    it("returns the open marker of the action", () => {
      expect(
        conn.requireMarker(
          validManifest({ in_progress: open("sync", "pin_ready") }),
          "sync",
          "skills/demo",
        ),
      ).toEqual(open("sync", "pin_ready"));
    });

    it("a merging marker fails", () => {
      const m = validManifest({ in_progress: open("sync", "merging") });
      const err = caught(() => conn.requireMarker(m, "sync", "skills/demo"));
      expect(err.exit).toBe(2);
      expect(err.message).toBe(
        "the sync on skills/demo did not finish its start; discard it with --abort",
      );
    });
  });

  describe("requireAnyMarker", () => {
    const open = (action: string, state: string) => ({ action, state, target_sha: SHA_B });

    it("no marker", () => {
      const err = caught(() => conn.requireAnyMarker(validManifest(), "skills/demo"));
      expect(err.exit).toBe(2);
      expect(err.message).toBe("no unfinished action on skills/demo");
      expect(err.hint).toBe("run the start call first");
    });

    it("returns any open marker, a merging one too", () => {
      for (const marker of [
        open("add", "ready"),
        open("sync", "merge_staged"),
        open("sync", "pin_ready"),
        open("sync", "merging"),
        open("add", "merging"),
      ]) {
        const m = validManifest({ in_progress: marker });
        expect(conn.requireAnyMarker(m, "skills/demo")).toEqual(marker);
      }
    });
  });

  it("markerWriter writes the manifest with the open action in the given state", () => {
    const dir = mkdtempSync(join(tmpdir(), "vendor-sync-marker-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const abs = join(dir, "vendored");
    const manifest = validManifest();
    const writeMarker = conn.markerWriter(abs, manifest, "sync", SHA_B);
    writeMarker("merging");
    const marker = { action: "sync", state: "merging", target_sha: SHA_B };
    expect(readFileSync(join(abs, ".vendor.json"), "utf8")).toBe(
      conn.serializeManifest({ ...manifest, in_progress: marker }),
    );
    writeMarker("merge_staged");
    expect(JSON.parse(readFileSync(join(abs, ".vendor.json"), "utf8")).in_progress).toEqual({
      ...marker,
      state: "merge_staged",
    });
    expect(manifest.in_progress).toBeNull();
  });

  it("requireMarkerClosed", () => {
    expect(conn.requireMarkerClosed(validManifest(), "skills/demo")).toBeUndefined();
    const m = validManifest({ in_progress: { action: "add", state: "ready", target_sha: SHA_B } });
    const err = caught(() => conn.requireMarkerClosed(m, "skills/demo"));
    expect(err.exit).toBe(2);
    expect(err.message).toBe(`an unfinished add is open on skills/demo, started against ${SHA_B}`);
    expect(err.hint).toBe("finish it with --continue, or discard it with --abort");
  });

  it("identityOf takes dir from rel and slug, repo, path and ref from the manifest", () => {
    const m = validManifest({
      in_progress: { action: "sync", state: "pin_ready", target_sha: SHA_B },
    });
    expect(conn.identityOf("vendor/demo", m)).toEqual({
      dir: "vendor/demo",
      slug: "skills-demo",
      repo: "https://github.com/example/upstream",
      path: "plugins/demo/skills/demo",
      ref: "main",
    });
  });
});

describe("connection.mjs part 2", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  // An upstream with a root manifest in SUBPATH, fetched into a fresh consumer.
  const setup = (): { up: Repo; con: Repo; sha: string } => {
    const up = buildUpstream({ ...demoUpstreamFiles(), [`${SUBPATH}/.vendor.json`]: "{}\n" });
    cleanups.push(() => up.cleanup());
    const con = buildConsumer();
    cleanups.push(() => con.cleanup());
    gitm.fetchTracking(up.root, "main", "s", con.root);
    const sha = con.git("rev-parse", "refs/vendor/s");
    return { up, con, sha };
  };
  const staged = (con: Repo): string[] =>
    con.git("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();
  // Pulls the upstream tip after a new upstream commit into the consumer.
  const refetch = (up: Repo, con: Repo): string => {
    gitm.fetchTracking(up.root, "main", "s", con.root);
    return con.git("rev-parse", "refs/vendor/s");
  };
  const commitBase = (con: Repo, sha: string): string => {
    const tree = conn.writeStoredBase("s", sha, SUBPATH, con.root);
    con.git("commit", "-q", "-m", "base");
    return tree;
  };
  const manifestFor = (sha: string, base_tree: string, in_progress: unknown = null) => ({
    slug: "s",
    repo: "https://example.com/up.git",
    path: SUBPATH,
    ref: "main",
    sha,
    base_tree,
    in_progress,
  });

  it("baseRepoPath and scratchDir", () => {
    expect(conn.baseRepoPath("s")).toBe(".vendor-sync/base/s");
    expect(conn.scratchDir("/r", "s")).toBe("/r/.vendor-sync/scratch/s");
  });

  it("writeStoredBase stages the stripped upstream directory and returns its tree", () => {
    const { up, con, sha } = setup();
    const tree = conn.writeStoredBase("s", sha, SUBPATH, con.root);
    expect(staged(con)).toEqual([
      ".vendor-sync/base/s/SKILL.md",
      ".vendor-sync/base/s/a.md",
      ".vendor-sync/base/s/nested/b.md",
    ]);
    expect(existsSync(join(con.root, ".vendor-sync/base/s/.vendor.json"))).toBe(false);
    expect(readFileSync(join(con.root, ".vendor-sync/base/s/SKILL.md"), "utf8")).toBe(
      "# demo skill\n",
    );
    const index = con.git("write-tree");
    expect(tree).toBe(con.git("rev-parse", `${index}:.vendor-sync/base/s`));

    up.commitDeletion("drop a", [`${SUBPATH}/a.md`]);
    const next = refetch(up, con);
    conn.writeStoredBase("s", next, SUBPATH, con.root);
    expect(existsSync(join(con.root, ".vendor-sync/base/s/a.md"))).toBe(false);
    expect(staged(con)).toEqual([
      ".vendor-sync/base/s/SKILL.md",
      ".vendor-sync/base/s/nested/b.md",
    ]);

    const err = caught(() => conn.writeStoredBase("s", sha, "no/such/path", con.root));
    expect(err.exit).toBe(2);
    expect(err.message).toBe(`upstream path absent at ${sha}: no/such/path`);
  });

  it("writeToolFiles writes and stages both dotfiles, overwriting prior content", () => {
    const { con } = setup();
    con.write({ ".vendor-sync/.gitignore": "old\n", ".vendor-sync/.gitattributes": "old\n" });
    conn.writeToolFiles(con.root);
    expect(readFileSync(join(con.root, ".vendor-sync/.gitignore"), "utf8")).toBe("/scratch/\n");
    expect(readFileSync(join(con.root, ".vendor-sync/.gitattributes"), "utf8")).toBe(
      "base/** -diff -merge linguist-generated\n",
    );
    expect(staged(con)).toEqual([".vendor-sync/.gitattributes", ".vendor-sync/.gitignore"]);
    expect(con.git("status", "--porcelain", "--", ".vendor-sync")).toBe(
      "A  .vendor-sync/.gitattributes\nA  .vendor-sync/.gitignore",
    );
  });

  it("scratch is self-ignoring and resettable", () => {
    const { con } = setup();
    const dir = conn.ensureScratch(con.root, "s");
    expect(dir).toBe(join(con.root, ".vendor-sync/scratch/s"));
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
    writeFileSync(join(dir, "plan.json"), "{}\n");
    expect(existsSync(join(con.root, ".vendor-sync/.gitignore"))).toBe(false);
    expect(con.git("status", "--porcelain", "--untracked-files=all")).toBe("");
    conn.resetScratch(con.root, "s");
    expect(existsSync(dir)).toBe(false);
    expect(() => conn.resetScratch(con.root, "s")).not.toThrow();
  });

  it("resetScratch removes scratch/ and .vendor-sync/ once they are empty", () => {
    const { con } = setup();
    conn.ensureScratch(con.root, "s");
    conn.resetScratch(con.root, "s");
    expect(existsSync(join(con.root, ".vendor-sync"))).toBe(false);
  });

  it("resetScratch also removes an emptied base/, then .vendor-sync/", () => {
    const { con } = setup();
    mkdirSync(join(con.root, ".vendor-sync/base"), { recursive: true });
    conn.ensureScratch(con.root, "s");
    conn.resetScratch(con.root, "s");
    expect(existsSync(join(con.root, ".vendor-sync"))).toBe(false);
  });

  it("resetScratch keeps .vendor-sync/ and scratch/ while they hold anything else", () => {
    const { con } = setup();
    con.write({ ".vendor-sync/base/x": "x\n" });
    conn.ensureScratch(con.root, "s");
    conn.ensureScratch(con.root, "t");
    conn.resetScratch(con.root, "s");
    expect(existsSync(join(con.root, ".vendor-sync/scratch/t"))).toBe(true);
    conn.resetScratch(con.root, "t");
    expect(existsSync(join(con.root, ".vendor-sync/scratch"))).toBe(false);
    expect(readFileSync(join(con.root, ".vendor-sync/base/x"), "utf8")).toBe("x\n");
  });

  it("ensureScratch fails 2 on an unwritable location", () => {
    const { con } = setup();
    con.write({ ".vendor-sync/scratch": "a file\n" });
    const err = caught(() => conn.ensureScratch(con.root, "s"));
    expect(err.exit).toBe(2);
    expect(
      err.message.startsWith(`cannot write scratch at ${conn.scratchDir(con.root, "s")}: `),
    ).toBe(true);
  });

  describe("requireBaseIntact", () => {
    it("returns with a committed base equal to base_tree", () => {
      const { con, sha } = setup();
      const tree = commitBase(con, sha);
      expect(conn.committedBaseTree("s", con.root)).toBe(tree);
      expect(conn.requireBaseIntact(manifestFor(sha, tree), "vendored", con.root)).toBeUndefined();
    });

    it("fails 1 when HEAD has no base", () => {
      const { con, sha } = setup();
      const tree = gitm.treeOid(sha, SUBPATH, con.root);
      const err = caught(() =>
        conn.requireBaseIntact(manifestFor(sha, tree), "vendored", con.root),
      );
      expect(err.exit).toBe(1);
      expect(err.message).toBe("the stored base for vendored is missing from HEAD");
      expect(err.data.choices).toEqual(["base_from_pin", "leave"]);
    });

    it("fails 1 when the committed base differs", () => {
      const { con, sha } = setup();
      commitBase(con, sha);
      const other = con.git("rev-parse", "HEAD^{tree}");
      const err = caught(() =>
        conn.requireBaseIntact(manifestFor(sha, other), "vendored", con.root),
      );
      expect(err.exit).toBe(1);
      expect(err.message).toBe(
        `the stored base for vendored does not match the pinned upstream commit ${sha}`,
      );
      expect(err.data.choices).toEqual(["base_from_pin", "leave"]);
    });

    it("offers without_base when the pinned commit is not in the object store", () => {
      const { con, sha } = setup();
      const tree = gitm.treeOid(sha, SUBPATH, con.root);
      const missing = "f".repeat(40);
      const absent = caught(() =>
        conn.requireBaseIntact(manifestFor(missing, tree), "vendored", con.root),
      );
      expect(absent.message).toBe("the stored base for vendored is missing from HEAD");
      expect(absent.data.choices).toEqual(["without_base", "leave"]);
      commitBase(con, sha);
      const differs = caught(() =>
        conn.requireBaseIntact(
          manifestFor(missing, con.git("rev-parse", "HEAD^{tree}")),
          "vendored",
          con.root,
        ),
      );
      expect(differs.message).toBe(
        `the stored base for vendored does not match the pinned upstream commit ${missing}`,
      );
      expect(differs.data.choices).toEqual(["without_base", "leave"]);
    });

    it("committedBaseTree ignores an uncommitted base on disk", () => {
      const { con, sha } = setup();
      conn.writeStoredBase("s", sha, SUBPATH, con.root);
      expect(existsSync(join(con.root, ".vendor-sync/base/s/SKILL.md"))).toBe(true);
      expect(conn.committedBaseTree("s", con.root)).toBeNull();
    });
  });

  it("countFiles counts regular files recursively and is 0 for an absent directory", () => {
    const { con } = setup();
    con.write({ "d/a": "a", "d/x/b": "b", "d/x/y/c": "c" });
    expect(conn.countFiles(join(con.root, "d"))).toBe(3);
    expect(conn.countFiles(join(con.root, "absent"))).toBe(0);
  });

  it("countFiles rethrows an error other than an absent path", () => {
    const { con } = setup();
    con.write({ "f.txt": "f" });
    expect(caught(() => conn.countFiles(join(con.root, "f.txt"))).code).toBe("ENOTDIR");
  });

  describe("finishAction", () => {
    // `vendored/` holds upstream's files, committed with a closed manifest at SHA; the
    // working tree then carries an open sync to the same target.
    const openSync = () => {
      const { con, sha } = setup();
      const upstream = gitm.treeOid(sha, SUBPATH, con.root);
      const prefixed = gitm.prefixedTree(upstream, "vendored", con.root, { omitManifest: true });
      gitm.restoreTree(prefixed, ["vendored"], con.root);
      const abs = join(con.root, "vendored");
      const closed = manifestFor(sha, upstream);
      conn.writeManifest(abs, closed);
      con.git("add", "--", "vendored");
      con.git("commit", "-q", "-m", "vendor");
      const manifest = {
        ...closed,
        in_progress: { action: "sync", state: "merge_staged", target_sha: sha },
      };
      conn.writeManifest(abs, manifest);
      con.write({ "vendored/x.orig": "backup\n", "vendored/a.md": "local\n" });
      conn.ensureScratch(con.root, "s");
      const before = con.git("rev-parse", "HEAD");
      return { con, sha, abs, manifest, before };
    };

    it("commits the tool's paths only", () => {
      const { con, sha, abs, manifest, before } = openSync();
      const oid = conn.finishAction({ root: con.root, rel: "vendored", abs, manifest });
      expect(oid).toBe(con.git("rev-parse", "HEAD"));
      expect(con.git("log", "-1", "--format=%s")).toBe(
        `vendor-sync: sync vendored to ${sha.slice(0, 7)}`,
      );
      expect(con.git("log", "-1", "--format=%P")).toBe(before);
      const names = con.git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(name.startsWith("vendored/") || name.startsWith(".vendor-sync/")).toBe(true);
      }
      expect(names).toContain("vendored/a.md");
      expect(names).toContain(".vendor-sync/base/s/SKILL.md");
      expect(names).toContain(".vendor-sync/.gitignore");
      expect(names).toContain(".vendor-sync/.gitattributes");
      const committed = JSON.parse(con.git("show", "HEAD:vendored/.vendor.json"));
      expect(committed.sha).toBe(sha);
      expect(committed.base_tree).toBe(con.git("rev-parse", "HEAD:.vendor-sync/base/s"));
      expect(committed.in_progress).toBeNull();
      expect(con.git("show", "HEAD:vendored/a.md")).toBe("local");
      expect(con.git("diff", "--cached", "--name-only")).toBe("");
      expect(con.git("status", "--porcelain", "--", "vendored/x.orig")).toBe("?? vendored/x.orig");
      expect(existsSync(conn.scratchDir(con.root, "s"))).toBe(false);
    });

    // Every file under `dir`, relative to it, with its content; {} when `dir` is absent.
    const filesUnder = (dir: string): Record<string, string> => {
      const out: Record<string, string> = {};
      if (!existsSync(dir)) return out;
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const abs = join(entry.parentPath, entry.name);
        out[relative(dir, abs)] = readFileSync(abs, "utf8");
      }
      return out;
    };
    const snapshot = (con: Repo, abs: string) => ({
      head: con.git("rev-parse", "HEAD"),
      cached: con.git("diff", "--cached", "--name-only"),
      status: con.git("status", "--porcelain", "--untracked-files=all"),
      base: filesUnder(join(con.root, ".vendor-sync/base/s")),
      manifest: readFileSync(join(abs, ".vendor.json"), "utf8"),
    });
    const failingPreCommit = (con: Repo): void => {
      const hooks = join(con.git("rev-parse", "--absolute-git-dir"), "hooks");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    };
    const finish = (con: Repo, abs: string, manifest: unknown) =>
      caught(() => conn.finishAction({ root: con.root, rel: "vendored", abs, manifest }));

    // A sync to a newer upstream commit: HEAD already holds a base for the slug and the tool
    // files, so a failure must bring that base back.
    const openSyncToNewer = () => {
      const { up, con, sha } = setup();
      const upstream = gitm.treeOid(sha, SUBPATH, con.root);
      const prefixed = gitm.prefixedTree(upstream, "vendored", con.root, { omitManifest: true });
      gitm.restoreTree(prefixed, ["vendored"], con.root);
      const abs = join(con.root, "vendored");
      const base_tree = conn.writeStoredBase("s", sha, SUBPATH, con.root);
      conn.writeToolFiles(con.root);
      const closed = manifestFor(sha, base_tree);
      conn.writeManifest(abs, closed);
      con.git("add", "--", "vendored");
      con.git("commit", "-q", "-m", "vendor");
      up.commitDeletion("drop a", [`${SUBPATH}/a.md`]);
      const target = refetch(up, con);
      const manifest = {
        ...closed,
        in_progress: { action: "sync", state: "merge_staged", target_sha: target },
      };
      conn.writeManifest(abs, manifest);
      con.write({ "vendored/x.orig": "backup\n" });
      conn.ensureScratch(con.root, "s");
      return { con, abs, manifest };
    };

    it("on a failed commit of a sync leaves index, working tree and stored base as they were", () => {
      const { con, abs, manifest } = openSyncToNewer();
      failingPreCommit(con);
      const before = snapshot(con, abs);
      expect(Object.keys(before.base)).toContain("a.md");
      const err = finish(con, abs, manifest);
      expect(err.exit).toBe(1);
      expect(snapshot(con, abs)).toEqual(before);
      expect(before.manifest).toBe(conn.serializeManifest(manifest));
      expect(existsSync(conn.scratchDir(con.root, "s"))).toBe(true);
    });

    it("on a failed commit of an add leaves no stored base or tool files behind", () => {
      const { con, sha } = setup();
      const upstream = gitm.treeOid(sha, SUBPATH, con.root);
      const prefixed = gitm.prefixedTree(upstream, "vendored", con.root, { omitManifest: true });
      gitm.restoreTree(prefixed, ["vendored"], con.root);
      const abs = join(con.root, "vendored");
      const manifest = {
        ...manifestFor(sha, upstream),
        in_progress: { action: "add", state: "merge_staged", target_sha: sha },
      };
      conn.writeManifest(abs, manifest);
      conn.ensureScratch(con.root, "s");
      failingPreCommit(con);
      const before = snapshot(con, abs);
      const err = finish(con, abs, manifest);
      expect(err.exit).toBe(1);
      expect(snapshot(con, abs)).toEqual(before);
      expect(before.manifest).toBe(conn.serializeManifest(manifest));
      expect(existsSync(join(con.root, ".vendor-sync/base"))).toBe(false);
      expect(existsSync(join(con.root, ".vendor-sync/.gitignore"))).toBe(false);
      expect(existsSync(join(con.root, ".vendor-sync/.gitattributes"))).toBe(false);
      expect(existsSync(conn.scratchDir(con.root, "s"))).toBe(true);
    });

    it("a failure while writing the stored base leaves the state as it was", () => {
      const { con, abs, manifest } = openSyncToNewer();
      const before = snapshot(con, abs);
      // restore has written and staged the new base when this runs.
      const shim = gitShim({
        failOn: ["ls-files", "-d", "-z", "--", ":(literal).vendor-sync/base/s"],
      });
      const savedPath = process.env.PATH;
      process.env.PATH = shim.env.PATH;
      process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
      let err: any;
      try {
        err = finish(con, abs, manifest);
      } finally {
        process.env.PATH = savedPath;
        delete process.env.SHIM_FAIL;
        shim.cleanup();
      }
      expect(err.exit).toBe(2);
      expect(snapshot(con, abs)).toEqual(before);
    });

    it("a failing stage of the manifest leaves the open manifest and the state as they were", () => {
      const { con, abs, manifest } = openSyncToNewer();
      const before = snapshot(con, abs);
      const shim = gitShim({ failOn: ["add", "--", ":(literal)vendored/.vendor.json"] });
      const savedPath = process.env.PATH;
      process.env.PATH = shim.env.PATH;
      process.env.SHIM_FAIL = shim.env.SHIM_FAIL;
      let err: any;
      try {
        err = finish(con, abs, manifest);
      } finally {
        process.env.PATH = savedPath;
        delete process.env.SHIM_FAIL;
        shim.cleanup();
      }
      expect(err.exit).toBe(2);
      expect(err.message).toBe("cannot stage the manifest");
      expect(snapshot(con, abs)).toEqual(before);
      expect(before.manifest).toBe(conn.serializeManifest(manifest));
    });
  });

  it("requireCleanDir names every uncommitted path under <rel>, sorted, with a hint", () => {
    const con = buildConsumer({
      "vendored/a.md": "a\n",
      "vendored/b.md": "b\n",
      "other.txt": "o\n",
    });
    cleanups.push(() => con.cleanup());
    expect(conn.requireCleanDir("vendored", con.root)).toBeUndefined();
    con.write({ "vendored/b.md": "b2\n", "vendored/new.md": "n\n", "other.txt": "o2\n" });
    con.git("rm", "-q", "--", "vendored/a.md");
    const err = caught(() => conn.requireCleanDir("vendored", con.root));
    expect(err.exit).toBe(2);
    expect(err.message).toBe(
      "vendored has uncommitted changes: vendored/a.md, vendored/b.md, vendored/new.md",
    );
    expect(err.hint).toBe("commit or discard them, then re-run");
  });

  describe("requireNothingStagedOutside and requireNothingStagedForCommit", () => {
    const repo = () => {
      const con = buildConsumer({ "vendored/a.md": "a\n", "other.txt": "o\n" });
      cleanups.push(() => con.cleanup());
      return con;
    };

    it("ForCommit passes with only <rel> and the slug's tool paths staged, or unstaged and untracked work", () => {
      const con = repo();
      con.write({
        "vendored/a.md": "a2\n",
        "vendored/sub/n.md": "n\n",
        ".vendor-sync/base/s/x.md": "x\n",
        ".vendor-sync/.gitignore": "/scratch/\n",
        ".vendor-sync/.gitattributes": "base/** -diff\n",
        "other.txt": "unstaged\n",
        "untracked.txt": "u\n",
      });
      con.git("add", "--", "vendored", ".vendor-sync");
      expect(() => conn.requireNothingStagedForCommit("vendored", "s", con.root)).not.toThrow();
    });

    it("ForCommit fails 1, listing every staged path outside", () => {
      const con = repo();
      con.write({
        "vendored2/x.md": "x\n",
        "other.txt": "o2\n",
        ".vendor-sync/base/t/y.md": "y\n",
        "vendored/a.md": "a2\n",
      });
      con.git("add", "--", "vendored2", "other.txt", ".vendor-sync", "vendored");
      const err = caught(() => conn.requireNothingStagedForCommit("vendored", "s", con.root));
      expect(err.exit).toBe(1);
      expect(err.message).toBe(
        "staged changes outside vendored: .vendor-sync/base/t/y.md, other.txt, vendored2/x.md",
      );
      expect(err.hint).toBe("commit or unstage them, then re-run");
    });

    it("the start check counts the tool paths as outside", () => {
      const con = repo();
      con.write({ ".vendor-sync/.gitignore": "/scratch/\n" });
      con.git("add", "--", ".vendor-sync");
      const err = caught(() => conn.requireNothingStagedOutside("vendored", con.root));
      expect(err.exit).toBe(2);
      expect(err.message).toBe("staged changes outside vendored: .vendor-sync/.gitignore");
    });

    it("the start check fails 2", () => {
      const con = repo();
      con.write({ "other.txt": "o2\n" });
      con.git("add", "--", "other.txt");
      const err = caught(() => conn.requireNothingStagedOutside("vendored", con.root));
      expect(err.exit).toBe(2);
      expect(err.message).toBe("staged changes outside vendored: other.txt");
    });

    it("sees a staged gitlink despite diff.ignoreSubmodules=all", () => {
      const con = repo();
      con.git("config", "diff.ignoreSubmodules", "all");
      const oid = con.git("rev-parse", "HEAD");
      con.git("update-index", "--add", "--cacheinfo", `160000,${oid},sm`);
      const err = caught(() => conn.requireNothingStagedOutside("vendored", con.root));
      expect(err.message).toBe("staged changes outside vendored: sm");
    });
  });

  it("does not export toolPaths", () => {
    expect(conn.toolPaths).toBeUndefined();
  });

  it("does not export the tool file constants", () => {
    expect(conn.TOOL_GITIGNORE).toBeUndefined();
    expect(conn.TOOL_GITATTRIBUTES).toBeUndefined();
  });
});
