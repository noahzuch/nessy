import {afterEach, it, expect} from "vitest";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {nessyConfig} from "src/cli/config.js";

const CONFIG = `
version: 1
hints: false
log_level: warn
rules:
  - name: my-rule
    match: "src/**"
    require:
      - docs/standards/coding.md
`.trimStart();

let cwd: string | undefined;
afterEach(() => {
    if (cwd) rmSync(cwd, {recursive: true, force: true});
    cwd = undefined;
});

function makeProject(yaml = CONFIG): string {
    const dir = mkdtempSync(join(tmpdir(), "nessy-config-test-"));
    mkdirSync(join(dir, ".nessy"));
    writeFileSync(join(dir, ".nessy", "config.yml"), yaml);
    return dir;
}

it("returns a boolean scalar as a string", () => {
    cwd = makeProject();
    const out: string[] = [];
    const code = nessyConfig((m) => out.push(m), () => {}, cwd, "hints");
    expect(code).toBe(0);
    expect(out).toEqual(["false"]);
});

it("returns a string scalar", () => {
    cwd = makeProject();
    const out: string[] = [];
    const code = nessyConfig((m) => out.push(m), () => {}, cwd, "log_level");
    expect(code).toBe(0);
    expect(out).toEqual(["warn"]);
});

it("returns a nested scalar via dot path", () => {
    cwd = makeProject();
    const out: string[] = [];
    const code = nessyConfig((m) => out.push(m), () => {}, cwd, "rules.0.name");
    expect(code).toBe(0);
    expect(out).toEqual(["my-rule"]);
});

it("returns an array element's nested value", () => {
    cwd = makeProject();
    const out: string[] = [];
    const code = nessyConfig((m) => out.push(m), () => {}, cwd, "rules.0.require.0");
    expect(code).toBe(0);
    expect(out).toEqual(["docs/standards/coding.md"]);
});

it("returns complex values as JSON", () => {
    cwd = makeProject();
    const out: string[] = [];
    const code = nessyConfig((m) => out.push(m), () => {}, cwd, "rules");
    expect(code).toBe(0);
    expect(JSON.parse(out[0])).toEqual([
        {name: "my-rule", match: ["src/**"], require: ["docs/standards/coding.md"]},
    ]);
});

it("returns 1 and prints error for unknown key", () => {
    cwd = makeProject();
    const err: string[] = [];
    const code = nessyConfig(() => {}, (m) => err.push(m), cwd, "nonexistent");
    expect(code).toBe(1);
    expect(err.join("")).toContain("Key not found");
});

it("returns 1 when no project root found", () => {
    const err: string[] = [];
    const code = nessyConfig(() => {}, (m) => err.push(m), tmpdir(), "hints");
    expect(code).toBe(1);
    expect(err.join("")).toContain(".nessy/config.yml");
});
