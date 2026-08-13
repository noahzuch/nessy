import { resolve } from "node:path";
import { UserPromptSubmitPayloadSchema } from "src/shared/payload.js";
import { recordAndHint } from "src/features/read-before-write/lib/record-and-hint.js";
import { log } from "src/shared/log.js";
import { runHook } from "src/shared/run-hook.js";

function extractMentions(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of prompt.matchAll(/@([\w./\\-]+)/g)) {
    const p = m[1];
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

runHook(
  "record-at-mention",
  UserPromptSubmitPayloadSchema,
  { requiresProject: true, requiresConfig: false },
  ({ payload, projectRoot, cfg }) => {
    const mentions = extractMentions(payload.prompt);
    if (mentions.length === 0) return;

    const { message, unread } = recordAndHint({
      targets: mentions.map((mention) => resolve(payload.cwd, mention)),
      projectRoot,
      sessionId: payload.session_id,
      agentId: payload.agent_id ?? null,
      cfg,
      preamble: () => [
        `Nessy: The @-mentioned file(s) above match rules that require additional context.`,
        `To fully understand its content, you **must** read the following documentation files:`,
      ],
    });

    if (message === null) return;
    process.stdout.write(JSON.stringify({ additionalContext: message }));
    log("info", `hint: ${unread.join(",")}`);
  },
);
