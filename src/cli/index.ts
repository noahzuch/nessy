import { nessyInit } from "./init.js";
import { nessyRemove } from "./remove.js";

const USAGE = [
  "Usage: nessy <subcommand>",
  "",
  "Subcommands:",
  "  init      Initialize .nessy/ in the current directory",
  "  remove    Remove .nessy/ from the current directory",
  "",
  "Flags:",
  "  --help, -h    Show this usage and exit",
].join("\n");

export function dispatch(
  args: string[],
  print: (msg: string) => void,
  cwd: string,
): number {
  const [sub, ...rest] = args;

  if (sub === undefined || sub === "--help" || sub === "-h") {
    print(USAGE);
    return 0;
  }

  switch (sub) {
    case "init":
      return nessyInit(print, cwd);
    case "remove":
      return nessyRemove(print, cwd, rest);
    default:
      print(`Unknown subcommand: ${sub}`);
      print("");
      print(USAGE);
      return 1;
  }
}
