import { statSync } from "node:fs";
export type StalenessResult = "fresh" | "stale" | "missing";
export function checkStaleness(
  p: string,
  cachedMtime: number,
  cachedSize: number,
): StalenessResult {
  try {
    const s = statSync(p);
    return s.mtimeMs === cachedMtime && s.size === cachedSize ? "fresh" : "stale";
  } catch {
    return "missing";
  }
}
