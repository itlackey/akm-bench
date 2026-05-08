/**
 * Shared fixture-stash loader for tests/*.test.ts and src tasks.
 *
 * Each fixture lives at `fixtures/stashes/<name>/` with a `MANIFEST.json`
 * and the standard akm stash layout. `loadFixtureStash(name)` copies the
 * fixture into a fresh tmp dir, sets `AKM_STASH_DIR`, runs `akm index`, and
 * returns the materialised path plus a cleanup function.
 *
 * See README.md and docs/operator-guide.md for the contract.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAkmCommand } from "./akm-command";
import { resolveFixtureIndexCacheEntry } from "./fixture-index-cache";
import { getStashesRoot } from "./fixtures-root";
import { benchMkdtemp } from "./tmp";

const INDEX_DIR_NAME = "__akm_index__";

export interface LoadedFixtureStash {
  /** Absolute path to the materialised stash directory. */
  stashDir: string;
  /** Restore the prior `AKM_STASH_DIR` env value and remove the tmp dir. */
  cleanup: () => void;
  /** Deterministic SHA-256 of the fixture's source content (not the tmp copy). */
  contentHash: string;
  /**
   * Absolute path to the XDG_CACHE_HOME directory that contains the pre-built
   * FTS5 index (`<cacheHome>/akm/index.db`). Undefined when `skipIndex: true`.
   * Callers can copy this into their own isolated cache dirs to avoid re-indexing.
   */
  indexCacheHome?: string;
}

/**
 * List the fixture names available under `fixtures/stashes/`.
 *
 * A directory is considered a fixture iff it contains a `MANIFEST.json`.
 * Returned names are sorted alphabetically.
 */
export function listFixtures(): string[] {
  const fixturesRoot = getStashesRoot();
  if (!fs.existsSync(fixturesRoot)) return [];
  const entries = fs.readdirSync(fixturesRoot, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(fixturesRoot, entry.name, "MANIFEST.json");
    if (fs.existsSync(manifest)) names.push(entry.name);
  }
  names.sort();
  return names;
}

/**
 * Synchronous, deterministic SHA-256 hex of every file under the named
 * fixture. Hash input is `<relative-path>\0<file-bytes>\0` for each file in
 * sorted-relative-path order. Used by `bench compare` to refuse cross-fixture
 * diffs.
 *
 * Also exported as `computeFixtureContentHash` for callers that prefer the
 * `compute*` naming convention used by sibling helpers in `src/`
 * (see `computeTaskCorpusHash` in corpus.ts). The two names point at the
 * SAME implementation — there is exactly one fixture-content hash function
 * in this codebase, and `LoadedFixtureStash.contentHash` reuses it.
 */
export function fixtureContentHash(name: string): string {
  const root = fixtureSourceDir(name);
  const files = collectFilesSorted(root);
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Alias for `fixtureContentHash` matching the `compute*` naming used by
 * sibling helpers in `src/`. Reuses the SAME implementation —
 * defining a separate hash function for the same content would risk drift
 * between the report-stamping path and `LoadedFixtureStash.contentHash`.
 */
export const computeFixtureContentHash = fixtureContentHash;

/**
 * Options for `loadFixtureStash`.
 */
export interface LoadFixtureStashOptions {
  /**
   * If true, skip the `akm index` invocation. The fixture is still copied to
   * a tmp dir and `AKM_STASH_DIR` is still set, but no SQLite DB is created
   * in the isolated XDG cache. Useful for callers that build their own index
   * directly via the internal indexer DB API and would otherwise pay ~200-
   * 300ms for a wasted spawn. Defaults to false.
   */
  skipIndex?: boolean;
  /**
   * If true, ignore any pre-built index at `__akm_index__/` and run `akm
   * index` fresh. Useful after fixture content changes. Defaults to false.
   */
  forceReindex?: boolean;
}

/**
 * Copy the named fixture into a fresh tmp dir, set `AKM_STASH_DIR`, and run
 * `akm index` against it. Returns the tmp path plus a cleanup function that
 * restores the prior env value and recursively removes the tmp dir.
 *
 * When a pre-built index exists in the bench cache, it is copied into the tmp
 * cache dir instead of spawning `akm index`, saving ~0.6-1s per load.
 *
 * Transition behavior: as a fallback, this loader still accepts legacy
 * fixture-local caches under `fixtures/stashes/<name>/__akm_index__/`.
 *
 * Pass `{ skipIndex: true }` to disable indexing entirely, or
 * `{ forceReindex: true }` to ignore pre-built caches and run `akm index`
 * fresh.
 */
export function loadFixtureStash(name: string, options: LoadFixtureStashOptions = {}): LoadedFixtureStash {
  const sourceDir = fixtureSourceDir(name);
  const contentHash = fixtureContentHash(name);

  const tmpRoot = benchMkdtemp(`akm-fixture-${name}-`);
  const stashDir = path.join(tmpRoot, "stash");
  const cacheHome = path.join(tmpRoot, "cache");
  const configHome = path.join(tmpRoot, "config");
  copyDirRecursive(sourceDir, stashDir);
  fs.mkdirSync(cacheHome, { recursive: true });
  fs.mkdirSync(configHome, { recursive: true });

  const priorAkmStashDir = process.env.AKM_STASH_DIR;
  process.env.AKM_STASH_DIR = stashDir;

  if (!options.skipIndex) {
    const preBuiltIndex = preBuiltIndexPath(name, contentHash);
    if (preBuiltIndex && !options.forceReindex) {
      // Copy pre-built index (fast: ~5ms for SQLite files)
      copyDirRecursive(preBuiltIndex.cacheHome, cacheHome);
      copyDirRecursive(preBuiltIndex.configHome, configHome);
    } else {
      // Run akm index (slow: ~600-900ms per fixture)
      const result = Bun.spawnSync({
        cmd: [...resolveAkmCommand(), "index"],
        cwd: stashDir,
        env: {
          ...process.env,
          AKM_STASH_DIR: stashDir,
          XDG_CACHE_HOME: cacheHome,
          XDG_CONFIG_HOME: configHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode !== 0) {
        // Restore env and clean up before throwing so the caller is not left
        // with a leaked tmp dir or mutated process state.
        if (priorAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
        else process.env.AKM_STASH_DIR = priorAkmStashDir;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
        throw new Error(`akm index failed for fixture "${name}" (exit ${result.exitCode}): ${stderr}`);
      }
    }
  }

  const cleanup = (): void => {
    if (priorAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
    else process.env.AKM_STASH_DIR = priorAkmStashDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  };

  return { stashDir, cleanup, contentHash, ...(!options.skipIndex ? { indexCacheHome: cacheHome } : {}) };
}

// ── Internals ───────────────────────────────────────────────────────────────

function fixtureSourceDir(name: string): string {
  if (!isSafeName(name)) {
    throw new Error(`invalid fixture name: ${JSON.stringify(name)}`);
  }
  const dir = path.join(getStashesRoot(), name);
  if (!fs.existsSync(path.join(dir, "MANIFEST.json"))) {
    throw new Error(`fixture not found: ${name} (expected ${dir}/MANIFEST.json)`);
  }
  return dir;
}

/**
 * Resolve a pre-built index location for this fixture content:
 *   1. Preferred: bench cache preflight entry keyed by fixture/runtime fingerprint
 *   2. Fallback: legacy fixture-local `__akm_index__/`
 */
function preBuiltIndexPath(name: string, contentHash: string): { cacheHome: string; configHome: string } | undefined {
  const cacheEntry = resolveFixtureIndexCacheEntry(name, contentHash);
  if (cacheEntry) {
    return { cacheHome: cacheEntry.cacheHome, configHome: cacheEntry.configHome };
  }

  const indexDir = path.join(getStashesRoot(), name, INDEX_DIR_NAME);
  const cacheHome = path.join(indexDir, "cache");
  const configHome = path.join(indexDir, "config");
  const indexDb = path.join(cacheHome, "akm", "index.db");
  if (fs.existsSync(indexDb)) {
    return { cacheHome, configHome };
  }
  return undefined;
}

function isSafeName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

function collectFilesSorted(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(path.relative(root, abs));
    }
  };
  walk(root);
  out.sort();
  return out;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}
