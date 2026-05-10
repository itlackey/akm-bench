/**
 * Report-level coverage for Track B learning curves (issue #265).
 *
 * Verifies that a `LearningCurve` supplied via `EvolveReportInput.learningCurve`
 * surfaces in both the JSON envelope (under `learning`) and the markdown
 * body (as a "Learning curve" section). Companion unit tests for
 * `computeLearningCurve` itself live in `metrics.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { computeLearningCurve, type EpisodeRecord } from "../src/metrics";
import {
  type EvolveReportInput,
  renderEvolveReport,
  renderLearningCurveSection,
  renderLessonLineageSection,
  type UtilityRunReport,
} from "../src/report";

function emptyUtilityReport(): UtilityRunReport {
  return {
    timestamp: "2026-04-27T00:00:00Z",
    branch: "test",
    commit: "deadbee",
    model: "m",
    corpus: { domains: 0, tasks: 0, slice: "all", seedsPerArm: 1 },
    aggregateNoakm: { passRate: 0, tokensPerPass: 0, tokensPerRun: null, wallclockMs: 0 },
    aggregateAkm: { passRate: 0, tokensPerPass: 0, tokensPerRun: null, wallclockMs: 0 },
    aggregateDelta: {
      passRate: 0,
      tokensPerPass: 0,
      tokensPerRun: null,
      wallclockMs: 0,
    },
    trajectoryAkm: {
      correctAssetLoaded: null,
      feedbackRecorded: 0,
    },
    failureModes: { byLabel: {}, byTask: {} },
    tasks: [],
    warnings: [],
    akmRuns: [],
    taskMetadata: [],
    goldRankRecords: [],
  };
}

function ep(overrides: Partial<EpisodeRecord> & { episode_index: number; pass_rate: number }): EpisodeRecord {
  return {
    delta_from_previous_episode: 0,
    cumulative_feedback_events: 0,
    cumulative_proposals_created: 0,
    cumulative_proposals_accepted: 0,
    cumulative_lessons_created: 0,
    lesson_reuse_rate: null,
    ...overrides,
  };
}

function baseEvolveInput(extra: Partial<EvolveReportInput> = {}): EvolveReportInput {
  return {
    timestamp: "2026-04-27T00:00:00Z",
    branch: "test",
    commit: "deadbee",
    model: "m",
    domain: "test",
    seedsPerArm: 1,
    proposals: { rows: [], totalProposals: 0, totalAccepted: 0, acceptanceRate: 0, lintPassRate: 0 },
    longitudinal: {
      improvementSlope: 0.1,
      prePassRateStdev: 0,
      postPassRateStdev: 0,
      significanceThreshold: 0,
      interpretation: "improvement_detected",
      directionalImprovement: true,
      exceedsSignificanceThreshold: true,
      matchesOrBeatsSynthetic: true,
      overSyntheticLift: 0.05,
      degradationCount: 0,
      degradations: [],
      prePassRate: 0.5,
      postPassRate: 0.6,
      syntheticPassRate: 0.55,
    },
    arms: { pre: emptyUtilityReport(), post: emptyUtilityReport(), synthetic: emptyUtilityReport() },
    warnings: [],
    ...extra,
  };
}

function basePhaseTimings() {
  return {
    phase1: {
      startedAt: "2026-04-27T00:00:00.000Z",
      endedAt: "2026-04-27T00:00:10.000Z",
      elapsedMs: 10000,
    },
    phase2: {
      startedAt: "2026-04-27T00:00:10.000Z",
      endedAt: "2026-04-27T00:00:25.000Z",
      elapsedMs: 15000,
    },
    phase3: {
      startedAt: "2026-04-27T00:00:25.000Z",
      endedAt: "2026-04-27T00:00:40.000Z",
      elapsedMs: 15000,
      arms: {
        preElapsedMs: 4000,
        postElapsedMs: 7000,
        syntheticElapsedMs: 4000,
      },
    },
    totalElapsedMs: 40000,
    akmCommands: [
      {
        phase: "phase1" as const,
        command: "feedback",
        args: ["feedback", "skill:loser", "--negative"],
        elapsedMs: 50,
        exitCode: 0,
        watchdogExceeded: false,
      },
      {
        phase: "phase2" as const,
        command: "reflect",
        args: ["reflect", "skill:loser"],
        elapsedMs: 130000,
        exitCode: 0,
        watchdogExceeded: true,
      },
    ],
  };
}

describe("renderEvolveReport — learning block (#265)", () => {
  test("emits learning.episodes[] + slope + time_to_improvement when learningCurve supplied", () => {
    const curve = computeLearningCurve([
      ep({ episode_index: 0, pass_rate: 0.4, cumulative_feedback_events: 10 }),
      ep({
        episode_index: 1,
        pass_rate: 0.55,
        cumulative_feedback_events: 22,
        cumulative_proposals_created: 4,
        cumulative_proposals_accepted: 3,
        cumulative_lessons_created: 3,
        lesson_reuse_rate: 0.42,
      }),
      ep({
        episode_index: 2,
        pass_rate: 0.7,
        cumulative_feedback_events: 35,
        cumulative_proposals_created: 7,
        cumulative_proposals_accepted: 5,
        cumulative_lessons_created: 5,
        lesson_reuse_rate: 0.6,
      }),
    ]);
    const { json, markdown } = renderEvolveReport(baseEvolveInput({ learningCurve: curve }));
    const parsed = json as {
      learning?: {
        episodes: Array<{ episode_index: number; pass_rate: number; cumulative_lessons_created: number }>;
        pass_rate_by_episode: number[];
        learning_slope: number;
        time_to_improvement: number | null;
      };
    };
    expect(parsed.learning).toBeDefined();
    expect(parsed.learning?.episodes).toHaveLength(3);
    expect(parsed.learning?.pass_rate_by_episode).toEqual([0.4, 0.55, 0.7]);
    expect(parsed.learning?.time_to_improvement).toBe(1);
    expect(parsed.learning?.learning_slope).toBeCloseTo(0.15, 3);
    expect(markdown).toContain("Learning curve");
    expect(markdown).toContain("learning_slope=+0.150");
    expect(markdown).toContain("time_to_improvement=1");
  });

  test("omits learning block when learningCurve absent (legacy path)", () => {
    const { json, markdown } = renderEvolveReport(baseEvolveInput());
    const parsed = json as { learning?: object; lesson_lineage?: object };
    expect(parsed.learning).toBeUndefined();
    expect(parsed.lesson_lineage).toBeUndefined();
    expect(markdown).not.toContain("Learning curve");
  });

  test("renders n/a for time_to_improvement when no improvement", () => {
    const curve = computeLearningCurve([
      ep({ episode_index: 0, pass_rate: 0.5 }),
      ep({ episode_index: 1, pass_rate: 0.5 }),
    ]);
    const { json, markdown } = renderEvolveReport(baseEvolveInput({ learningCurve: curve }));
    const parsed = json as { learning?: { time_to_improvement: number | null } };
    expect(parsed.learning?.time_to_improvement).toBeNull();
    expect(markdown).toContain("time_to_improvement=n/a");
  });

  test("emits lesson_lineage JSON and markdown when supplied", () => {
    const lineage = {
      post_tasks: [
        {
          task_id: "eval/task-a",
          lessons: [
            {
              ref: "lesson:docker-healthchecks",
              accepted: true,
              fired_count: 2,
              source_failures: ["train/task-a", "train/task-b"],
            },
          ],
        },
      ],
    };
    const { json, markdown } = renderEvolveReport(baseEvolveInput({ lessonLineage: lineage }));
    const parsed = json as {
      lesson_lineage?: {
        post_tasks: Array<{
          task_id: string;
          lessons: Array<{ ref: string; accepted: boolean; fired_count: number; source_failures: string[] }>;
        }>;
      };
    };
    expect(parsed.lesson_lineage).toEqual(lineage);
    expect(markdown).toContain("Lesson lineage");
    expect(markdown).toContain("eval/task-a");
    expect(markdown).toContain("lesson:docker-healthchecks");
    expect(markdown).toContain("train/task-a, train/task-b");
  });

  test("emits proposal diagnostics + phase1 diagnostics in JSON and markdown", () => {
    const { json, markdown } = renderEvolveReport(
      baseEvolveInput({
        proposalLog: [
          {
            proposalId: "p-1",
            assetRef: "skill:loser",
            kind: "lesson",
            lintPass: true,
            decision: "accept",
          },
          {
            proposalId: "p-2",
            assetRef: "skill:loser",
            kind: "revision",
            lintPass: false,
            decision: "reject",
            rejectReason: "missing description",
          },
        ],
        phase1Diagnostics: {
          perRefFeedback: [
            { ref: "skill:loser", positive: 0, negative: 3 },
            { ref: "skill:winner", positive: 3, negative: 0 },
          ],
          refsToEvolve: ["skill:loser"],
        },
      }),
    );

    const parsed = json as unknown as {
      proposals: {
        proposal_log?: Array<{
          id: string;
          asset: string;
          kind: string;
          lint: boolean;
          decision: string;
          reason: string | null;
        }>;
      };
      phase1?: {
        per_ref_feedback: Array<{ ref: string; positive: number; negative: number }>;
        refs_to_evolve: string[];
      };
    };

    expect(parsed.proposals.proposal_log).toEqual([
      {
        id: "p-1",
        asset: "skill:loser",
        kind: "lesson",
        lint: true,
        decision: "accept",
        reason: null,
      },
      {
        id: "p-2",
        asset: "skill:loser",
        kind: "revision",
        lint: false,
        decision: "reject",
        reason: "missing description",
      },
    ]);
    expect(parsed.phase1).toEqual({
      per_ref_feedback: [
        { ref: "skill:loser", positive: 0, negative: 3 },
        { ref: "skill:winner", positive: 3, negative: 0 },
      ],
      refs_to_evolve: ["skill:loser"],
    });

    expect(markdown).toContain("Proposal diagnostics");
    expect(markdown).toContain("Phase 1 diagnostics");
    expect(markdown).toContain("promoted_refs=1");
    expect(markdown).toContain("p-1");
    expect(markdown).toContain("skill:loser");
  });

  test("emits phase timing diagnostics in JSON and markdown", () => {
    const { json, markdown } = renderEvolveReport(baseEvolveInput({ phaseTimings: basePhaseTimings() }));
    const parsed = json as {
      phase_timings?: {
        phase1: { elapsed_ms: number };
        phase2: { elapsed_ms: number };
        phase3: { arms: { pre_elapsed_ms: number; post_elapsed_ms: number; synthetic_elapsed_ms: number } };
        total_elapsed_ms: number;
        akm_commands: Array<{ command: string; watchdog_exceeded: boolean }>;
      };
    };
    expect(parsed.phase_timings).toBeDefined();
    expect(parsed.phase_timings?.phase1.elapsed_ms).toBe(10000);
    expect(parsed.phase_timings?.phase2.elapsed_ms).toBe(15000);
    expect(parsed.phase_timings?.phase3.arms.post_elapsed_ms).toBe(7000);
    expect(parsed.phase_timings?.total_elapsed_ms).toBe(40000);
    expect(parsed.phase_timings?.akm_commands.map((row) => ({ command: row.command, watchdog_exceeded: row.watchdog_exceeded }))).toEqual([
      { command: "feedback", watchdog_exceeded: false },
      { command: "reflect", watchdog_exceeded: true },
    ]);
    expect(markdown).toContain("Phase timings");
    expect(markdown).toContain("phase3_arms_ms: pre=4000, post=7000, synthetic=4000");
    expect(markdown).toContain("watchdog_exceeded=1");
  });
});

describe("renderLearningCurveSection", () => {
  test("emits the empty-state message when no episodes are recorded", () => {
    const md = renderLearningCurveSection({
      episodes: [],
      pass_rate_by_episode: [],
      learning_slope: 0,
      time_to_improvement: null,
    });
    expect(md).toContain("No episodes recorded");
  });
});

describe("renderLessonLineageSection", () => {
  test("emits the empty-state message when no lineage rows are recorded", () => {
    const md = renderLessonLineageSection({ post_tasks: [] });
    expect(md).toContain("No generated lessons fired on post-arm tasks");
  });
});
