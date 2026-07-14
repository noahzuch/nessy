import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { findProjectRoot } from "../shared/paths.js";
import { parseConfig } from "../shared/config.js";
function resolvePath(obj, path) {
    const parts = path.split(".");
    let current = obj;
    for (const part of parts) {
        if (current === null || typeof current !== "object")
            return { found: false };
        const idx = Array.isArray(current) ? Number(part) : undefined;
        current = Array.isArray(current)
            ? current[idx]
            : current[part];
        if (current === undefined)
            return { found: false };
    }
    return { found: true, value: current };
}
export function nessyConfig(print, printErr, cwd, jsonPath) {
    const projectRoot = findProjectRoot(cwd);
    if (projectRoot === null) {
        printErr("No .nessy/config.yml found in this directory or any parent.");
        return 1;
    }
    let cfg;
    try {
        cfg = parseConfig(readFileSync(`${projectRoot}/.nessy/config.yml`, "utf8"));
    }
    catch (e) {
        printErr(`Config error: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
    const result = resolvePath(cfg, jsonPath);
    if (!result.found) {
        printErr(`Key not found: ${jsonPath}`);
        return 1;
    }
    const { value } = result;
    if (value !== null && typeof value === "object") {
        print(JSON.stringify(value));
    }
    else {
        print(String(value));
    }
    return 0;
}
export const configCommand = defineCommand({
    meta: { name: "config", description: "Get a config parameter by dot-notation path" },
    run(ctx) {
        const jsonPath = ctx.args._[0];
        if (!jsonPath) {
            process.stderr.write("Usage: nessy config <path>\n");
            process.exit(1);
        }
        const code = nessyConfig((m) => process.stdout.write(m + "\n"), (m) => process.stderr.write(m + "\n"), process.cwd(), jsonPath);
        process.exit(code);
    },
});
//# sourceMappingURL=config.js.map