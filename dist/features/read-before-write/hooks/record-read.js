import { resolve } from "node:path";
import { ReadHookPayloadSchema } from "../../../shared/payload.js";
import { recordAndHint } from "../../../features/read-before-write/lib/record-and-hint.js";
import { log } from "../../../shared/log.js";
import { runHook } from "../../../shared/run-hook.js";
runHook("record-read", ReadHookPayloadSchema, { requiresProject: true, requiresConfig: false }, ({ payload, projectRoot, cfg }) => {
    const { message, matchedRules } = recordAndHint({
        targets: [resolve(payload.tool_input.file_path)],
        projectRoot,
        sessionId: payload.session_id,
        agentId: payload.agent_id ?? null,
        cfg,
        preamble: ([relTarget]) => [
            `Nessy: You just read \`${relTarget}\`. To fully understand its content, you **must** read the following documentation files:`,
        ],
    });
    if (message !== null) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: { additionalContext: message, hookEventName: "PostToolUse" },
        }));
        log("info", `hint: ${matchedRules.join(",")}`);
    }
});
//# sourceMappingURL=record-read.js.map