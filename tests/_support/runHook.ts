import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type HookResult = { exitCode: number; stdout: string; stderr: string; stdoutJson: unknown };

export function runHook(
  scriptName: string,
  payload: unknown,
  opts: { cwd?: string } = {},
): HookResult {
  const repo = join(__dirname, "..", "..");
  const scriptPath = join(repo, "dist", "hooks", `${scriptName}.js`);
  const res = spawnSync("node", [scriptPath], {
    input: JSON.stringify(payload),
    cwd: opts.cwd,
    encoding: "utf8",
  });
  let stdoutJson: unknown = null;
  if (res.stdout.trim().length > 0) {
    try {
      stdoutJson = JSON.parse(res.stdout);
    } catch {}
  }
  return { exitCode: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, stdoutJson };
}
