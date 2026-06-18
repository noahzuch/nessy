import { defineCommand } from "citty";
import { initCommand } from "./init.js";
// removeCommand added in Task 18.

export const mainCommand = defineCommand({
  meta: { name: "nessy", description: "Read-before-write enforcement for Claude Code" },
  subCommands: { init: initCommand },
});
