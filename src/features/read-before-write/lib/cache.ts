import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ReadEntry = { path: string; mtime_ms: number; size: number };
export type CacheFile = {
  version: 1;
  session_id: string;
  agent_id: string | null;
  agent_type?: string | null;
  reads: ReadEntry[];
};

export function cachePathFor(root: string, sid: string, aid: string | null): string {
  return join(root, ".nessy", "cache", sid, aid === null ? "__root__.json" : `${aid}.json`);
}
export function loadCache(p: string): CacheFile {
  if (!existsSync(p)) return emptyFor(p);
  try {
    const o = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(o?.reads) ? o : emptyFor(p);
  } catch {
    return emptyFor(p);
  }
}
function emptyFor(p: string): CacheFile {
  const parts = p.split("/");
  const fn = parts.at(-1) ?? "";
  const sid = parts.at(-2) ?? "";
  return {
    version: 1,
    session_id: sid,
    agent_id: fn === "__root__.json" ? null : fn.replace(/\.json$/, ""),
    reads: [],
  };
}
export function upsertRead(reads: ReadEntry[], next: ReadEntry): ReadEntry[] {
  return [...reads.filter((r) => r.path !== next.path), next];
}
export function saveCache(p: string, c: CacheFile): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  renameSync(tmp, p);
}
