import { describe, it, expect, beforeEach } from "vitest";
import { configure, log, type Level } from "../../src/lib/log.js";

function capture() {
  const orig = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  // @ts-expect-error narrowing process.stderr.write for the test
  process.stderr.write = (chunk: string) => {
    lines.push(String(chunk));
    return true;
  };
  return { lines, restore: () => (process.stderr.write = orig) };
}

describe("logger", () => {
  beforeEach(() => configure({ level: "info", hookName: "h", sessionId: "s", agentId: null }));

  it("emits one JSON line per call with required fields", () => {
    const c = capture();
    try {
      log("info", "hello");
    } finally {
      c.restore();
    }
    const o = JSON.parse(c.lines[0]);
    expect(o).toMatchObject({
      message: "hello",
      hook: "h",
      session_id: "s",
      agent_id: null,
      level: "info",
    });
    expect(typeof o.ts).toBe("string");
    expect(c.lines[0].endsWith("\n")).toBe(true);
  });

  it("filters messages below configured level", () => {
    const c = capture();
    try {
      log("debug", "x");
      log("info", "y");
    } finally {
      c.restore();
    }
    expect(c.lines).toHaveLength(1);
    expect(JSON.parse(c.lines[0]).message).toBe("y");
  });

  it("emits error regardless of configured level", () => {
    configure({ level: "error", hookName: "h", sessionId: "s", agentId: null });
    const c = capture();
    try {
      log("info", "filtered");
      log("error", "kept");
    } finally {
      c.restore();
    }
    expect(JSON.parse(c.lines[0]).message).toBe("kept");
  });

  it("renders agent_id as null (not omitted)", () => {
    const c = capture();
    try {
      log("info", "x");
    } finally {
      c.restore();
    }
    const o = JSON.parse(c.lines[0]);
    expect("agent_id" in o).toBe(true);
    expect(o.agent_id).toBe(null);
  });

  it("renders agent_id as string when set", () => {
    configure({ level: "info", hookName: "h", sessionId: "s", agentId: "a1" });
    const c = capture();
    try {
      log("info", "x");
    } finally {
      c.restore();
    }
    expect(JSON.parse(c.lines[0]).agent_id).toBe("a1");
  });

  it("configure is idempotent — last call wins", () => {
    configure({ level: "info", hookName: "h1", sessionId: "s1", agentId: null });
    configure({ level: "info", hookName: "h2", sessionId: "s2", agentId: "a" });
    const c = capture();
    try {
      log("info", "x");
    } finally {
      c.restore();
    }
    expect(JSON.parse(c.lines[0])).toMatchObject({ hook: "h2", session_id: "s2", agent_id: "a" });
  });
});
