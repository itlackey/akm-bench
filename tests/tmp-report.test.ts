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
});
