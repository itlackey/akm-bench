import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAkmCommand, resolveAkmRuntime } from "./akm-command";
import { getStashesRoot } from "./fixtures-root";
import { getCacheDir } from "./support/fs";
import { benchMkdtemp } from "./tmp";

const CACHE_SCHEMA_VERSION = 1;

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
  cacheHome: string;
  configHome: string;
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
  fs.mkdirSync(tmpCacheHome, { recursive: true });
  fs.mkdirSync(tmpConfigHome, { recursive: true });

  const result = Bun.spawnSync({
    cmd: [...resolveAkmCommand(), "index"],
    cwd: fixtureDir,
    env: {
      ...process.env,
      AKM_STASH_DIR: fixtureDir,
      XDG_CACHE_HOME: tmpCacheHome,
      XDG_CONFIG_HOME: tmpConfigHome,
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

  const tmpIndexDb = path.join(tmpCacheHome, "akm", "index.db");
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
    cacheHome: path.join(root, "cache"),
    configHome: path.join(root, "config"),
    indexDbPath: path.join(root, "cache", "akm", "index.db"),
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
