import { z } from "zod";
import { readFileSync } from "node:fs";
export const BasePayloadSchema = z.object({
    session_id: z.string().min(1),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    cwd: z.string().min(1),
    hook_event_name: z.string().optional(),
});
export const ReadHookPayloadSchema = BasePayloadSchema.extend({
    tool_name: z.literal("Read"),
    tool_input: z.object({ file_path: z.string().min(1) }),
});
export const WriteEditHookPayloadSchema = BasePayloadSchema.extend({
    tool_name: z.union([z.literal("Write"), z.literal("Edit")]),
    tool_input: z.object({ file_path: z.string().min(1) }),
});
export const BashHookPayloadSchema = BasePayloadSchema.extend({
    tool_name: z.literal("Bash"),
    tool_input: z.object({ command: z.string() }),
});
export const UserPromptSubmitPayloadSchema = BasePayloadSchema.extend({
    hook_event_name: z.literal("UserPromptSubmit"),
    prompt: z.string(),
});
export function tryParsePayload(schema, raw) {
    const r = schema.safeParse(raw);
    return r.success ? r.data : null;
}
export function readAndParsePayload(schema) {
    let raw;
    try {
        raw = JSON.parse(readFileSync(0, "utf8"));
    }
    catch (e) {
        throw new Error(`Nessy: failed to read stdin: ${e instanceof Error ? e.message : String(e)}`);
    }
    const r = schema.safeParse(raw);
    if (!r.success)
        throw new Error(`Nessy: invalid payload: ${r.error.message}`);
    return r.data;
}
//# sourceMappingURL=payload.js.map