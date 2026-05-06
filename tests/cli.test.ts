/**
 * Minimal spawned CLI smoke coverage.
 *
 * These are the only intentionally expensive binary-entrypoint checks we keep.
 * CI enables them with `AKM_BENCH_RUN_CLI_TESTS=1` and intentionally removes
 * `opencode` from PATH so the smoke stays deterministic: it validates config
 * dispatch and report generation without requiring a live model.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const RUN_SPAWNED_CLI_TESTS = process.env.AKM_BENCH_RUN_CLI_TESTS === "1";
const maybeTest = RUN_SPAWNED_CLI_TESTS ? test : test.skip;

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function envWithoutOpencode(): NodeJS.ProcessEnv {
  const currentPath = process.env.PATH ?? "";
  const opencodePath = Bun.which("opencode");
  if (!opencodePath) return { ...process.env };

  const opencodeDir = path.dirname(opencodePath);
  const filteredPath = currentPath
    .split(path.delimiter)
    .filter((entry) => entry !== opencodeDir)
    .join(path.delimiter);

  return { ...process.env, PATH: filteredPath };
}

function run(args: string[], env: Record<string, string> = {}): SpawnResult {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-cli-smoke-"));
  const mergedEnv = { ...envWithoutOpencode(), BENCH_RESULTS_DIR: resultsDir, ...env };
  const result = Bun.spawnSync({
    cmd: ["bun", "run", CLI, ...args],
    cwd: REPO_ROOT,
    env: mergedEnv,
    stdin: null,
    stdout: "pipe",
    stderr: "pipe",
  });
  fs.rmSync(resultsDir, { recursive: true, force: true });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout ?? new Uint8Array()),
    stderr: new TextDecoder().decode(result.stderr ?? new Uint8Array()),
  };
}

describe("bench CLI smoke", () => {
  test("unknown subcommand exits 2 and prints help context", () => {
    const r = run(["bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown subcommand");
  });

  maybeTest(
    "utility --tasks train --seeds 1 --json produces a valid envelope",
    () => {
      const r = run(
        [
          "utility",
          "--tasks",
          "train",
          "--seeds",
          "1",
          "--budget-tokens",
          "1000",
          "--budget-wall-ms",
          "1000",
          "--json",
        ],
        { BENCH_OPENCODE_MODEL: "anthropic/claude-opus-4-7" },
      );
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.track).toBe("utility");
      expect(Array.isArray(parsed.tasks)).toBe(true);
      expect((parsed.aggregate as Record<string, unknown>).akm).toBeDefined();
      expect((parsed.aggregate as Record<string, unknown>).delta).toBeDefined();
    },
    60_000,
  );

  maybeTest(
    "config-file dispatch loads canonical reference-suite config and emits a smoke report",
    () => {
      const r = run(
        [
          "config/reference-suite-v1.json",
          "--tasks",
          "drillbit/backup-policy",
          "--seeds",
          "1",
          "--parallel",
          "1",
          "--json",
        ],
        {
          BENCH_OPENCODE_MODEL: "local/qwen/qwen3.5-9b",
        },
      );
      expect(r.exitCode).toBe(0);
      const envelope = JSON.parse(r.stdout) as Record<string, unknown>;
      const corpus = envelope.corpus as Record<string, unknown>;
      const tasks = envelope.tasks as Array<Record<string, unknown>>;
      expect(envelope.corpus).toBeDefined();
      expect(corpus.selectedTaskIds).toEqual(["drillbit/backup-policy"]);
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe("drillbit/backup-policy");
      expect((tasks[0]?.akm as Record<string, unknown>).harness_error_count).toBe(1);
      expect(r.stderr).toContain("config=reference-suite-v1");
    },
    60_000,
  );
});
