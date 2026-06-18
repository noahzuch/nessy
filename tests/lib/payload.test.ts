import { describe, it, expect } from "vitest";
import {
  BasePayloadSchema,
  ReadHookPayloadSchema,
  WriteEditHookPayloadSchema,
  BashHookPayloadSchema,
  tryParsePayload,
} from "../../src/lib/payload.js";

// --- BasePayloadSchema ---

describe("BasePayloadSchema", () => {
  // Test 1: accepts minimal valid payload
  it("accepts minimal valid payload (session_id, cwd, hook_event_name)", () => {
    const result = BasePayloadSchema.safeParse({
      session_id: "abc123",
      cwd: "/home/user/project",
      hook_event_name: "PreToolUse",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.session_id).toBe("abc123");
      expect(result.data.cwd).toBe("/home/user/project");
      expect(result.data.hook_event_name).toBe("PreToolUse");
    }
  });

  // Test 2: allows optional agent_id and agent_type
  it("allows optional agent_id and agent_type", () => {
    const result = BasePayloadSchema.safeParse({
      session_id: "abc123",
      cwd: "/home/user/project",
      agent_id: "agent-1",
      agent_type: "subagent",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent_id).toBe("agent-1");
      expect(result.data.agent_type).toBe("subagent");
    }
  });

  // Test 3: rejects payload missing session_id
  it("rejects payload missing session_id", () => {
    const result = BasePayloadSchema.safeParse({
      cwd: "/home/user/project",
      hook_event_name: "PreToolUse",
    });
    expect(result.success).toBe(false);
  });
});

// --- ReadHookPayloadSchema ---

describe("ReadHookPayloadSchema", () => {
  // Test 4: accepts tool_name "Read" with tool_input.file_path
  it('accepts tool_name "Read" with tool_input.file_path', () => {
    const result = ReadHookPayloadSchema.safeParse({
      session_id: "s1",
      cwd: "/proj",
      tool_name: "Read",
      tool_input: { file_path: "/proj/src/index.ts" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool_name).toBe("Read");
      expect(result.data.tool_input.file_path).toBe("/proj/src/index.ts");
    }
  });

  // Test 5: rejects when tool_name is not "Read"
  it('rejects when tool_name is not "Read"', () => {
    const result = ReadHookPayloadSchema.safeParse({
      session_id: "s1",
      cwd: "/proj",
      tool_name: "Write",
      tool_input: { file_path: "/proj/out.ts" },
    });
    expect(result.success).toBe(false);
  });
});

// --- WriteEditHookPayloadSchema ---

describe("WriteEditHookPayloadSchema", () => {
  // Test 6: accepts tool_name "Write" + file_path
  it('accepts tool_name "Write" + file_path', () => {
    const result = WriteEditHookPayloadSchema.safeParse({
      session_id: "s1",
      cwd: "/proj",
      tool_name: "Write",
      tool_input: { file_path: "/proj/out.ts" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool_name).toBe("Write");
    }
  });

  // Test 7: accepts tool_name "Edit" + file_path
  it('accepts tool_name "Edit" + file_path', () => {
    const result = WriteEditHookPayloadSchema.safeParse({
      session_id: "s1",
      cwd: "/proj",
      tool_name: "Edit",
      tool_input: { file_path: "/proj/out.ts" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool_name).toBe("Edit");
    }
  });

  // Test 8: rejects when tool_name is "Read" (sibling distinguishing)
  it('rejects when tool_name is "Read" (sibling distinguishing)', () => {
    const result = WriteEditHookPayloadSchema.safeParse({
      session_id: "s1",
      cwd: "/proj",
      tool_name: "Read",
      tool_input: { file_path: "/proj/out.ts" },
    });
    expect(result.success).toBe(false);
  });
});

// --- BashHookPayloadSchema ---

describe("BashHookPayloadSchema", () => {
  // Test 9: accepts tool_name "Bash" with tool_input.command
  it('accepts tool_name "Bash" with tool_input.command', () => {
    const result = BashHookPayloadSchema.safeParse({
      session_id: "s1",
      cwd: "/proj",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tool_name).toBe("Bash");
      expect(result.data.tool_input.command).toBe("npm test");
    }
  });

  // Test 10: rejects when tool_name is not "Bash"
  it('rejects when tool_name is not "Bash"', () => {
    const result = BashHookPayloadSchema.safeParse({
      session_id: "s1",
      cwd: "/proj",
      tool_name: "Read",
      tool_input: { command: "npm test" },
    });
    expect(result.success).toBe(false);
  });
});

// --- tryParsePayload ---

describe("tryParsePayload", () => {
  // Test 11: returns data on success
  it("returns data on valid input", () => {
    const input = { session_id: "s1", cwd: "/proj", hook_event_name: "PostToolUse" };
    const result = tryParsePayload(BasePayloadSchema, input);
    expect(result).not.toBeNull();
    expect(result?.session_id).toBe("s1");
  });

  // Test 12: returns null on schema failure
  it("returns null on schema failure", () => {
    const result = tryParsePayload(BasePayloadSchema, { cwd: "/proj" }); // missing session_id
    expect(result).toBeNull();
  });

  // Test 13: returns null on non-object input (string)
  it("returns null on non-object input (string)", () => {
    const result = tryParsePayload(BasePayloadSchema, "not an object");
    expect(result).toBeNull();
  });

  // Test 14: returns null on non-object input (null)
  it("returns null on non-object input (null)", () => {
    const result = tryParsePayload(BasePayloadSchema, null);
    expect(result).toBeNull();
  });
});
