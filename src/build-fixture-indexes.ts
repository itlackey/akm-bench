/**
 * Warm fixture index cache entries for fixture stashes.
 *
 * Runs `akm index` once per fixture/runtime fingerprint and stores the cache
 * entry under `${AKM_CACHE_DIR}/bench/fixture-indexes/<fixture>/<fingerprint>/`.
 * Subsequent `loadFixtureStash` calls copy from this cache instead of
 * spawning `akm index`, saving ~0.6-1s per fixture load.
 *
 * Usage:
 *   bun run src/build-fixture-indexes.ts          # warm all fixtures
 *   bun run src/build-fixture-indexes.ts az-cli   # warm one fixture
 */

import fs from "node:fs";
import path from "node:path";
import {
  ensureFixtureIndexCacheEntry,
  resolveFixtureIndexCacheEntry,
  resolveFixtureIndexRuntimeFingerprint,
} from "./fixture-index-cache";
import { fixtureContentHash } from "./fixture-stash";
import { getStashesRoot } from "./fixtures-root";

function listFixtures(): string[] {
  const root = getStashesRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "MANIFEST.json")))
    .map((e) => e.name)
    .sort();
}

function buildIndex(fixtureName: string): void {
  const contentHash = fixtureContentHash(fixtureName);
  const result = ensureFixtureIndexCacheEntry(fixtureName, contentHash);
  if (!result.ok || !result.entry) {
    console.error(`[${fixtureName}] FAILED: ${result.warning ?? "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  const label = result.rebuilt ? "built" : "reused";
  console.log(`[${fixtureName}] ${label} -> ${result.entry.entryDir}`);
}

const fixtures = process.argv.slice(2).length > 0 ? process.argv.slice(2) : listFixtures();
const runtime = resolveFixtureIndexRuntimeFingerprint();
console.log(`Warming indexes for ${fixtures.length} fixture(s): ${fixtures.join(", ")}`);
console.log(
  `runtime: akm=${runtime.akmVersion} bun=${runtime.bunVersion} platform=${runtime.platform}/${runtime.arch}\n`,
);

for (const f of fixtures) {
  buildIndex(f);
}

for (const f of fixtures) {
  const entry = resolveFixtureIndexCacheEntry(f, fixtureContentHash(f));
  if (!entry) {
    process.exitCode = 1;
    continue;
  }
}

console.log("\nDone. Run `bun test` to verify.");
