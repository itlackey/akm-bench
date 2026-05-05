import { describe, expect, test } from "bun:test";
import path from "node:path";

import { benchReportPath, benchReportRoot, writeBenchReportJson } from "../src/tmp";

describe("bench report output", () => {
  const report = {
    track: "utility",
    timestamp: "2026-05-04T22:30:00.000Z",
    branch: "main",
    commit: "abc1234",
    agent: { model: "local/test-model" },
  };

  test("uses the repo results directory by default", () => {
    expect(benchReportRoot()).toBe(path.resolve(import.meta.dir, "..", "results"));
    expect(benchReportPath(report)).toContain(`${path.sep}results${path.sep}`);
  });

  test("writes report json into results", () => {
    const outPath = writeBenchReportJson(report);
    expect(outPath).toContain(`${path.sep}results${path.sep}`);
  });

  test("uses BENCH_RESULTS_DIR when set", () => {
    const prior = process.env.BENCH_RESULTS_DIR;
    const customDir = path.resolve(import.meta.dir, "tmp-report-output");
    process.env.BENCH_RESULTS_DIR = customDir;
    try {
      expect(benchReportRoot()).toBe(customDir);
      expect(benchReportPath(report)).toContain(`${path.sep}tmp-report-output${path.sep}`);
      const outPath = writeBenchReportJson(report);
      expect(outPath).toContain(`${path.sep}tmp-report-output${path.sep}`);
    } finally {
      if (prior === undefined) delete process.env.BENCH_RESULTS_DIR;
      else process.env.BENCH_RESULTS_DIR = prior;
    }
  });
});
