/**
 * Unit tests for `analysis/src/stats.ts`.
 *
 * The synthetic fixture's per-task reward means (and therefore pass@1,
 * mean-reward and delta point estimates) were hand-verified against
 * `fixtures.ts`'s `REWARDS_BY_ARM` table + its errored/multi-key overrides
 * before being hardcoded below. The bootstrap CI bounds are GOLDEN VALUES —
 * captured once from a real run at a fixed `{ seed, resamples }` and pasted
 * here — per the brief's "golden-test the stats (seeded, so exact numbers)"
 * instruction; they are not independently re-derived by hand (a percentile
 * over an RNG sequence is not something to hand-verify), but the seed makes
 * them exactly reproducible and any code change that alters the resampling
 * logic will change them, so the test is a real regression guard.
 */

import { describe, expect, test } from "bun:test";

import { loadJobs } from "../src/loader";
import {
  bootstrapMeanCI,
  bucketByTaskArm,
  computeAnalysisStats,
  computeArmRewardStats,
  computeArmTokenStats,
  computePairedDelta,
  computePassAt1,
  computeSymmetricPairedDelta,
  DEFAULT_BOOTSTRAP_RESAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  ERRORED_POLICIES,
  summarizeTaskArmRewards,
  type TaskArmRewardSummary,
} from "../src/stats";
import { buildSyntheticJobTree, CONTROL_ARM, cleanupSyntheticJobTree, TREATMENT_ARM } from "./fixtures";

// A fixed, fast-but-still-seeded bootstrap config used throughout this file.
// Production/CLI use stays on the module defaults (1337 / 10_000) — see the
// dedicated "module defaults" test below.
const TEST_BOOTSTRAP = { seed: 42, resamples: 500 };

describe("bootstrapMeanCI", () => {
  test("returns null on empty input", () => {
    expect(bootstrapMeanCI([])).toBeNull();
  });

  test("degenerates to a point interval for a single value, regardless of seed", () => {
    const ci = bootstrapMeanCI([0.5], { seed: 1, resamples: 50 });
    expect(ci).toEqual({ mean: 0.5, ciLow: 0.5, ciHigh: 0.5, n: 1, resamples: 50, seed: 1, alpha: 0.05 });
  });

  test("degenerates to a point interval for a constant array", () => {
    const ci = bootstrapMeanCI([1, 1, 1], { seed: 7, resamples: 50 });
    expect(ci).toEqual({ mean: 1, ciLow: 1, ciHigh: 1, n: 3, resamples: 50, seed: 7, alpha: 0.05 });
  });

  test("uses the documented module defaults (seed 1337, 10_000 resamples) when options are omitted", () => {
    expect(DEFAULT_BOOTSTRAP_SEED).toBe(1337);
    expect(DEFAULT_BOOTSTRAP_RESAMPLES).toBe(10_000);
    const ci = bootstrapMeanCI([1, 0]);
    expect(ci?.seed).toBe(1337);
    expect(ci?.resamples).toBe(10_000);
    expect(ci?.mean).toBe(0.5);
    // A two-point {0, 1} bootstrap always ranges over exactly {0, 0.5, 1} —
    // seed-independent — so the CI bounds are a safe non-golden assertion.
    expect(ci?.ciLow).toBe(0);
    expect(ci?.ciHigh).toBe(1);
  });

  test("is deterministic: the same seed + resamples always produces the same CI", () => {
    const a = bootstrapMeanCI([1, 0, 1, 0, 1], { seed: 99, resamples: 300 });
    const b = bootstrapMeanCI([1, 0, 1, 0, 1], { seed: 99, resamples: 300 });
    expect(a).toEqual(b);
  });

  test("golden: seed 42 / 500 resamples over the synthetic control arm's errored-as-zero reward values", () => {
    // Control arm errored-as-zero values (see fixtures.ts REWARDS_BY_ARM):
    // task-a [1,0,0(err)], task-b [0,0,1], task-c [1,1,0], task-d [0,1,1].
    const values = [1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1];
    const ci = bootstrapMeanCI(values, TEST_BOOTSTRAP);
    expect(ci).toEqual({ mean: 0.5, ciLow: 0.25, ciHigh: 0.75, n: 12, resamples: 500, seed: 42, alpha: 0.05 });
  });
});

describe("computePairedDelta", () => {
  test("returns an all-null envelope when no task is paired", () => {
    const result = computePairedDelta([], "A", "B", "errored-as-zero");
    expect(result).toEqual({
      armA: "A",
      armB: "B",
      policy: "errored-as-zero",
      nTasksPaired: 0,
      tasksOnlyInA: [],
      tasksOnlyInB: [],
      meanA: null,
      meanB: null,
      delta: null,
      ci: null,
    });
  });

  test("degenerates to a point interval when exactly one task is paired", () => {
    const summaries: TaskArmRewardSummary[] = [
      {
        taskName: "t1",
        arm: "A",
        attempts: 1,
        erroredCount: 0,
        missingRewardCount: 0,
        nErroredAsZero: 1,
        meanRewardErroredAsZero: 1,
        nErroredExcluded: 1,
        meanRewardErroredExcluded: 1,
      },
      {
        taskName: "t1",
        arm: "B",
        attempts: 1,
        erroredCount: 0,
        missingRewardCount: 0,
        nErroredAsZero: 1,
        meanRewardErroredAsZero: 0,
        nErroredExcluded: 1,
        meanRewardErroredExcluded: 0,
      },
    ];
    const result = computePairedDelta(summaries, "A", "B", "errored-as-zero", { seed: 3, resamples: 20 });
    expect(result.nTasksPaired).toBe(1);
    expect(result.meanA).toBe(1);
    expect(result.meanB).toBe(0);
    expect(result.delta).toBe(1);
    expect(result.ci).toEqual({ mean: 1, ciLow: 1, ciHigh: 1, n: 1, resamples: 20, seed: 3, alpha: 0.05 });
  });

  test("lists unpaired tasks under tasksOnlyInA / tasksOnlyInB rather than dropping them silently", () => {
    const summaries: TaskArmRewardSummary[] = [
      {
        taskName: "only-a",
        arm: "A",
        attempts: 1,
        erroredCount: 0,
        missingRewardCount: 0,
        nErroredAsZero: 1,
        meanRewardErroredAsZero: 1,
        nErroredExcluded: 1,
        meanRewardErroredExcluded: 1,
      },
      {
        taskName: "only-b",
        arm: "B",
        attempts: 1,
        erroredCount: 0,
        missingRewardCount: 0,
        nErroredAsZero: 1,
        meanRewardErroredAsZero: 1,
        nErroredExcluded: 1,
        meanRewardErroredExcluded: 1,
      },
    ];
    const result = computePairedDelta(summaries, "A", "B", "errored-as-zero");
    expect(result.nTasksPaired).toBe(0);
    expect(result.tasksOnlyInA).toEqual(["only-a"]);
    expect(result.tasksOnlyInB).toEqual(["only-b"]);
  });
});

describe("summarizeTaskArmRewards / usable-reward policies", () => {
  test("an errored trial contributes 0 under errored-as-zero and is dropped under errored-excluded", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const buckets = bucketByTaskArm(records);
      const controlTaskA = buckets.find((b) => b.taskName === "task-a" && b.arm === CONTROL_ARM);
      const summary = summarizeTaskArmRewards(controlTaskA as (typeof buckets)[number]);

      expect(summary.attempts).toBe(3);
      expect(summary.erroredCount).toBe(1);
      expect(summary.missingRewardCount).toBe(0);
      // errored-as-zero: [1, 0, 0(errored)] -> mean 1/3
      expect(summary.nErroredAsZero).toBe(3);
      expect(summary.meanRewardErroredAsZero).toBeCloseTo(1 / 3);
      // errored-excluded: [1, 0] -> mean 0.5
      expect(summary.nErroredExcluded).toBe(2);
      expect(summary.meanRewardErroredExcluded).toBe(0.5);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("a multi-key reward trial's canonical reward is unaffected by the extra key", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const buckets = bucketByTaskArm(records);
      const controlTaskC = buckets.find((b) => b.taskName === "task-c" && b.arm === CONTROL_ARM);
      const summary = summarizeTaskArmRewards(controlTaskC as (typeof buckets)[number]);
      // [1, 1, 0] -- the multi-key trial's canonical reward is still 1.
      expect(summary.meanRewardErroredAsZero).toBeCloseTo(2 / 3);
      expect(summary.meanRewardErroredExcluded).toBeCloseTo(2 / 3);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });
});

describe("computeAnalysisStats — golden, over the synthetic fixture", () => {
  test("golden: arm summaries at seed 42 / 500 resamples", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const stats = computeAnalysisStats(records, TEST_BOOTSTRAP);

      expect(stats.arms.map((a) => a.arm)).toEqual([TREATMENT_ARM, CONTROL_ARM]); // "akm-opencode..." sorts before "opencode..."

      const treatment = stats.arms.find((a) => a.arm === TREATMENT_ARM);
      expect(treatment?.nTrials).toBe(12);
      expect(treatment?.nTasks).toBe(4);
      expect(treatment?.passAt1["errored-as-zero"].passAt1).toBeCloseTo(0.8333333333333333);
      expect(treatment?.passAt1["errored-excluded"].passAt1).toBeCloseTo(0.8333333333333333);
      expect(treatment?.rewardStats["errored-as-zero"].ci).toEqual({
        mean: 0.8333333333333334,
        ciLow: 0.5833333333333334,
        ciHigh: 1,
        n: 12,
        resamples: 500,
        seed: 42,
        alpha: 0.05,
      });

      const control = stats.arms.find((a) => a.arm === CONTROL_ARM);
      expect(control?.nTrials).toBe(12);
      expect(control?.passAt1["errored-as-zero"].passAt1).toBeCloseTo(0.5);
      expect(control?.passAt1["errored-excluded"].passAt1).toBeCloseTo(0.5416666666666666);
      expect(control?.rewardStats["errored-as-zero"].n).toBe(12); // errored trial counted (as 0)
      expect(control?.rewardStats["errored-excluded"].n).toBe(11); // errored trial dropped
      expect(control?.rewardStats["errored-as-zero"].ci).toEqual({
        mean: 0.5,
        ciLow: 0.25,
        ciHigh: 0.75,
        n: 12,
        resamples: 500,
        seed: 42,
        alpha: 0.05,
      });
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("golden: token/cost stats disclose the one null-token trial via nullCount", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const treatmentTokens = computeArmTokenStats(records, TREATMENT_ARM);
      expect(treatmentTokens.nTrials).toBe(12);
      expect(treatmentTokens.inputTokens).toEqual({ n: 11, nullCount: 1, mean: 1020.9090909090909, sum: 11230 });
      expect(treatmentTokens.cacheTokens).toEqual({ n: 11, nullCount: 1, mean: 100, sum: 1100 });

      // The control arm also has ONE null-input-tokens trial, but for a
      // different reason: its errored trial (task-a attempt 3) never ran the
      // agent, so `agent_result` is null too — a distinct cause from the
      // deliberate "null-token trial" fixture, disclosed the same way.
      const controlTokens = computeArmTokenStats(records, CONTROL_ARM);
      expect(controlTokens.inputTokens.nullCount).toBe(1);
      expect(controlTokens.inputTokens.n).toBe(11);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("golden: paired-by-task delta (treatment vs control), both policies", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const stats = computeAnalysisStats(records, TEST_BOOTSTRAP);
      expect(stats.deltas).toHaveLength(2); // one arm pair x 2 policies

      const asZero = stats.deltas.find((d) => d.policy === "errored-as-zero");
      expect(asZero?.armA).toBe(TREATMENT_ARM);
      expect(asZero?.armB).toBe(CONTROL_ARM);
      expect(asZero?.nTasksPaired).toBe(4);
      expect(asZero?.meanA).toBeCloseTo(0.8333333333333333);
      expect(asZero?.meanB).toBeCloseTo(0.5);
      expect(asZero?.delta).toBeCloseTo(0.3333333333333333);
      expect(asZero?.ci).toEqual({
        mean: 0.33333333333333326,
        ciLow: 0.08333333333333337,
        ciHigh: 0.5833333333333333,
        n: 4,
        resamples: 500,
        seed: 42,
        alpha: 0.05,
      });

      const excluded = stats.deltas.find((d) => d.policy === "errored-excluded");
      expect(excluded?.delta).toBeCloseTo(0.29166666666666663);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("every ErroredPolicy is represented in every arm's passAt1 / rewardStats", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const stats = computeAnalysisStats(records, TEST_BOOTSTRAP);
      for (const arm of stats.arms) {
        for (const policy of ERRORED_POLICIES) {
          expect(arm.passAt1[policy].policy).toBe(policy);
          expect(arm.rewardStats[policy].policy).toBe(policy);
        }
      }
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("empty input produces an empty (not throwing) AnalysisStats", () => {
    const stats = computeAnalysisStats([], TEST_BOOTSTRAP);
    expect(stats.arms).toEqual([]);
    expect(stats.taskArmSummaries).toEqual([]);
    expect(stats.deltas).toEqual([]);
  });
});

describe("computePassAt1 / computeArmRewardStats — arm filtering", () => {
  test("computePassAt1 excludes tasks with zero usable trials rather than treating them as 0", () => {
    const summaries: TaskArmRewardSummary[] = [
      {
        taskName: "all-errored",
        arm: "A",
        attempts: 2,
        erroredCount: 2,
        missingRewardCount: 0,
        nErroredAsZero: 2,
        meanRewardErroredAsZero: 0,
        nErroredExcluded: 0,
        meanRewardErroredExcluded: null,
      },
      {
        taskName: "healthy",
        arm: "A",
        attempts: 1,
        erroredCount: 0,
        missingRewardCount: 0,
        nErroredAsZero: 1,
        meanRewardErroredAsZero: 1,
        nErroredExcluded: 1,
        meanRewardErroredExcluded: 1,
      },
    ];
    const excluded = computePassAt1(summaries, "A", "errored-excluded");
    expect(excluded.nTasks).toBe(1);
    expect(excluded.excludedTasks).toEqual(["all-errored"]);
    expect(excluded.passAt1).toBe(1); // NOT (0 + 1) / 2 = 0.5 -- the all-errored task must not count as a 0

    const asZero = computePassAt1(summaries, "A", "errored-as-zero");
    expect(asZero.nTasks).toBe(2);
    expect(asZero.excludedTasks).toEqual([]);
    expect(asZero.passAt1).toBe(0.5);
  });

  test("computeArmRewardStats returns n=0 / ci=null for an arm with no records", () => {
    const stats = computeArmRewardStats([], "nonexistent-arm", "errored-as-zero");
    expect(stats.n).toBe(0);
    expect(stats.ci).toBeNull();
  });
});

describe("computePassAt1 — CI over per-task means (S5 fix: not attempt-level)", () => {
  // 3 tasks, 3 attempts each, one attempt-level outlier that a trial-level
  // bootstrap would treat as one more independent data point but a
  // per-task-mean bootstrap must not: it is folded into task "hot"'s mean
  // before resampling, so the resample dimension is exactly 3 (tasks), not 9
  // (attempts).
  const summaries: TaskArmRewardSummary[] = [
    {
      taskName: "cold",
      arm: "A",
      attempts: 3,
      erroredCount: 0,
      missingRewardCount: 0,
      nErroredAsZero: 3,
      meanRewardErroredAsZero: 0,
      nErroredExcluded: 3,
      meanRewardErroredExcluded: 0,
    },
    {
      taskName: "hot",
      arm: "A",
      attempts: 3,
      erroredCount: 0,
      missingRewardCount: 0,
      nErroredAsZero: 3,
      meanRewardErroredAsZero: 1,
      nErroredExcluded: 3,
      meanRewardErroredExcluded: 1,
    },
    {
      taskName: "mid",
      arm: "A",
      attempts: 3,
      erroredCount: 0,
      missingRewardCount: 0,
      nErroredAsZero: 3,
      meanRewardErroredAsZero: 0.5,
      nErroredExcluded: 3,
      meanRewardErroredExcluded: 0.5,
    },
  ];

  test("ci.n is the TASK count, not the attempt count", () => {
    const result = computePassAt1(summaries, "A", "errored-as-zero", { seed: 11, resamples: 200 });
    expect(result.nTasks).toBe(3);
    expect(result.ci?.n).toBe(3);
    expect(result.passAt1).toBeCloseTo(0.5);
    expect(result.ci?.mean).toBeCloseTo(0.5);
  });

  test("golden: seed 11 / 200 resamples over {0, 1, 0.5}", () => {
    const result = computePassAt1(summaries, "A", "errored-as-zero", { seed: 11, resamples: 200 });
    expect(result.ci).toEqual({ mean: 0.5, ciLow: 0, ciHigh: 1, n: 3, resamples: 200, seed: 11, alpha: 0.05 });
  });

  test("ci is null when nTasks is 0", () => {
    const result = computePassAt1([], "A", "errored-as-zero");
    expect(result.ci).toBeNull();
  });
});

describe("computeSymmetricPairedDelta (S6 fix: drop a task from BOTH arms when EITHER arm errored on it)", () => {
  test("excludes a task from the pairing when only one arm errored on it, without folding it into either mean", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const stats = computeAnalysisStats(records, TEST_BOOTSTRAP);
      // Fixture: control/task-a/attempt-3 errors; treatment never errors on
      // task-a. task-b/c/d are clean on both arms.
      const result = computeSymmetricPairedDelta(stats.taskArmSummaries, TREATMENT_ARM, CONTROL_ARM, TEST_BOOTSTRAP);
      expect(result.tasksExcludedAnyArmErrored).toEqual(["task-a"]);
      expect(result.nTasksPaired).toBe(3);
      // meanA (treatment) over {task-b, task-c, task-d}: (2/3 + 1 + 2/3) / 3
      expect(result.meanA).toBeCloseTo((2 / 3 + 1 + 2 / 3) / 3);
      // meanB (control) over the same tasks: (1/3 + 2/3 + 2/3) / 3
      expect(result.meanB).toBeCloseTo((1 / 3 + 2 / 3 + 2 / 3) / 3);
      expect(result.ci?.n).toBe(3);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("returns an all-null envelope when no task survives the symmetric exclusion", () => {
    const summaries: TaskArmRewardSummary[] = [
      {
        taskName: "t1",
        arm: "A",
        attempts: 1,
        erroredCount: 1,
        missingRewardCount: 0,
        nErroredAsZero: 1,
        meanRewardErroredAsZero: 0,
        nErroredExcluded: 0,
        meanRewardErroredExcluded: null,
      },
      {
        taskName: "t1",
        arm: "B",
        attempts: 1,
        erroredCount: 0,
        missingRewardCount: 0,
        nErroredAsZero: 1,
        meanRewardErroredAsZero: 1,
        nErroredExcluded: 1,
        meanRewardErroredExcluded: 1,
      },
    ];
    const result = computeSymmetricPairedDelta(summaries, "A", "B");
    expect(result.nTasksPaired).toBe(0);
    expect(result.tasksExcludedAnyArmErrored).toEqual(["t1"]);
    expect(result.meanA).toBeNull();
    expect(result.ci).toBeNull();
  });

  test("a task present in only one arm is reported under tasksOnlyInA/B, not tasksExcludedAnyArmErrored", () => {
    const summaries: TaskArmRewardSummary[] = [
      {
        taskName: "only-a",
        arm: "A",
        attempts: 1,
        erroredCount: 0,
        missingRewardCount: 0,
        nErroredAsZero: 1,
        meanRewardErroredAsZero: 1,
        nErroredExcluded: 1,
        meanRewardErroredExcluded: 1,
      },
    ];
    const result = computeSymmetricPairedDelta(summaries, "A", "B");
    expect(result.tasksOnlyInA).toEqual(["only-a"]);
    expect(result.tasksExcludedAnyArmErrored).toEqual([]);
  });
});

describe("bootstrap parameter validation (S18 fix)", () => {
  test("bootstrapMeanCI throws on resamples < 1 instead of silently producing NaN bounds", () => {
    expect(() => bootstrapMeanCI([1, 0], { resamples: 0 })).toThrow(RangeError);
    expect(() => bootstrapMeanCI([1, 0], { resamples: -5 })).toThrow(RangeError);
    expect(() => bootstrapMeanCI([1, 0], { resamples: 1.5 })).toThrow(RangeError);
  });

  test("bootstrapMeanCI throws on alpha outside (0, 1)", () => {
    expect(() => bootstrapMeanCI([1, 0], { alpha: 0 })).toThrow(RangeError);
    expect(() => bootstrapMeanCI([1, 0], { alpha: 1 })).toThrow(RangeError);
    expect(() => bootstrapMeanCI([1, 0], { alpha: -0.1 })).toThrow(RangeError);
  });

  test("computePairedDelta and computeSymmetricPairedDelta propagate the same validation", () => {
    const summaries: TaskArmRewardSummary[] = [
      {
        taskName: "t1",
        arm: "A",
        attempts: 1,
        erroredCount: 0,
        missingRewardCount: 0,
        nErroredAsZero: 1,
        meanRewardErroredAsZero: 1,
        nErroredExcluded: 1,
        meanRewardErroredExcluded: 1,
      },
      {
        taskName: "t1",
        arm: "B",
        attempts: 1,
        erroredCount: 0,
        missingRewardCount: 0,
        nErroredAsZero: 1,
        meanRewardErroredAsZero: 0,
        nErroredExcluded: 1,
        meanRewardErroredExcluded: 0,
      },
    ];
    expect(() => computePairedDelta(summaries, "A", "B", "errored-as-zero", { resamples: 0 })).toThrow(RangeError);
    expect(() => computeSymmetricPairedDelta(summaries, "A", "B", { alpha: 2 })).toThrow(RangeError);
  });
});
