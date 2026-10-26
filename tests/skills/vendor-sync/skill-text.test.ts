import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SKILL_DIR = join(REPO_ROOT, ".claude/skills/vendor-sync");
const SPEC = join(REPO_ROOT, "docs/brainstorm/2026-09-12-vendor-sync-ide-merge/spec.md");

const FENCE = "```";

function skillFile(name: string): string {
  return readFileSync(join(SKILL_DIR, name), "utf8");
}

// The fenced blocks (between a line that is exactly three backticks and the next such line).
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let open: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line === FENCE) {
      if (open === null) {
        open = [];
      } else {
        blocks.push(open.join("\n"));
        open = null;
      }
    } else if (open !== null) {
      open.push(line);
    }
  }
  return blocks;
}

// The text between the line `#### Verbatim blocks` and the next line starting with `### `.
function verbatimSection(): string {
  const lines = readFileSync(SPEC, "utf8").split("\n");
  const start = lines.indexOf("#### Verbatim blocks");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("### "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function specBlocks(): string[] {
  return fencedBlocks(verbatimSection());
}

// The lines of a Markdown file outside fenced blocks, each with its index.
function linesOutsideFences(text: string): { line: string; index: number }[] {
  const result: { line: string; index: number }[] = [];
  let inFence = false;
  text.split("\n").forEach((line, index) => {
    if (line.startsWith(FENCE)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) result.push({ line, index });
  });
  return result;
}

// The body of the `## <name>` section: up to the next `## ` heading outside a fence.
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const outside = linesOutsideFences(text);
  const start = outside.find((l) => l.line === heading);
  expect(start, `missing heading ${heading}`).toBeDefined();
  const next = outside.find((l) => l.index > start!.index && /^##? /.test(l.line));
  return lines.slice(start!.index + 1, next ? next.index : lines.length).join("\n");
}

// `### <state>` subsections of `## Outcomes`, each mapped to its body.
function outcomeStates(text: string): Map<string, string> {
  const body = section(text, "## Outcomes");
  const lines = body.split("\n");
  const headings = linesOutsideFences(body).filter((l) => l.line.startsWith("### "));
  const states = new Map<string, string>();
  headings.forEach((h, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].index : lines.length;
    states.set(h.line.slice(4), lines.slice(h.index + 1, end).join("\n"));
  });
  return states;
}

const PLACEHOLDER = /<([^<>]*(?:<[^<>]*>[^<>]*)*\|[^<>]*(?:<[^<>]*>[^<>]*)*)>/g;

const BLOCK_FILES: [string, string[]][] = [
  ["Resolve prompt", ["add.md", "sync.md"]],
  ["Open action, same action", ["add.md", "sync.md"]],
  ["Open action, other action or interrupted start", ["add.md", "sync.md"]],
  ["Base mismatch, pinned commit available", ["sync.md"]],
  ["Base mismatch, pinned commit gone", ["sync.md"]],
  ["Submodules note", ["add.md", "sync.md"]],
  ["no_base note", ["add.md", "sync.md"]],
  ["sync report", ["sync.md"]],
  ["add report", ["add.md"]],
  ["abort report", ["add.md", "sync.md"]],
  ["remove report", ["remove.md"]],
  ["list report", ["list.md"]],
];

const ACTION_STATES: Record<string, string[]> = {
  "add.md": ["ready", "merge_staged", "added", "aborted"],
  "sync.md": ["up_to_date", "pin_ready", "merge_staged", "synced", "aborted"],
  "remove.md": ["removed"],
  "list.md": ["listed"],
};

// States that lead on to another call rather than finishing the action.
const LEADS_ON = new Set(["ready", "pin_ready", "merge_staged"]);

function lastNonEmptyLine(text: string): string | undefined {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .at(-1);
}

describe("vendor-sync skill text", () => {
  it("AC-35: every verbatim block appears byte for byte in the action files that use it", () => {
    const blocks = specBlocks();
    expect(blocks).toHaveLength(12);
    blocks.forEach((block, i) => {
      const [name, files] = BLOCK_FILES[i];
      for (const file of files) {
        const text = skillFile(file);
        expect(text.includes(block), `${file} lacks block ${i + 1} (${name})`).toBe(true);
        for (const match of block.matchAll(PLACEHOLDER)) {
          for (const alternative of match[1].split(" | ")) {
            expect(text, `${file}: alternative of block ${i + 1}`).toContain(alternative);
          }
        }
      }
    });
    expect(skillFile("sync.md")).toContain("The commit is local and not pushed");
    expect(skillFile("add.md")).toContain("The commit is local and not pushed");
  });

  it("AC-35: the option counts match the options and the resolve prompt names the action", () => {
    const blocks = specBlocks();
    const block = (name: string) => blocks[BLOCK_FILES.findIndex(([n]) => n === name)];
    for (const name of [
      "Open action, other action or interrupted start",
      "Base mismatch, pinned commit available",
      "Base mismatch, pinned commit gone",
    ]) {
      expect(block(name), name).toContain("There are two options going forward");
    }
    expect(block("Open action, same action")).toContain("There are three options going forward");
    expect(block("Resolve prompt")).toContain("I will then continue the <action>.");
    expect(skillFile("add.md")).toContain("filling `<action>` with `add`");
    expect(skillFile("sync.md")).toContain("filling `<action>` with `sync`");
  });

  it("AC-35: the add and sync reports count the changed files, the abort report the removed ones", () => {
    const blocks = specBlocks();
    const block = (name: string) => blocks[BLOCK_FILES.findIndex(([n]) => n === name)];
    for (const name of ["add report", "sync report"]) {
      const lines = block(name).split("\n");
      expect(
        lines.filter((l) => l.startsWith("  files ")),
        name,
      ).toEqual(["  files     <n> changed"]);
      expect(block(name), name).not.toContain("kept local");
    }
    expect(block("sync report")).toContain("  changes   none: pin only | none: already up to date");
    const abort = block("abort report").split("\n");
    expect(abort.find((l) => l.startsWith("  removed "))).toMatch(
      /^  removed   <n> files the action had created +\(only if any were removed\)$/,
    );
    expect(abort.find((l) => l.startsWith("  restored "))).toBe(
      "  restored  <n> files to their last committed state",
    );
    expect(abort.find((l) => l.startsWith("  left "))).toMatch(
      /^  left      <path> … +\(only if any were left\)$/,
    );
    for (const file of ["add.md", "sync.md"]) {
      const text = skillFile(file);
      expect(text, file).not.toContain("`outcome`");
      expect(text, file).toContain("the number of `removed` paths");
    }
    expect(skillFile("add.md")).toContain("the files the commit changed in `<dir>`");
    expect(skillFile("sync.md")).toContain("the files the commit changed in `<dir>`");
  });

  it("the submodules note follows every start object that reports skipped_submodules", () => {
    const note = specBlocks()[BLOCK_FILES.findIndex(([n]) => n === "Submodules note")];
    expect(note).toBe(
      "Note: upstream's submodules are not vendored, so these folders stay absent: <paths>.",
    );
    for (const [file, states] of [
      ["add.md", ["ready", "merge_staged"]],
      ["sync.md", ["pin_ready", "merge_staged"]],
    ] as const) {
      const outcomes = outcomeStates(skillFile(file));
      for (const state of states) {
        const body = outcomes.get(state)!;
        expect(body, `${file} ${state}`).toContain("`skipped_submodules`");
        expect(body, `${file} ${state}`).toContain(note);
      }
    }
  });

  it("SKILL.md says an action needs nothing staged outside the vendored directory", () => {
    expect(skillFile("SKILL.md")).toContain(
      "An action needs nothing staged outside the vendored directory",
    );
  });

  it("hint and stderr are relayed only when present, and their absence is never mentioned", () => {
    const skill = skillFile("SKILL.md");
    expect(skill).toContain(
      "- 2 — stop. Report `error.message` verbatim, and `error.hint` verbatim when present, and do\n" +
        "  nothing further.",
    );
    const flat = skill.replace(/\s+/g, " ");
    expect(flat).toContain("Quote stderr verbatim beneath the report only when there is any.");
    expect(flat).toContain("Never mention that a hint or stderr is absent.");
    for (const file of ["add.md", "sync.md", "remove.md", "list.md"]) {
      const text = skillFile(file).replace(/\s+/g, " ");
      expect(text, file).not.toMatch(/`error\.hint`(?! if present)/);
      expect(text, file).not.toMatch(/the stderr(?! if any)/);
    }
  });

  it("AC-35: no verbatim block names script internals", () => {
    for (const block of specBlocks()) {
      expect(block).not.toContain("--continue");
      expect(block).not.toContain("plan.json");
      expect(block).not.toContain("scripts/");
    }
  });

  it("AC-36: the argument gate lists exactly the accepted forms and the boundaries forbid committing", () => {
    const skill = skillFile("SKILL.md");
    const gate = fencedBlocks(section(skill, "## Argument gate"))[0];
    expect(gate).toBe(
      [
        "add <repo> <path> <dir> [--ref <branch>] [--sha <commit>]",
        "add <dir> --abort",
        "sync <dir> [--base-from-pin | --without-base]",
        "sync <dir> --abort",
        "remove <dir>",
        "list",
      ].join("\n"),
    );
    const boundaries = section(skill, "## Boundaries");
    expect(boundaries).toContain("Never commit yourself.");
    expect(boundaries).toContain(
      "`--continue` commits, and you run it only on the user's word that they are finished.",
    );
  });

  it("AC-36: the argument gate never infers the action from the other arguments", () => {
    const gate = section(skillFile("SKILL.md"), "## Argument gate").replace(/\s+/g, " ");
    expect(gate).toContain("Proceed only when the user named the action");
    expect(gate).toContain("Never infer the action from the other arguments");
    expect(gate).toContain("ask which one and run nothing until the user answers");
  });

  it("SKILL.md starts with front matter naming the skill and gating invocation", () => {
    const skill = skillFile("SKILL.md");
    expect(skill.startsWith("---\n")).toBe(true);
    const end = skill.indexOf("\n---\n", 4);
    expect(end).toBeGreaterThan(0);
    const lines = skill.slice(4, end).split("\n");
    expect(lines).toContain("name: vendor-sync");
    expect(lines).toContain('argument-hint: "add|sync|remove|list [args]"');
    expect(lines).toContain("disable-model-invocation: true");
    expect(lines.some((line) => line.startsWith("description:"))).toBe(true);
  });

  it("each action file has Inputs, Run, Outcomes and Report, with one entry per state", () => {
    for (const [file, states] of Object.entries(ACTION_STATES)) {
      const text = skillFile(file);
      for (const heading of ["## Inputs", "## Run", "## Outcomes", "## Report"]) {
        section(text, heading);
      }
      const outcomes = outcomeStates(text);
      expect([...outcomes.keys()], file).toEqual(states);
      for (const [state, body] of outcomes) {
        const last = lastNonEmptyLine(body);
        if (LEADS_ON.has(state)) {
          expect(last, `${file} ${state}`).not.toBe("**Done.**");
        } else {
          expect(last, `${file} ${state}`).toBe("**Done.**");
        }
      }
    }
  });
});
