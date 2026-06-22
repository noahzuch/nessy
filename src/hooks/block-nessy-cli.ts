import { configure, log } from "src/lib/log.js";
import { BashHookPayloadSchema, readAndParsePayload } from "src/lib/payload.js";

const PATTERN = /\bnessy\s+\w/;
const BLOCK_MSG =
  "Nessy: nessy CLI commands are user-only; Claude cannot run them. " +
  "If the user wants this, they should invoke the matching plugin skill themselves.";

function main(): void {
  const payload = readAndParsePayload(BashHookPayloadSchema);
  if (payload === null) return;
  configure({
    level: "info",
    hookName: "block-nessy-cli",
    sessionId: payload.session_id,
    agentId: payload.agent_id ?? null,
  });
  const cmd = payload.tool_input.command;
  if (!PATTERN.test(cmd)) return;
  log("info", `block: ${cmd}`);
  process.stdout.write(JSON.stringify({ decision: "block", reason: BLOCK_MSG }));
}
main();
