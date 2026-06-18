import { defineCommand } from "citty";
import { initCommand } from "./init.js";
import { removeCommand } from "./remove.js";
export const mainCommand = defineCommand({
    meta: { name: "nessy", description: "Read-before-write enforcement for Claude Code" },
    subCommands: { init: initCommand, remove: removeCommand },
});
//# sourceMappingURL=index.js.map