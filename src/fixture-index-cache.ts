import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAkmCommand, resolveAkmRuntime } from "./akm-command";
import { getStashesRoot } from "./fixtures-root";
import { getCacheDir } from "./support/fs";
import { benchMkdtemp } from "./tmp";

// v2 moves AKM's durable index from the retired XDG cache layout to its
// current XDG data layout. The schema bump prevents a 0.7-era cache entry
// from ever being reused as if it were a current index.
const CACHE_SCHEMA_VERSION = 2;

export interface FixtureIndexRuntimeFingerprint {
  akmBinPath: string;
  akmVersion: string;
  bunVersion: string;
  platform: string;
  arch: string;
}

export interface FixtureIndexFingerprintInput {
  fixtureContentHash: string;
  runtime: FixtureIndexRuntimeFingerprint;
}

export interface FixtureIndexCacheEntry {
  fixtureName: string;
  fingerprint: string;
  entryDir: string;
  dataHome: string;
  indexDbPath: string;
}

export interface EnsureFixtureIndexCacheResult {
  ok: boolean;
  rebuilt: boolean;
  entry?: FixtureIndexCacheEntry;
  warning?: string;
}

let runtimeFingerprintMemo: FixtureIndexRuntimeFingerprint | undefined;

export function computeFixtureIndexFingerprint(input: FixtureIndexFingerprintInput): string {
  const h = createHash("sha256");
  h.update(`schema:${CACHE_SCHEMA_VERSION}`);
  h.update("\0");
  h.update(`fixture:${input.fixtureContentHash}`);
  h.update("\0");
  h.update(`akm_bin:${input.runtime.akmBinPath}`);
  h.update("\0");
  h.update(`akm_ver:${input.runtime.akmVersion}`);
  h.update("\0");
  h.update(`bun_ver:${input.runtime.bunVersion}`);
  h.update("\0");
  h.update(`platform:${input.runtime.platform}`);
  h.update("\0");
  h.update(`arch:${input.runtime.arch}`);
  h.update("\0");
  return h.digest("hex");
}

export function resolveFixtureIndexRuntimeFingerprint(): FixtureIndexRuntimeFingerprint {
  if (runtimeFingerprintMemo) return runtimeFingerprintMemo;
  const runtime = resolveAkmRuntime();
  const version = resolveAkmVersion();
  runtimeFingerprintMemo = {
    akmBinPath: runtime.binPath,
    akmVersion: version,
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
  };
  return runtimeFingerprintMemo;
}

export function resolveFixtureIndexCacheEntry(
  fixtureName: string,
  fixtureContentHash: string,
): FixtureIndexCacheEntry | undefined {
  const runtime = resolveFixtureIndexRuntimeFingerprint();
  const fingerprint = computeFixtureIndexFingerprint({ fixtureContentHash, runtime });
  const entry = makeCacheEntry(fixtureName, fingerprint);
  if (!hasValidIndexDb(entry)) return undefined;
  return entry;
}

export function ensureFixtureIndexCacheEntry(
  fixtureName: string,
  fixtureContentHash: string,
): EnsureFixtureIndexCacheResult {
  const runtime = resolveFixtureIndexRuntimeFingerprint();
  const fingerprint = computeFixtureIndexFingerprint({ fixtureContentHash, runtime });
  const entry = makeCacheEntry(fixtureName, fingerprint);
  if (hasValidIndexDb(entry)) return { ok: true, rebuilt: false, entry };

  if (fs.existsSync(entry.entryDir)) {
    fs.rmSync(entry.entryDir, { recursive: true, force: true });
  }

  const fixtureDir = path.join(getStashesRoot(), fixtureName);
  if (!fs.existsSync(path.join(fixtureDir, "MANIFEST.json"))) {
    return {
      ok: false,
      rebuilt: false,
      warning: `fixture preflight: fixture "${fixtureName}" missing MANIFEST.json; skipping index cache warmup`,
    };
  }

  const tmpEntry = benchMkdtemp(`akm-fixture-index-${fixtureName}-`);
  const tmpCacheHome = path.join(tmpEntry, "cache");
  const tmpConfigHome = path.join(tmpEntry, "config");
  const tmpDataHome = path.join(tmpEntry, "data");
  const tmpStateHome = path.join(tmpEntry, "state");
  fs.mkdirSync(tmpCacheHome, { recursive: true });
  fs.mkdirSync(tmpConfigHome, { recursive: true });
  fs.mkdirSync(tmpDataHome, { recursive: true });
  fs.mkdirSync(tmpStateHome, { recursive: true });

  const result = Bun.spawnSync({
    cmd: [...resolveAkmCommand(), "index"],
    cwd: fixtureDir,
    env: {
      ...process.env,
      AKM_BUNDLE_DIR: fixtureDir,
      AKM_STASH_DIR: fixtureDir,
      XDG_CACHE_HOME: tmpCacheHome,
      XDG_CONFIG_HOME: tmpConfigHome,
      XDG_DATA_HOME: tmpDataHome,
      XDG_STATE_HOME: tmpStateHome,
      AKM_CACHE_DIR: path.join(tmpCacheHome, "akm"),
      AKM_CONFIG_DIR: path.join(tmpConfigHome, "akm"),
      AKM_DATA_DIR: path.join(tmpDataHome, "akm"),
      AKM_STATE_DIR: path.join(tmpStateHome, "akm"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    fs.rmSync(tmpEntry, { recursive: true, force: true });
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr).trim() : "";
    return {
      ok: false,
      rebuilt: false,
      warning: `fixture preflight: akm index failed for fixture "${fixtureName}" (exit ${result.exitCode}); falling back to per-load indexing${stderr ? `: ${stderr}` : ""}`,
    };
  }

  const tmpIndexDb = path.join(tmpDataHome, "akm", "index.db");
  if (!fs.existsSync(tmpIndexDb)) {
    fs.rmSync(tmpEntry, { recursive: true, force: true });
    return {
      ok: false,
      rebuilt: false,
      warning: `fixture preflight: built cache for fixture "${fixtureName}" but index.db was missing; falling back to per-load indexing`,
    };
  }

  fs.writeFileSync(
    path.join(tmpEntry, "meta.json"),
    `${JSON.stringify(
      {
        schemaVersion: CACHE_SCHEMA_VERSION,
        fixtureName,
        fixtureContentHash,
        runtime,
        fingerprint,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // A cache entry is an immutable search-index snapshot, not durable AKM
  // history. Never publish state.db, proposal state, or event telemetry from
  // the warmup invocation for later benchmark runs to inherit.
  fs.rmSync(tmpCacheHome, { recursive: true, force: true });
  fs.rmSync(tmpConfigHome, { recursive: true, force: true });
  fs.rmSync(tmpStateHome, { recursive: true, force: true });
  const tmpAkmData = path.join(tmpDataHome, "akm");
  for (const name of fs.readdirSync(tmpAkmData)) {
    if (name !== "index.db" && !name.startsWith("index.db-")) {
      fs.rmSync(path.join(tmpAkmData, name), { recursive: true, force: true });
    }
  }

  fs.mkdirSync(path.dirname(entry.entryDir), { recursive: true });
  try {
    fs.renameSync(tmpEntry, entry.entryDir);
  } catch {
    if (!hasValidIndexDb(entry)) {
      fs.rmSync(tmpEntry, { recursive: true, force: true });
      return {
        ok: false,
        rebuilt: false,
        warning: `fixture preflight: failed to publish cache entry for fixture "${fixtureName}"; falling back to per-load indexing`,
      };
    }
    fs.rmSync(tmpEntry, { recursive: true, force: true });
  }

  return { ok: true, rebuilt: true, entry };
}

function resolveAkmVersion(): string {
  try {
    const proc = Bun.spawnSync({
      cmd: [...resolveAkmCommand(), "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      const out = new TextDecoder().decode(proc.stdout).trim();
      if (out.length > 0) return out;
    }
    return `exit:${proc.exitCode ?? -1}`;
  } catch {
    return "unknown";
  }
}

function makeCacheEntry(fixtureName: string, fingerprint: string): FixtureIndexCacheEntry {
  const root = path.join(getCacheDir(), "bench", "fixture-indexes", fixtureName, fingerprint);
  return {
    fixtureName,
    fingerprint,
    entryDir: root,
    dataHome: path.join(root, "data"),
    indexDbPath: path.join(root, "data", "akm", "index.db"),
  };
}

function hasValidIndexDb(entry: FixtureIndexCacheEntry): boolean {
  try {
    const stat = fs.statSync(entry.indexDbPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}
