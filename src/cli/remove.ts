import { defineCommand } from "citty";
import { existsSync, rmSync, readSync } from "node:fs";
import { join } from "node:path";

export function nessyRemove(
  print: (m: string) => void,
  cwd: string,
  opts: { yes?: boolean },
): number {
  const nessy = join(cwd, ".nessy");
  if (!existsSync(nessy)) {
    print(`Nothing to remove. (.nessy/ does not exist at ${cwd}.)`);
    return 0;
  }
  const isTTY = Boolean(process.stdin.isTTY);
  if (!opts.yes && !isTTY) {
    print(
      `Refusing to remove .nessy/ non-interactively. Pass --yes to confirm, or run in an interactive shell.`,
    );
    return 1;
  }
  if (!opts.yes && isTTY) {
    process.stderr.write(`Remove .nessy/ and all its contents? [y/N] `);
    const buf = Buffer.alloc(64);
    let n = 0;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch {
      print("Failed to read confirmation; aborting.");
      return 1;
    }
    const ans = buf.subarray(0, n).toString("utf8").trim().toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      print("Aborted.");
      return 1;
    }
  }
  rmSync(nessy, { recursive: true, force: true });
  print(`Removed .nessy/ at ${cwd}.`);
  return 0;
}

export const removeCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Remove the .nessy/ directory from the current working directory",
  },
  args: { yes: { type: "boolean", description: "Skip the interactive confirmation prompt" } },
  run({ args }) {
    const code = nessyRemove((m) => process.stderr.write(m + "\n"), process.cwd(), {
      yes: args.yes,
    });
    process.exit(code);
  },
});
