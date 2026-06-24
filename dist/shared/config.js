import { z } from "zod";
import { parse } from "yaml";
const LevelSchema = z.enum(["debug", "info", "warn", "error"]);
const RuleSchema = z.object({
    name: z.string().min(1),
    match: z
        .union([z.string(), z.array(z.string())])
        .transform((v) => (typeof v === "string" ? [v] : v)),
    require: z.array(z.string()).min(1),
});
const ConfigSchema = z.object({
    version: z.literal(1),
    hints: z.boolean().default(true),
    log_level: LevelSchema.default("info"),
    rules: z.array(RuleSchema).superRefine((rules, ctx) => {
        const seen = new Set();
        for (let i = 0; i < rules.length; i++) {
            if (seen.has(rules[i].name)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [i, "name"],
                    message: `duplicate rule name: ${JSON.stringify(rules[i].name)}`,
                });
            }
            seen.add(rules[i].name);
        }
    }),
    brainstorming: z.object({
        outputFile: z.string(),
        designSpecTemplate: z.string().nullable().default(null),
        extraContext: z.string().nullable().default(null),
    }),
    writingPlans: z.object({
        outputFile: z.string(),
        extraContext: z.string().nullable().default(null),
    })
});
export class ConfigError extends Error {
    filePath;
    constructor(message, filePath) {
        super(filePath ? `${message} (in ${filePath})` : message);
        this.filePath = filePath;
        this.name = "ConfigError";
    }
}
export function parseConfig(yaml, filePath) {
    let raw;
    try {
        raw = parse(yaml);
    }
    catch (e) {
        throw new ConfigError(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`, filePath);
    }
    const r = ConfigSchema.safeParse(raw);
    if (!r.success) {
        throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "), filePath);
    }
    return r.data;
}
//# sourceMappingURL=config.js.map