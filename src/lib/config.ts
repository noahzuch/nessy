import { z } from "zod";
import { parse } from "yaml";

const LevelSchema = z.enum(["debug", "info", "warn", "error"]);
const RuleSchema = z.object({
  name: z.string().min(1),
  match: z.union([z.string(), z.array(z.string())]).transform(v => typeof v === "string" ? [v] : v),
  require: z.array(z.string()).min(1),
});
const ConfigSchema = z.object({
  version: z.literal(1),
  hints: z.boolean().default(true),
  log_level: LevelSchema.default("info"),
  rules: z.array(RuleSchema).superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < rules.length; i++) {
      if (seen.has(rules[i].name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "name"], message: `duplicate rule name: ${JSON.stringify(rules[i].name)}` });
      }
      seen.add(rules[i].name);
    }
  }),
});
export type Level = z.infer<typeof LevelSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string, public filePath?: string) {
    super(filePath ? `${message} (in ${filePath})` : message);
    this.name = "ConfigError";
  }
}

export function parseConfig(yaml: string, filePath?: string): Config {
  let raw: unknown;
  try { raw = parse(yaml); } catch (e) {
    throw new ConfigError(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`, filePath);
  }
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map(i => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "), filePath);
  }
  return r.data;
}
