import { defineCommand } from "citty";
import { initCommand } from "./init.js";
import { removeCommand } from "./remove.js";
import { configCommand } from "./config.js";

export const mainCommand = defineCommand({
  meta: { name: "nessy", description: "CLI for Nessy, a development workflow harness" },
  subCommands: { init: initCommand, remove: removeCommand, config: configCommand },
});
