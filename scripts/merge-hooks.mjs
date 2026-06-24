// Source of truth: src/features/*/hooks.fragment.json — do not edit hooks/hooks.json directly.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const featuresDir = join(root, "src", "features");

const features = readdirSync(featuresDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const merged = { hooks: {} };

for (const feature of features) {
  const fragmentPath = join(featuresDir, feature, "hooks.fragment.json");
  let fragment;
  try {
    fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
  } catch {
    continue;
  }
  if (!fragment.hooks) continue;
  for (const [event, entries] of Object.entries(fragment.hooks)) {
    if (!merged.hooks[event]) merged.hooks[event] = [];
    merged.hooks[event].push(...entries);
  }
}

const outPath = join(root, "hooks", "hooks.json");
writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n");
console.log(
  `hooks/hooks.json written (${features.length} features, ${Object.keys(merged.hooks).length} event types)`,
);
