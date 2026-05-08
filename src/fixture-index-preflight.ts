import { fixtureContentHash } from "./fixture-stash";
import { ensureFixtureIndexCacheEntry } from "./fixture-index-cache";

export interface FixtureRefLike {
  stash: string;
}

export interface FixtureIndexPreflightResult {
  fixtureCount: number;
  reusedCount: number;
  rebuiltCount: number;
  warnings: string[];
}

export function ensureFixtureIndexesForTasks(tasks: ReadonlyArray<FixtureRefLike>): FixtureIndexPreflightResult {
  const names = [...new Set(tasks.map((t) => t.stash))].sort();
  let reusedCount = 0;
  let rebuiltCount = 0;
  const warnings: string[] = [];

  for (const name of names) {
    try {
      const content = fixtureContentHash(name);
      const ensured = ensureFixtureIndexCacheEntry(name, content);
      if (!ensured.ok) {
        if (ensured.warning) warnings.push(ensured.warning);
        continue;
      }
      if (ensured.rebuilt) rebuiltCount += 1;
      else reusedCount += 1;
    } catch (err) {
      warnings.push(
        `fixture preflight: failed to prepare index cache for fixture "${name}"; falling back to per-load indexing: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    fixtureCount: names.length,
    reusedCount,
    rebuiltCount,
    warnings,
  };
}
