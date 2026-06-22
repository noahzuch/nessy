import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("src/lib/payload.js", () => ({
  readAndParsePayload: vi.fn(),
}));
vi.mock("src/lib/paths.js", () => ({
  findProjectRoot: vi.fn(),
  normalize: (p: string) => p,
}));
vi.mock("src/lib/config.js", () => ({
  parseConfig: vi.fn(),
}));
vi.mock("src/lib/log.js", () => ({
  configure: vi.fn(),
  log: vi.fn(),
}));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import { runHook } from "src/lib/run-hook.js";
import { readAndParsePayload } from "src/lib/payload.js";
import { findProjectRoot } from "src/lib/paths.js";
import { parseConfig } from "src/lib/config.js";

const basePayload = {
  session_id: "s1",
  agent_id: "a1",
  cwd: "/proj",
  hook_event_name: "PreToolUse",
};

beforeEach(() => vi.clearAllMocks());

describe("runHook — requiresProject: false", () => {
  it("calls fn with projectRoot null when root not found", () => {
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue(null);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: false }, fn);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: null, cfg: null }));
  });

  it("calls fn with projectRoot when root found", () => {
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue("/proj");
    vi.mocked(parseConfig).mockReturnValue({ log_level: "info", hints: false, rules: [] } as any);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: false }, fn);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/proj" }));
  });

  it("exposes sessionId and agentId on ctx", () => {
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue(null);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: false }, fn);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", agentId: "a1" }));
  });
});

describe("runHook — requiresProject: true", () => {
  it("does not call fn when root is null", () => {
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue(null);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: true, requiresConfig: false }, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls fn with projectRoot and cfg null when config fails", () => {
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue("/proj");
    vi.mocked(parseConfig).mockImplementation(() => {
      throw new Error("bad");
    });
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: true, requiresConfig: false }, fn);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/proj", cfg: null }));
  });

  it("calls fn with cfg when config loads", () => {
    const cfg = { log_level: "debug", hints: true, rules: [] } as any;
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue("/proj");
    vi.mocked(parseConfig).mockReturnValue(cfg);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: true, requiresConfig: false }, fn);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/proj", cfg }));
  });
});

describe("runHook — requiresConfig: true", () => {
  it("emits generic block and does not call fn when config fails", () => {
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue("/proj");
    vi.mocked(parseConfig).mockImplementation(() => {
      throw new Error("bad");
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: true, requiresConfig: true }, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("configuration error"));
    writeSpy.mockRestore();
  });

  it("calls fn with cfg when config loads", () => {
    const cfg = { log_level: "debug", hints: true, rules: [] } as any;
    vi.mocked(readAndParsePayload).mockReturnValue(basePayload as any);
    vi.mocked(findProjectRoot).mockReturnValue("/proj");
    vi.mocked(parseConfig).mockReturnValue(cfg);
    const fn = vi.fn();
    runHook("test", {} as any, { requiresProject: true, requiresConfig: true }, fn);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/proj", cfg }));
  });
});
