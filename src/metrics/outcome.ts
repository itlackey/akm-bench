/**
 * akm-bench outcome metrics (§6.1).
 */

import type { RunResult } from "../driver";

// ── Outcome (§6.1) ─────────────────────────────────────────────────────────

export interface OutcomeAggregate {
  /** Fraction of runs whose outcome is `pass`. Zero when results is empty. */
  passRate: number;
  /**
   * Mean total tokens across runs that passed AND have a parsed token
   * measurement; `0` when no such runs exist (avoids `Infinity` and `NaN`
   * polluting downstream JSON). Runs with `tokenMeasurement !== "parsed"`
   * are deliberately skipped so a `0` here means "no parsed passes" rather
   * than "free run" (issue #252).
   */
  tokensPerPass: number;
  /** Mean wallclock ms across all runs (not just passes). */
  wallclockMs: number;
  /** Number of runs whose outcome is `budget_exceeded`. */
  budgetExceeded: number;
  /**
   * Total runs (any outcome) with `tokenMeasurement === "parsed"`. Reports
   * use this to surface token-measurement coverage; aggregations with low
   * coverage cannot be trusted for token economics (issue #252).
   */
  runsWithMeasuredTokens: number;
}

/**
 * Aggregate outcome metrics over a flat list of RunResults.
 *
 * Aggregations across multiple arms are the caller's responsibility — pass
 * each arm's slice in separately. Backward-compatible v1 contract; the
 * richer per-task / corpus shapes below subsume this.
 */
export function computeOutcomeAggregate(results: RunResult[]): OutcomeAggregate {
  if (results.length === 0) {
    return { passRate: 0, tokensPerPass: 0, wallclockMs: 0, budgetExceeded: 0, runsWithMeasuredTokens: 0 };
  }
  let passes = 0;
  let budgetExceeded = 0;
  let totalTokensInMeasuredPasses = 0;
  let measuredPasses = 0;
  let runsWithMeasuredTokens = 0;
  let totalWallclock = 0;
  for (const r of results) {
    totalWallclock += r.wallclockMs;
    if (isMeasured(r)) {
      runsWithMeasuredTokens += 1;
    }
    if (r.outcome === "pass") {
      passes += 1;
      // Only fold tokens into the mean when we actually measured them
      // (issue #252) — otherwise a `0` would silently understate cost.
      if (isMeasured(r)) {
        measuredPasses += 1;
        totalTokensInMeasuredPasses += r.tokens.input + r.tokens.output;
      }
    } else if (r.outcome === "budget_exceeded") {
      budgetExceeded += 1;
    }
  }
  return {
    passRate: passes / results.length,
    tokensPerPass: measuredPasses === 0 ? 0 : totalTokensInMeasuredPasses / measuredPasses,
    wallclockMs: totalWallclock / results.length,
    budgetExceeded,
    runsWithMeasuredTokens,
  };
}

/**
 * Treat older artefacts without `tokenMeasurement` as `"parsed"` for backward
 * compatibility — pre-#252 reports always returned numeric zero, and rejecting
 * them entirely would break compare/attribute over historical runs.
 */
function isMeasured(r: RunResult): boolean {
  return (r.tokenMeasurement ?? "parsed") === "parsed";
}

// ── Per-task aggregation (§6.1, K seeds per arm) ───────────────────────────

/**
 * Per-(task, arm) aggregate produced by collapsing K seed runs.
 *
 * `tokensPerPass` is `null` when no run in the bag passed (NaN-safety —
 * downstream report renderers turn `null` into a sentinel rather than
 * `Infinity` polluting the JSON envelope).
 */
export interface PerTaskMetrics {
  /** Fraction of K runs that passed. */
  passRate: number;
  /** Pass-or-fail of seed 0 (or first run when seed 0 is absent). */
  passAt1: 0 | 1;
  /**
   * Mean total tokens in passing runs that also carry a parsed token
   * measurement. `null` when 0 passes OR when every passing run has missing /
   * unsupported token measurement (issue #252) — downstream renderers must
   * treat `null` as "not enough measurement to know" rather than zero cost.
   */
  tokensPerPass: number | null;
  /** Mean wallclock ms across all K runs. */
  wallclockMs: number;
  /** Sample standard deviation of pass (1) / fail (0) across the K seeds. */
  passRateStdev: number;
  /** Count of `budget_exceeded` outcomes across the K seeds. */
  budgetExceededCount: number;
  /** Count of `harness_error` outcomes across the K seeds. */
  harnessErrorCount: number;
  /** Number of runs aggregated. Useful when K varies (last seed dropped, etc.). */
  count: number;
  /**
   * Count of runs (any outcome) with `tokenMeasurement === "parsed"` (issue
   * #252). Reports use this to surface token-measurement coverage so
   * operators can tell when token economics are unreliable.
   */
  runsWithMeasuredTokens: number;
  /**
   * Mean total (input + output) tokens across ALL runs (any outcome) that carry
   * a parsed token measurement. `null` when no run in the bag has a parsed
   * measurement. Unlike `tokensPerPass`, this includes failing runs so it
   * reflects the true average token cost regardless of outcome.
   */
  tokensPerRun: number | null;
}

/**
 * Aggregate K seed runs of one (task, arm) pair into PerTaskMetrics. Returns
 * a zeroed envelope on empty input — callers decide whether to skip or render.
 */
export function aggregatePerTask(results: RunResult[]): PerTaskMetrics {
  if (results.length === 0) {
    return {
      passRate: 0,
      passAt1: 0,
      tokensPerPass: null,
      wallclockMs: 0,
      passRateStdev: 0,
      budgetExceededCount: 0,
      harnessErrorCount: 0,
      count: 0,
      runsWithMeasuredTokens: 0,
      tokensPerRun: null,
    };
  }

  let passes = 0;
  let measuredPasses = 0;
  let totalTokensInMeasuredPasses = 0;
  let totalWallclock = 0;
  let budgetExceeded = 0;
  let harnessError = 0;
  let runsWithMeasuredTokens = 0;
  let totalTokensInMeasuredRuns = 0;
  let measuredRuns = 0;
  // For the standard deviation we need a fixed-iteration buffer of pass/fail.
  const passSamples: number[] = [];
  for (const r of results) {
    totalWallclock += r.wallclockMs;
    if (isMeasured(r)) {
      runsWithMeasuredTokens += 1;
      measuredRuns += 1;
      totalTokensInMeasuredRuns += r.tokens.input + r.tokens.output;
    }
    const isPass = r.outcome === "pass" ? 1 : 0;
    passSamples.push(isPass);
    if (isPass === 1) {
      passes += 1;
      // Only count tokens for measured passes (issue #252). A pass with
      // missing measurement contributes to `passRate` but NOT to
      // `tokensPerPass` — preserving "tokens per measured pass" semantics.
      if (isMeasured(r)) {
        measuredPasses += 1;
        totalTokensInMeasuredPasses += r.tokens.input + r.tokens.output;
      }
    } else if (r.outcome === "budget_exceeded") {
      budgetExceeded += 1;
    } else if (r.outcome === "harness_error") {
      harnessError += 1;
    }
  }

  const seed0 = results.find((r) => r.seed === 0) ?? results[0];
  const passAt1: 0 | 1 = seed0 && seed0.outcome === "pass" ? 1 : 0;

  return {
    passRate: passes / results.length,
    passAt1,
    tokensPerPass: measuredPasses === 0 ? null : totalTokensInMeasuredPasses / measuredPasses,
    wallclockMs: totalWallclock / results.length,
    passRateStdev: stdev(passSamples),
    budgetExceededCount: budgetExceeded,
    harnessErrorCount: harnessError,
    count: results.length,
    runsWithMeasuredTokens,
    tokensPerRun: measuredRuns === 0 ? null : totalTokensInMeasuredRuns / measuredRuns,
  };
}

/** Sample standard deviation. Returns 0 for length ≤ 1 (no spread to measure). */
function stdev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sumSq = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0);
  // Sample stdev (Bessel's correction) — n-1 denominator.
  return Math.sqrt(sumSq / (values.length - 1));
}

// ── Corpus aggregation (§6.1 corpus-wide row) ──────────────────────────────

/** Corpus aggregate is a mean over per-task metrics, weighting each task equally. */
export interface CorpusMetrics {
  passRate: number;
  /** Mean over per-task tokensPerPass, treating `null` as missing. `null` if all missing. */
  tokensPerPass: number | null;
  wallclockMs: number;
  /** Mean over per-task tokensPerRun, treating `null` as missing. `null` if all missing. */
  tokensPerRun: number | null;
}

/**
 * Mean across per-task metrics. Each task contributes once, regardless of
 * how many seeds it ran (K is already collapsed in `aggregatePerTask`).
 *
 * `tokensPerPass`: tasks where `tokensPerPass` is `null` (no passes) are
 * dropped from that mean. The result is `null` if every task failed.
 */
export function aggregateCorpus(perTask: Record<string, PerTaskMetrics>): CorpusMetrics {
  const tasks = Object.values(perTask);
  if (tasks.length === 0) {
    return { passRate: 0, tokensPerPass: null, wallclockMs: 0, tokensPerRun: null };
  }
  const passRate = tasks.reduce((a, t) => a + t.passRate, 0) / tasks.length;
  const wallclockMs = tasks.reduce((a, t) => a + t.wallclockMs, 0) / tasks.length;
  const tppValues = tasks.map((t) => t.tokensPerPass).filter((v): v is number => v !== null);
  const tokensPerPass = tppValues.length === 0 ? null : tppValues.reduce((a, b) => a + b, 0) / tppValues.length;
  const tprValues = tasks.map((t) => t.tokensPerRun).filter((v): v is number => v !== null);
  const tokensPerRun = tprValues.length === 0 ? null : tprValues.reduce((a, b) => a + b, 0) / tprValues.length;
  return { passRate, tokensPerPass, wallclockMs, tokensPerRun };
}

// ── Delta (§6.1 corpus row, akm vs noakm) ──────────────────────────────────

export interface CorpusDelta {
  passRate: number;
  /** akm − noakm. `null` if either side is `null`. */
  tokensPerPass: number | null;
  wallclockMs: number;
  /** akm − noakm for tokensPerRun. `null` if either side is `null`. */
  tokensPerRun: number | null;
}

/**
 * Compute the akm − noakm delta. Negative `tokensPerPass`/`wallclockMs` mean
 * akm was cheaper / faster; positive means it cost more. Pass-rate uses the
 * opposite convention (positive = akm wins).
 */
export function computeCorpusDelta(noakm: CorpusMetrics, akm: CorpusMetrics): CorpusDelta {
  return {
    passRate: akm.passRate - noakm.passRate,
    tokensPerPass:
      akm.tokensPerPass === null || noakm.tokensPerPass === null ? null : akm.tokensPerPass - noakm.tokensPerPass,
    wallclockMs: akm.wallclockMs - noakm.wallclockMs,
    tokensPerRun:
      akm.tokensPerRun === null || noakm.tokensPerRun === null ? null : akm.tokensPerRun - noakm.tokensPerRun,
  };
}

/** Per-task delta with the same null-safety as the corpus delta. */
export function computePerTaskDelta(noakm: PerTaskMetrics, akm: PerTaskMetrics): CorpusDelta {
  return {
    passRate: akm.passRate - noakm.passRate,
    tokensPerPass:
      akm.tokensPerPass === null || noakm.tokensPerPass === null ? null : akm.tokensPerPass - noakm.tokensPerPass,
    wallclockMs: akm.wallclockMs - noakm.wallclockMs,
    tokensPerRun:
      akm.tokensPerRun === null || noakm.tokensPerRun === null ? null : akm.tokensPerRun - noakm.tokensPerRun,
  };
}
