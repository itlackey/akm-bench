/**
 * Unit tests for `analysis/src/calibration.ts` — the docs/comparability.md B6
 * calibration gate.
 *
 * The synthetic fixture in `fixtures.ts` writes no agent trajectories, so both
 * of its arms look silent to `inferControlArm`. That is used deliberately
 * below: it is the "cannot tell" case, and the gate must refuse to guess.
 */

import { describe, expect, test } from "bun:test";

import {
  ControlArmAmbiguousError,
  computeCalibration,
  inferControlArm,
  renderCalibrationMarkdown,
} from "../src/calibration";
import { loadJobs } from "../src/loader";
import type { TrialRecord } from "../src/types";
import { buildSyntheticJobTree, CONTROL_ARM, cleanupSyntheticJobTree, TREATMENT_ARM } from "./fixtures";

function trial(
  arm: string,
  taskName: string,
  reward: number | null,
  akmCalls: number | null,
  overrides: Partial<TrialRecord> = {},
): TrialRecord {
  return {
    jobId: "job",
    trialName: `${taskName}-${arm}-${reward}-${akmCalls}-${Math.trunc(Math.abs(reward ?? -1) * 7)}`,
    trialDir: "/dev/null",
    taskName,
    arm,
    agentName: "a",
    agentVersion: "1",
    modelName: "m",
    modelProvider: "p",
    source: null,
    rewards: reward === null ? null : { reward },
    reward,
    otherRewards: {},
    tokens: { inputTokens: null, cacheTokens: null, outputTokens: null, costUsd: null },
    toolUse: {
      akmCalls,
      totalCalls: akmCalls === null ? null : akmCalls + 1,
      byTool: akmCalls && akmCalls > 0 ? { akm_curate: akmCalls } : {},
    },
    errored: false,
    exceptionType: null,
    startedAt: null,
    finishedAt: null,
    timing: { environmentSetup: null, agentSetup: null, agentExecution: null, verifier: null },
    provenance: { taskChecksum: "", agentKwargs: {}, agentImportPath: null, agentEnv: {} },
    ...overrides,
  };
}

const opts = { jobsDir: "/dev/null", controlArm: "ctrl" };

describe("inferControlArm", () => {
  test("picks the arm with readable trajectories and no akm calls", () => {
    const records = [trial("treat", "t", 1, 3), trial("ctrl", "t", 0, 0)];
    expect(inferControlArm(records)).toBe("ctrl");
  });

  test("refuses when no arm has a readable trajectory", () => {
    // Silence and unreadability are NOT the same observation. Guessing here
    // would calibrate against whichever arm happened to crash.
    const records = [trial("treat", "t", 1, null), trial("ctrl", "t", 0, null)];
    expect(() => inferControlArm(records)).toThrow(ControlArmAmbiguousError);
  });

  test("refuses when two arms both look silent", () => {
    const records = [trial("a", "t", 1, 0), trial("b", "t", 0, 0)];
    expect(() => inferControlArm(records)).toThrow(/ambiguous/);
  });

  test("an arm that called akm even once is not the control", () => {
    const records = [trial("treat", "t1", 1, 0), trial("treat", "t2", 1, 2), trial("ctrl", "t1", 0, 0)];
    expect(inferControlArm(records)).toBe("ctrl");
  });
});

describe("computeCalibration verdicts", () => {
  test("control failing every attempt passes the gate", () => {
    const records = [trial("ctrl", "t", 0, 0), trial("ctrl", "t", 0, 0), trial("ctrl", "t", 0, 0)];
    const task = computeCalibration(records, opts).tasks[0];
    expect(task?.verdict).toBe("discriminating");
    expect(task?.passesGate).toBe(true);
    expect(task?.controlPasses).toBe(0);
  });

  test("control passing every attempt is non-discriminating", () => {
    const records = [trial("ctrl", "t", 1, 0), trial("ctrl", "t", 1, 0)];
    const task = computeCalibration(records, opts).tasks[0];
    expect(task?.verdict).toBe("non-discriminating");
    expect(task?.passesGate).toBe(false);
  });

  test("control passing on SOME attempts is guessable and still fails the gate", () => {
    // The knowledge-gap principle's seed-tolerance rule: one passing seed is
    // enough to disqualify. A 2/3 task is not "mostly fine".
    const records = [trial("ctrl", "t", 1, 0), trial("ctrl", "t", 0, 0), trial("ctrl", "t", 1, 0)];
    const task = computeCalibration(records, opts).tasks[0];
    expect(task?.verdict).toBe("guessable");
    expect(task?.passesGate).toBe(false);
    expect(task?.controlPassRate).toBeCloseTo(2 / 3);
  });

  test("an all-errored control is unknown, NOT discriminating", () => {
    // The trap this gate must not fall into: errored-as-zero would score this
    // 0.000 and certify a crashed harness as a knowledge gap.
    const errored = { errored: true, reward: null, rewards: null, exceptionType: "Boom" };
    const records = [trial("ctrl", "t", null, 0, errored), trial("ctrl", "t", null, 0, errored)];
    const task = computeCalibration(records, opts).tasks[0];
    expect(task?.verdict).toBe("unknown");
    expect(task?.passesGate).toBe(false);
    expect(task?.erroredCount).toBe(2);
  });

  test("a partially errored control is judged on the attempts that ran", () => {
    const records = [
      trial("ctrl", "t", null, 0, { errored: true, reward: null, rewards: null }),
      trial("ctrl", "t", 0, 0),
      trial("ctrl", "t", 0, 0),
    ];
    const task = computeCalibration(records, opts).tasks[0];
    expect(task?.verdict).toBe("discriminating");
    expect(task?.erroredCount).toBe(1);
    expect(task?.attempts).toBe(3);
  });

  test("only the control arm is measured; other arms are listed, not scored", () => {
    const records = [trial("ctrl", "t", 0, 0), trial("treat", "t", 1, 2)];
    const report = computeCalibration(records, opts);
    expect(report.tasks).toHaveLength(1);
    expect(report.controlArm).toBe("ctrl");
    expect(report.otherArms).toEqual(["treat"]);
  });

  test("a control arm naming no real arm warns instead of silently reporting nothing", () => {
    const records = [trial("ctrl", "t", 0, 0)];
    const report = computeCalibration(records, { jobsDir: "/dev/null", controlArm: "nope" });
    expect(report.tasks).toHaveLength(0);
    expect(report.warnings.join(" ")).toContain("matches no arm");
  });
});

describe("computeCalibration rollups", () => {
  test("totals and gate rate count every task, none dropped", () => {
    const records = [
      trial("ctrl", "pass", 0, 0),
      trial("ctrl", "guess", 1, 0),
      trial("ctrl", "guess", 0, 0),
      trial("ctrl", "fail", 1, 0),
    ];
    const { totals } = computeCalibration(records, opts);
    expect(totals).toMatchObject({
      tasks: 3,
      discriminating: 1,
      guessable: 1,
      nonDiscriminating: 1,
      unknown: 0,
      passingGate: 1,
    });
    expect(totals.gateRate).toBeCloseTo(1 / 3);
  });

  test("tasks with no corpus metadata are grouped, not discarded", () => {
    const records = [trial("ctrl", "t", 0, 0)];
    const report = computeCalibration(records, opts);
    expect(report.byDomain).toHaveLength(1);
    expect(report.byDomain[0]?.domain).toBe("(no metadata)");
    expect(report.byDomain[0]?.tasks).toBe(1);
  });

  test("the markdown names every failing task, so nothing is hidden by a rollup", () => {
    const records = [trial("ctrl", "pass", 0, 0), trial("ctrl", "fail", 1, 0)];
    const md = renderCalibrationMarkdown(computeCalibration(records, opts));
    expect(md).toContain("1 of 2 tasks fail the gate");
    expect(md).toContain("`fail`");
    expect(md).toContain("comparability.md");
  });
});

describe("against the synthetic job tree", () => {
  test("refuses to infer a control arm when the fixture has no trajectories", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      expect(() => computeCalibration(records, { jobsDir: tree.jobsDir })).toThrow(ControlArmAmbiguousError);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("scores the named control arm across the fixture's four tasks", () => {
    // Fixture control rewards: task-a [1,0,errored], task-b [0,0,1],
    // task-c [1,1,0], task-d [0,1,1]. Every task's control passes at least
    // once, so the whole fixture corpus fails the gate.
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const report = computeCalibration(records, {
        jobsDir: tree.jobsDir,
        controlArm: CONTROL_ARM,
      });
      expect(report.tasks).toHaveLength(4);
      expect(report.otherArms).toEqual([TREATMENT_ARM]);
      expect(report.totals.passingGate).toBe(0);
      expect(report.totals.guessable).toBe(4);
      const taskA = report.tasks.find((t) => t.taskName === "task-a");
      expect(taskA?.erroredCount).toBe(1);
      // errored attempt excluded: 1 and 0 remain -> 0.5, still guessable.
      expect(taskA?.controlPassRate).toBeCloseTo(0.5);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });
});
