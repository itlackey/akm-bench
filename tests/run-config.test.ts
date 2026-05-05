/**
 * Unit tests for the run-config loader.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverOpencodeConfig } from "../src/cli";
import { BenchConfigError } from "../src/opencode-config";
import { loadBaseline, loadBenchRunConfig, resolvePathString } from "../src/run-config";
import { benchMkdtemp } from "../src/tmp";

const REPO_ROOT = path.resolve(__dirname, "..");

let workDir: string;
let savedEnv: { BENCH_OPENCODE_CONFIG?: string; BENCH_OPENCODE_MODEL?: string; AKM_TEST_VAR?: string };

beforeEach(() => {
  workDir = benchMkdtemp("akm-bench-runconfig-test-");
  savedEnv = {
    BENCH_OPENCODE_CONFIG: process.env.BENCH_OPENCODE_CONFIG,
    BENCH_OPENCODE_MODEL: process.env.BENCH_OPENCODE_MODEL,
    AKM_TEST_VAR: process.env.AKM_TEST_VAR,
  };
  delete process.env.BENCH_OPENCODE_CONFIG;
  delete process.env.BENCH_OPENCODE_MODEL;
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function writeOpencodeConfigFile(filePath: string, model = "p/m"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model,
      provider: { p: { npm: "@ai-sdk/openai-compatible" } },
    }),
  );
}

describe("resolvePathString", () => {
  test("resolves a relative path against the supplied base dir", () => {
    expect(resolvePathString("foo.json", "/work")).toBe("/work/foo.json");
  });

  test("returns absolute paths unchanged", () => {
    expect(resolvePathString("/abs/path.json", "/work")).toBe("/abs/path.json");
  });

  test("expands ~ to the operator home dir", () => {
    expect(resolvePathString("~/.config/akm/foo.json", "/work")).toBe(path.join(os.homedir(), ".config/akm/foo.json"));
  });

  test("expands env-var references", () => {
    process.env.AKM_TEST_VAR = "/somewhere";
    const input = `${"$"}{AKM_TEST_VAR}/opencode.json`;
    expect(resolvePathString(input, "/work")).toBe("/somewhere/opencode.json");
  });
});

describe("loadBaseline", () => {
  test("loads a taskId to passRate map", () => {
    const filePath = path.join(workDir, "baseline.json");
    fs.writeFileSync(filePath, JSON.stringify({ "domain/a": 0.8, "domain/b": 1.0 }));
    expect(loadBaseline(filePath)).toEqual({ "domain/a": 0.8, "domain/b": 1.0 });
  });
});

describe("loadBenchRunConfig", () => {
  test("rejects unknown top-level fields", () => {
    const cfgPath = path.join(workDir, "bad.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, weirdField: 42 }));
    expect(() => loadBenchRunConfig(cfgPath)).toThrow(/unknown field/);
  });

  test("rejects opencodeConfig and opencodeConfigRef both set", () => {
    const cfgPath = path.join(workDir, "both.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        opencodeConfig: { provider: { p: { npm: "x" } } },
        opencodeConfigRef: "./other.json",
      }),
    );
    expect(() => loadBenchRunConfig(cfgPath)).toThrow(/only one of "opencodeConfig" or "opencodeConfigRef"/);
  });

  test("BENCH_OPENCODE_CONFIG env var wins over opencodeConfigRef", () => {
    const envConfig = path.join(workDir, "env-opencode.json");
    const refConfig = path.join(workDir, "ref-opencode.json");
    writeOpencodeConfigFile(envConfig, "env/model");
    writeOpencodeConfigFile(refConfig, "ref/model");
    process.env.BENCH_OPENCODE_CONFIG = envConfig;

    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        opencodeConfigRef: "./ref-opencode.json",
        tasks: ["drillbit/backup-policy"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.opencodeConfig.source).toBe(envConfig);
    expect(resolved.model).toBe("env/model");
  });

  test("opencodeConfigRef is resolved relative to the config file", () => {
    const refConfig = path.join(workDir, "subdir", "opencode.json");
    writeOpencodeConfigFile(refConfig, "ref/model");
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        opencodeConfigRef: "./subdir/opencode.json",
        tasks: ["drillbit/backup-policy"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.opencodeConfig.source).toBe(refConfig);
    expect(resolved.model).toBe("ref/model");
  });

  test("config model overrides the opencode config model", () => {
    const refConfig = path.join(workDir, "opencode.json");
    writeOpencodeConfigFile(refConfig, "ref/model");
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        opencodeConfigRef: "./opencode.json",
        model: "config/model",
        tasks: ["drillbit/backup-policy"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.model).toBe("config/model");
  });

  test("BENCH_OPENCODE_MODEL env wins over both", () => {
    const refConfig = path.join(workDir, "opencode.json");
    writeOpencodeConfigFile(refConfig, "ref/model");
    process.env.BENCH_OPENCODE_MODEL = "env/model";
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        opencodeConfigRef: "./opencode.json",
        model: "config/model",
        tasks: ["drillbit/backup-policy"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.model).toBe("env/model");
  });

  test("discoverOpencodeConfig auto-discovers the committed fixture", () => {
    const loaded = discoverOpencodeConfig();
    expect(loaded).toBeDefined();
    expect(loaded?.source.startsWith(path.join(REPO_ROOT, "config") + path.sep)).toBe(true);
  });

  test("tasks array selects exactly the listed ids", () => {
    const refConfig = path.join(workDir, "opencode.json");
    writeOpencodeConfigFile(refConfig);
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        opencodeConfigRef: "./opencode.json",
        tasks: ["drillbit/backup-policy", "drillbit/canary-enable"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.tasks.map((t) => t.id).sort()).toEqual(["drillbit/backup-policy", "drillbit/canary-enable"]);
  });

  test("baseline path is resolved relative to the config file", () => {
    const refConfig = path.join(workDir, "opencode.json");
    writeOpencodeConfigFile(refConfig);
    const baselinePath = path.join(workDir, "baseline.json");
    fs.writeFileSync(baselinePath, JSON.stringify({ "drillbit/backup-policy": 0.8 }));
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        opencodeConfigRef: "./opencode.json",
        tasks: ["drillbit/backup-policy"],
        baseline: "./baseline.json",
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.baselineByTaskId).toEqual({ "drillbit/backup-policy": 0.8 });
  });

  test("committed configs load cleanly", () => {
    const nano = loadBenchRunConfig(path.join(REPO_ROOT, "config", "nano-quick.json"));
    const full = loadBenchRunConfig(path.join(REPO_ROOT, "config", "full.json"));
    const curate = loadBenchRunConfig(path.join(REPO_ROOT, "config", "curate-test.json"));
    expect(nano.name).toBe("nano-quick");
    expect(full.name).toBe("full");
    expect(curate.tasks.map((t) => t.id)).toEqual(["inkwell/configure-scaling"]);
  });

  test("explicit missing flag path throws usage error", () => {
    expect(() => discoverOpencodeConfig("/nonexistent/opencode.json")).toThrow(BenchConfigError);
  });
});
