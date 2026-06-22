import { defineCommand } from "citty";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const loadTemplate = () =>
  readFileSync(join(__dirname, "..", "..", "templates", "default-config.yml"), "utf8");

export function nessyInit(print: (m: string) => void, cwd: string): number {
  const nessy = join(cwd, ".nessy");
  if (existsSync(nessy)) {
    print(`.nessy/ already exists at ${cwd}; remove it first or edit the existing config.`);
    return 1;
  }
  mkdirSync(nessy);
  writeFileSync(join(nessy, "config.yml"), loadTemplate());
  print(`Initialized .nessy/ at ${cwd}. Edit .nessy/config.yml to define rules.`);
  return 0;
}

export const initCommand = defineCommand({
  meta: { name: "init", description: "Initialize .nessy/ in the current working directory" },
  run() {
    const code = nessyInit((m) => process.stderr.write(m + "\n"), process.cwd());
    process.exit(code);
  },
});
