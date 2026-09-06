import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runWrapper(extraArgs: string[]): { status: number | null; calls: string[]; stderr: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-docker-wrapper-"));
  tempDirs.push(root);
  const binDir = path.join(root, "bin");
  const resultsDir = path.join(root, "results");
  const cacheDir = path.join(root, "cache");
  const logPath = path.join(root, "docker.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "docker"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nexit 0\n`,
    { mode: 0o755 },
  );

  const result = spawnSync(
    "bash",
    [
      "bin/akm-bench",
      "run",
      "config/nano-quick.json",
      "--results-dir",
      resultsDir,
      "--cache-dir",
      cacheDir,
      "--akm-mode",
      "version",
      "--akm-version",
      "0.9.14",
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    },
  );

  return {
    status: result.status,
    calls: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n") : [],
    stderr: result.stderr,
  };
}

describe("container wrapper image freshness", () => {
  test("refreshes the image before every default run", () => {
    const result = runWrapper([]);
    expect(result.status).toBe(0);
    const builds = result.calls.filter((call) => call.startsWith("build "));
    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain("--build-arg BENCH_REPO_COMMIT=");
    expect(builds[0]).toContain("--build-arg BENCH_REPO_DIRTY=");
    expect(builds[0]).toContain(repoRoot);
    expect(result.calls.filter((call) => call.startsWith("run "))).toHaveLength(1);
    expect(result.calls.find((call) => call.startsWith("run "))).toContain(
      "BENCH_CONTAINER_IMAGE=akm-bench:akm-0.9.14",
    );
    expect(result.calls.some((call) => call.startsWith("image inspect "))).toBe(false);
  });

  test("--no-build explicitly verifies and reuses an existing image", () => {
    const result = runWrapper(["--no-build"]);
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("image inspect "))).toHaveLength(1);
    expect(result.calls.some((call) => call.startsWith("build "))).toBe(false);
    expect(result.calls.filter((call) => call.startsWith("run "))).toHaveLength(1);
  });
});
