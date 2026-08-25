/**
 * Unit tests for `analysis/src/cli.ts`.
 *
 * `run()` is exercised in-process (importing `parseArgs`/`run` directly)
 * rather than spawning `bin/akm-bench-analyze` as a subprocess, so these
 * tests stay fast and don't depend on `bun` being resolvable via `$PATH` in
 * every CI shell. `bin/akm-bench-analyze` itself is a one-line exec wrapper
 * around `analysis/src/cli.ts` (see that file) with no logic of its own to
 * unit-test independently.
 */

import { describe, expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CliUsageError, parseArgs, run } from "../src/cli";
import { buildSyntheticJobTree, CONTROL_ARM, cleanupSyntheticJobTree, TREATMENT_ARM } from "./fixtures";

describe("parseArgs", () => {
  test("parses the jobs dir alone", () => {
    expect(parseArgs(["/jobs"])).toEqual({ jobsDir: "/jobs", corpusDir: null, jsonOut: null, mdOut: null });
  });

  test("parses --corpus, --json and --md together", () => {
    expect(parseArgs(["/jobs", "--corpus", "/tasks", "--json", "out.json", "--md", "out.md"])).toEqual({
      jobsDir: "/jobs",
      corpusDir: "/tasks",
      jsonOut: "out.json",
      mdOut: "out.md",
    });
  });

  test("order of flags does not matter", () => {
    expect(parseArgs(["--json", "out.json", "/jobs"])).toEqual({
      jobsDir: "/jobs",
      corpusDir: null,
      jsonOut: "out.json",
      mdOut: null,
    });
  });

  test("throws CliUsageError when the jobs dir is missing", () => {
    expect(() => parseArgs([])).toThrow(CliUsageError);
  });

  test("throws CliUsageError on an unknown flag", () => {
    expect(() => parseArgs(["/jobs", "--bogus"])).toThrow(CliUsageError);
  });

  test("throws CliUsageError on a flag missing its value", () => {
    expect(() => parseArgs(["/jobs", "--corpus"])).toThrow(CliUsageError);
  });

  test("throws CliUsageError on a second positional argument", () => {
    expect(() => parseArgs(["/jobs", "/extra"])).toThrow(CliUsageError);
  });

  test("-h / --help throws CliUsageError (not a crash) so run() reports it as a clean usage exit", () => {
    expect(() => parseArgs(["-h"])).toThrow(CliUsageError);
    expect(() => parseArgs(["--help"])).toThrow(CliUsageError);
  });
});

describe("run", () => {
  test("returns exit code 2 on a usage error, without throwing", () => {
    expect(run([])).toBe(2);
  });

  test("writes both --json and --md outputs and returns 0", () => {
    const tree = buildSyntheticJobTree();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-cli-test-"));
    try {
      const jsonOut = path.join(outDir, "nested", "report.json");
      const mdOut = path.join(outDir, "nested", "report.md");
      const code = run([tree.jobsDir, "--corpus", tree.tasksDir, "--json", jsonOut, "--md", mdOut]);
      expect(code).toBe(0);

      const json = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
      expect(json.provenance.nTrials).toBe(24);
      expect(json.provenance.corpusJoin).toEqual({ matched: 3, missing: ["task-d"] });

      const md = fs.readFileSync(mdOut, "utf8");
      expect(md).toContain("# akm-bench analysis report");
      expect(md).toContain(CONTROL_ARM);
      expect(md).toContain(TREATMENT_ARM);
    } finally {
      cleanupSyntheticJobTree(tree);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("with neither --json nor --md, prints markdown to stdout and returns 0", () => {
    const tree = buildSyntheticJobTree();
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    // biome-ignore lint/suspicious/noExplicitAny: matching Node's Writable#write overload set is not worth it for a test-only stub.
    (process.stdout.write as any) = (chunk: string) => {
      captured += chunk;
      return true;
    };
    try {
      const code = run([tree.jobsDir]);
      expect(code).toBe(0);
      expect(captured).toContain("# akm-bench analysis report");
    } finally {
      process.stdout.write = originalWrite;
      cleanupSyntheticJobTree(tree);
    }
  });

  test("an empty jobs dir still produces a well-formed (warned) report, but returns a NON-ZERO exit code", () => {
    // Regression: a valid-looking, well-formed report over zero trials used
    // to return 0, which is indistinguishable in CI from a real (empty)
    // result -- a wrong --jobs-dir, a directory one level off Harbor's
    // <jobsDir>/<job>/<trial>/result.json shape, or a job that never
    // actually ran would all go quietly green. The report is still written
    // (the data that WAS found, i.e. none, is real) but the exit code must
    // not claim success for it.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-cli-test-"));
    try {
      const jsonOut = path.join(outDir, "report.json");
      const code = run([path.join(outDir, "nonexistent-jobs"), "--json", jsonOut]);
      expect(code).toBe(1);
      const json = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
      expect(json.provenance.nTrials).toBe(0);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
