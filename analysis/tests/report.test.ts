/**
 * Unit tests for `analysis/src/report.ts`.
 */

import { describe, expect, test } from "bun:test";

import fs from "node:fs";
import path from "node:path";

import { loadCorpusMetadata } from "../src/corpus";
import { loadJobs } from "../src/loader";
import { agentKwargsDigest, buildAnalysisReport, renderJson, renderMarkdown } from "../src/report";
import { buildSyntheticJobTree, CONTROL_ARM, cleanupSyntheticJobTree, HARBOR_VERSION, TREATMENT_ARM } from "./fixtures";

const TEST_BOOTSTRAP = { seed: 42, resamples: 200 };

describe("buildAnalysisReport", () => {
  test("without --corpus: corpusJoin is null and every per-task row has null metadata", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const report = buildAnalysisReport(records, { jobsDir: tree.jobsDir, bootstrap: TEST_BOOTSTRAP });

      expect(report.provenance.corpusDir).toBeNull();
      expect(report.provenance.corpusJoin).toBeNull();
      expect(report.disclosures.corpusMissingTasks).toBeNull();
      expect(report.perTaskBreakdown.every((row) => row.metadata === null)).toBe(true);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("with --corpus: joins 3 tasks and discloses task-d as missing, without crashing", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const report = buildAnalysisReport(records, {
        jobsDir: tree.jobsDir,
        corpusDir: tree.tasksDir,
        bootstrap: TEST_BOOTSTRAP,
      });

      expect(report.provenance.corpusJoin).toEqual({ matched: 3, missing: ["task-d"] });
      expect(report.disclosures.corpusMissingTasks).toEqual(["task-d"]);

      const taskA = report.perTaskBreakdown.find((row) => row.taskName === "task-a");
      expect(taskA?.metadata?.domain).toBe("docker-homelab");
      const taskD = report.perTaskBreakdown.find((row) => row.taskName === "task-d");
      expect(taskD?.metadata).toBeNull();
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("provenance reads harbor.version from each job's lock.json", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const report = buildAnalysisReport(records, { jobsDir: tree.jobsDir, bootstrap: TEST_BOOTSTRAP });
      expect(report.provenance.harborVersions).toEqual([HARBOR_VERSION]);
      expect(report.provenance.jobIds).toEqual([tree.controlJobId, tree.treatmentJobId].sort());
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("harborVersions is empty (never invented) when no lock.json is present", () => {
    const tree = buildSyntheticJobTree();
    try {
      fs.rmSync(path.join(tree.jobsDir, tree.controlJobId, "lock.json"));
      fs.rmSync(path.join(tree.jobsDir, tree.treatmentJobId, "lock.json"));
      const records = loadJobs(tree.jobsDir);
      const report = buildAnalysisReport(records, { jobsDir: tree.jobsDir, bootstrap: TEST_BOOTSTRAP });
      expect(report.provenance.harborVersions).toEqual([]);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("disclosures report the one errored trial and the one non-errored-missing-reward count (zero, in this fixture)", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const report = buildAnalysisReport(records, { jobsDir: tree.jobsDir, bootstrap: TEST_BOOTSTRAP });
      expect(report.disclosures.totalErrored).toBe(1);
      expect(report.disclosures.erroredByArm[CONTROL_ARM]).toBe(1);
      expect(report.disclosures.erroredByArm[TREATMENT_ARM]).toBeUndefined();
      expect(report.disclosures.exceptionTypeCounts.AkmPluginNotLoadedError).toBe(1);
      expect(report.disclosures.totalMissingReward).toBe(0);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("discloses non-canonical reward keys (otherRewards) by name and count, never silently dropping them", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const report = buildAnalysisReport(records, { jobsDir: tree.jobsDir, bootstrap: TEST_BOOTSTRAP });
      // Fixture: control/task-c/attempt-2 carries an extra `workflow_compliance` reward key.
      expect(report.disclosures.otherRewardKeyCounts.workflow_compliance).toBe(1);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("discloses non-errored trials whose canonical reward is present but not exactly 0 or 1", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      // No fixture trial is naturally non-binary; every reward is 0 or 1.
      const baseline = buildAnalysisReport(records, { jobsDir: tree.jobsDir, bootstrap: TEST_BOOTSTRAP });
      expect(baseline.disclosures.nonBinaryRewardCount).toBe(0);

      const nonBinary = records.map((r) => ({ ...r }));
      const target = nonBinary.find((r) => r.arm === CONTROL_ARM && r.reward === 1);
      if (target) target.reward = 0.6;
      const report = buildAnalysisReport(nonBinary, { jobsDir: tree.jobsDir, bootstrap: TEST_BOOTSTRAP });
      expect(report.disclosures.nonBinaryRewardCount).toBe(1);
      expect(report.disclosures.nonBinaryRewardByArm[CONTROL_ARM]).toBe(1);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("flags a task_checksum mismatch when the same task_name carries two different checksums", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      records[0].provenance.taskChecksum = "sha256:drifted";
      const report = buildAnalysisReport(records, { jobsDir: tree.jobsDir, bootstrap: TEST_BOOTSTRAP });
      const taskName = records[0].taskName;
      expect(report.provenance.taskChecksumMismatches[taskName]).toBeDefined();
      expect(report.provenance.taskChecksumMismatches[taskName]?.length).toBeGreaterThan(1);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("flags an agent-kwargs digest mismatch when the same arm carries two different configs", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const treatmentRecord = records.find((r) => r.arm === TREATMENT_ARM);
      if (treatmentRecord)
        treatmentRecord.provenance.agentKwargs = { ...treatmentRecord.provenance.agentKwargs, drift: true };
      const report = buildAnalysisReport(records, { jobsDir: tree.jobsDir, bootstrap: TEST_BOOTSTRAP });
      expect(report.provenance.agentKwargsDigestMismatches[TREATMENT_ARM]?.length).toBeGreaterThan(1);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("empty input still produces a well-formed, renderable report", () => {
    const report = buildAnalysisReport([], { jobsDir: "/nonexistent" });
    expect(report.provenance.nTrials).toBe(0);
    expect(() => renderMarkdown(report)).not.toThrow();
    expect(() => renderJson(report)).not.toThrow();
  });
});

describe("agentKwargsDigest", () => {
  test("is stable under key reordering", () => {
    const a = agentKwargsDigest({ x: 1, y: 2 });
    const b = agentKwargsDigest({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  test("differs when a value differs", () => {
    expect(agentKwargsDigest({ x: 1 })).not.toBe(agentKwargsDigest({ x: 2 }));
  });
});

describe("renderMarkdown", () => {
  test("produces a non-empty string containing the key section headings", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const corpusIndex = loadCorpusMetadata(tree.tasksDir);
      const report = buildAnalysisReport(records, {
        jobsDir: tree.jobsDir,
        corpusIndex,
        corpusDir: tree.tasksDir,
        bootstrap: TEST_BOOTSTRAP,
      });
      const md = renderMarkdown(report);

      expect(md).toContain("# akm-bench analysis report");
      expect(md).toContain("## Provenance");
      expect(md).toContain("## Errored / null disclosure");
      expect(md).toContain("## Per-arm summary");
      expect(md).toContain("## Per-arm tokens / cost");
      expect(md).toContain("## Arm vs. arm delta");
      expect(md).toContain("## Arm vs. arm delta (symmetric exclusion");
      expect(md).toContain("## Per-task breakdown");
      expect(md).toContain(CONTROL_ARM);
      expect(md).toContain(TREATMENT_ARM);
      expect(md).toContain("docker-homelab"); // corpus metadata grouping made it into the per-task table
      // pass@1's CI is now attached and distinguished from the attempt-level
      // "mean reward" dispersion column (S5 fix).
      expect(md).toContain("pass@1 (95% CI over per-task means, n=tasks)");
      expect(md).toContain("pseudo-replicated");
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("notes explicitly when no --corpus was given, rather than silently omitting grouping", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const report = buildAnalysisReport(records, { jobsDir: tree.jobsDir, bootstrap: TEST_BOOTSTRAP });
      const md = renderMarkdown(report);
      expect(md).toContain("No `--corpus` directory was given");
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });
});

describe("renderJson", () => {
  test("round-trips through JSON.parse without loss of the top-level shape", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const report = buildAnalysisReport(records, {
        jobsDir: tree.jobsDir,
        corpusDir: tree.tasksDir,
        bootstrap: TEST_BOOTSTRAP,
      });
      const parsed = JSON.parse(renderJson(report));
      expect(parsed.provenance.nTrials).toBe(24);
      expect(parsed.stats.arms).toHaveLength(2);
      expect(parsed.perTaskBreakdown).toHaveLength(4);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });
});
