/**
 * Statistics module (implementation brief §6 / plan phase P1).
 *
 * Harbor supplies NO statistics of its own beyond a raw reward-value tally:
 * no pass@1 (`pass_at_k` returns `{}` unless every reward is a bare 0/1 and k
 * >= 2 — unreachable at k=1), no confidence intervals, no significance tests,
 * and its default `Mean` metric folds errored trials in as a silent 0
 * (docs/plans/benchmark-harness-consolidation.md §3.1). Every statistic below
 * is ours, and every one of them states its errored-trial policy explicitly
 * rather than picking one implicitly.
 *
 * Two independent, always-both-reported errored-trial policies (never folded
 * silently into a single number):
 *
 *   - `"errored-as-zero"`   — an errored trial contributes a reward of 0.
 *     Matches Harbor's own `Mean` metric, kept as an independent sanity
 *     check per decision D4's consequences.
 *   - `"errored-excluded"`  — an errored trial is dropped from both the
 *     numerator and the denominator.
 *
 * A THIRD case — a trial that did not error but also has no `reward` key at
 * all (a misconfigured verifier, say) — is never auto-zeroed under either
 * policy. It is tracked separately as `missingRewardCount` and always
 * disclosed (see `report.ts`'s disclosure block) rather than silently
 * dropped or silently folded into "errored".
 *
 * Attempt-level pairing across arms is impossible at Harbor v0.22.0: `-k N`
 * records no attempt index, so attempt *i* of arm A cannot be matched to
 * attempt *i* of arm B (consolidation plan §3.1). Every comparison here is
 * therefore either a per-arm aggregate, or a PAIRED-BY-TASK comparison that
 * resamples tasks (never individual attempts) — see `computePairedDelta`.
 *
 * Every PUBLISHABLE confidence interval in this module resamples per-TASK
 * means, never individual trial-level attempts: attempts within one
 * (task, arm) bucket are correlated (same task, same difficulty, same
 * environment), so resampling them directly is pseudo-replication and
 * produces a systematically too-narrow interval. `ArmPassAt1.ci` (attached to
 * `computePassAt1`) is the one to read as the arm's confidence interval;
 * `ArmRewardStats.ci` (from `computeArmRewardStats`) is a SEPARATE,
 * explicitly-labeled attempt-level dispersion statistic that must not be
 * substituted for it. `computePairedDelta` and `computeSymmetricPairedDelta`
 * were already, and remain, correct on this point — both resample task
 * indices jointly across the two arms.
 *
 * `computeSymmetricPairedDelta` is a third comparison alongside the two
 * `ErroredPolicy` deltas: it drops a task from the pairing entirely the
 * moment EITHER arm has any errored trial on it, rather than folding that
 * arm's error into a 0 (biases the affected arm down) or excluding just that
 * arm's failed attempts (biases it up via survivorship over a non-random
 * subset of tasks). See its own doc comment for the full reasoning — this
 * matters specifically for harness/infrastructure errors that can only occur
 * on one arm (e.g. `AkmPluginNotLoadedError`, which by construction cannot
 * fire on a plain `opencode` control arm).
 */

import type { TrialRecord } from "./types";

// ── Deterministic seeded PRNG + bootstrap primitives ────────────────────────

/**
 * mulberry32 — a small, well-known, deterministic PRNG (public domain,
 * D. Bau). Chosen over `Math.random()` specifically because it is seedable:
 * the same seed always produces the same sequence, on any machine, which is
 * what makes `bootstrapMeanCI` / `pairedBootstrapDelta` reproducible and
 * therefore golden-testable.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default deterministic bootstrap seed. A fixed literal, not derived from time/env, so every run (and every test) reproduces byte-identical CIs. */
export const DEFAULT_BOOTSTRAP_SEED = 1337;
/** Default resample count, per the brief. */
export const DEFAULT_BOOTSTRAP_RESAMPLES = 10_000;
/** Two-sided 95% interval. */
const DEFAULT_ALPHA = 0.05;

export interface BootstrapOptions {
  seed?: number;
  resamples?: number;
  /** Two-sided interval width; 0.05 -> [2.5th, 97.5th] percentile. */
  alpha?: number;
}

export interface BootstrapCI {
  /** Point estimate — the mean of the ORIGINAL (non-resampled) values, not the mean of the bootstrap distribution. */
  mean: number;
  ciLow: number;
  ciHigh: number;
  n: number;
  resamples: number;
  seed: number;
  alpha: number;
}

/**
 * Validate `resamples` rather than silently accepting a value that makes
 * `quantileSorted` read past an empty array and return `NaN`. `stats.ts` is
 * explicitly the module the consolidation plan (§6) says both `akm-bench` and
 * `akm-eval` will share, and this is a library-API boundary — no CLI flag
 * reaches it today, but a future caller should get a thrown error naming the
 * problem, not a silent `NaN` that `fmtNum` would later render as `"n/a"`
 * with no indication anything was wrong with the INPUT rather than the data.
 */
function validateResamples(resamples: number | undefined): number {
  const value = resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`bootstrap resamples must be a positive integer, got ${value}`);
  }
  return value;
}

/** Validate `alpha`: outside `(0, 1)` is not "a wider/narrower interval", it silently produces a nonsense or degenerate one (`alpha <= 0` -> `ciLow`/`ciHigh` from a percentile below 0 or above 1; `alpha >= 1` -> an inverted [high, low] pair). */
function validateAlpha(alpha: number | undefined): number {
  const value = alpha ?? DEFAULT_ALPHA;
  if (!(value > 0 && value < 1)) {
    throw new RangeError(`bootstrap alpha must be in (0, 1), got ${value}`);
  }
  return value;
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Linear-interpolation quantile (matches numpy's default `"linear"` method) over an ALREADY-SORTED array. */
function quantileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 1) return sorted[0] as number;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loValue = sorted[lo] as number;
  if (lo === hi) return loValue;
  const hiValue = sorted[hi] as number;
  const frac = idx - lo;
  return loValue * (1 - frac) + hiValue * frac;
}

/**
 * Bootstrap a percentile CI for the mean of `values` by resampling
 * individual values with replacement.
 *
 * Returns `null` on empty input (never `NaN`). With exactly one value, every
 * resample is that same value, so the CI degenerates to a point at it — a
 * correct (if unexciting) answer, not an error.
 */
export function bootstrapMeanCI(values: readonly number[], options: BootstrapOptions = {}): BootstrapCI | null {
  if (values.length === 0) return null;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const resamples = validateResamples(options.resamples);
  const alpha = validateAlpha(options.alpha);

  const rng = mulberry32(seed);
  const n = values.length;
  const resampleMeans: number[] = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      sum += values[idx] as number;
    }
    resampleMeans[i] = sum / n;
  }
  resampleMeans.sort((a, b) => a - b);

  return {
    mean: mean(values),
    ciLow: quantileSorted(resampleMeans, alpha / 2),
    ciHigh: quantileSorted(resampleMeans, 1 - alpha / 2),
    n,
    resamples,
    seed,
    alpha,
  };
}

// ── Errored-trial policy ────────────────────────────────────────────────────

export type ErroredPolicy = "errored-as-zero" | "errored-excluded";
export const ERRORED_POLICIES: readonly ErroredPolicy[] = ["errored-as-zero", "errored-excluded"];

/**
 * Reduce one bucket of same-(task,arm) trials to the reward values usable
 * under `policy`. A non-errored trial with `reward === null` (the
 * "misconfigured verifier" case above) is excluded under BOTH policies —
 * that trial is neither a success, a failure, nor an error; it is a data
 * gap, and folding it into either policy would misrepresent which case
 * actually happened.
 */
function usableRewardValues(trials: readonly TrialRecord[], policy: ErroredPolicy): number[] {
  const values: number[] = [];
  for (const trial of trials) {
    if (trial.errored) {
      if (policy === "errored-as-zero") values.push(0);
      continue;
    }
    if (trial.reward !== null) values.push(trial.reward);
  }
  return values;
}

// ── Per-(task, arm) bucketing ────────────────────────────────────────────────

export interface TaskArmBucket {
  taskName: string;
  arm: string;
  trials: TrialRecord[];
}

/** Group trials by `(taskName, arm)`, sorted for deterministic iteration order downstream. */
export function bucketByTaskArm(records: readonly TrialRecord[]): TaskArmBucket[] {
  const buckets = new Map<string, TaskArmBucket>();
  for (const record of records) {
    const key = `${record.taskName}\u0000${record.arm}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { taskName: record.taskName, arm: record.arm, trials: [] };
      buckets.set(key, bucket);
    }
    bucket.trials.push(record);
  }
  return [...buckets.values()].sort((a, b) => a.taskName.localeCompare(b.taskName) || a.arm.localeCompare(b.arm));
}

export interface TaskArmRewardSummary {
  taskName: string;
  arm: string;
  /** Total trials in this (task, arm) bucket, regardless of outcome. */
  attempts: number;
  erroredCount: number;
  /** Non-errored trials with `reward === null` — the "misconfigured verifier" gap. Always disclosed, never folded into either policy. */
  missingRewardCount: number;
  /** Trials contributing to `meanRewardErroredAsZero` (`attempts - missingRewardCount`). */
  nErroredAsZero: number;
  meanRewardErroredAsZero: number | null;
  /** Trials contributing to `meanRewardErroredExcluded` (non-errored AND reward present). */
  nErroredExcluded: number;
  meanRewardErroredExcluded: number | null;
}

export function summarizeTaskArmRewards(bucket: TaskArmBucket): TaskArmRewardSummary {
  const erroredCount = bucket.trials.filter((t) => t.errored).length;
  const missingRewardCount = bucket.trials.filter((t) => !t.errored && t.reward === null).length;

  const asZeroValues = usableRewardValues(bucket.trials, "errored-as-zero");
  const excludedValues = usableRewardValues(bucket.trials, "errored-excluded");

  return {
    taskName: bucket.taskName,
    arm: bucket.arm,
    attempts: bucket.trials.length,
    erroredCount,
    missingRewardCount,
    nErroredAsZero: asZeroValues.length,
    meanRewardErroredAsZero: asZeroValues.length > 0 ? mean(asZeroValues) : null,
    nErroredExcluded: excludedValues.length,
    meanRewardErroredExcluded: excludedValues.length > 0 ? mean(excludedValues) : null,
  };
}

function meanForPolicy(summary: TaskArmRewardSummary, policy: ErroredPolicy): number | null {
  return policy === "errored-as-zero" ? summary.meanRewardErroredAsZero : summary.meanRewardErroredExcluded;
}

// ── pass@1 (mean of per-task success rates) ─────────────────────────────────

export interface ArmPassAt1 {
  arm: string;
  policy: ErroredPolicy;
  /** Tasks with at least one usable trial under `policy`, contributing to the mean. This is also the bootstrap resample dimension for `ci` (`ci.n === nTasks`) — see `ci`'s doc comment for why. */
  nTasks: number;
  /** Tasks belonging to this arm with ZERO usable trials under `policy` (every attempt errored under "errored-excluded", or every attempt was missing-reward) — excluded from the mean, listed for disclosure rather than silently dropped. */
  excludedTasks: string[];
  /** Mean, across contributing tasks, of that task's per-arm reward mean. `null` when `nTasks === 0`. */
  passAt1: number | null;
  /**
   * Bootstrap CI over the PER-TASK MEANS that produce `passAt1` (never
   * individual trial-level attempts). This is the correct resampling unit:
   * attempts within one (task, arm) bucket are NOT independent draws — same
   * task, same difficulty, same environment — so resampling them directly
   * (as this module used to, in what is now `ArmRewardStats`'s explicitly
   * relabeled attempt-level dispersion statistic) is pseudo-replication and
   * produces a systematically too-narrow interval. `ci.n === nTasks`, so a
   * reader who sees "n=12" here knows it means 12 independent tasks, not 12
   * pooled attempts. `null` when `nTasks === 0`.
   */
  ci: BootstrapCI | null;
}

/** Compute one arm's pass@1 under one policy from its `TaskArmRewardSummary` rows, plus a bootstrap CI over the per-task means (see `ArmPassAt1.ci`). */
export function computePassAt1(
  summaries: readonly TaskArmRewardSummary[],
  arm: string,
  policy: ErroredPolicy,
  options: BootstrapOptions = {},
): ArmPassAt1 {
  const armSummaries = summaries.filter((s) => s.arm === arm);
  const perTaskMeans: number[] = [];
  const excludedTasks: string[] = [];
  for (const summary of armSummaries) {
    const value = meanForPolicy(summary, policy);
    if (value === null) excludedTasks.push(summary.taskName);
    else perTaskMeans.push(value);
  }
  excludedTasks.sort();
  return {
    arm,
    policy,
    nTasks: perTaskMeans.length,
    excludedTasks,
    passAt1: perTaskMeans.length > 0 ? mean(perTaskMeans) : null,
    ci: bootstrapMeanCI(perTaskMeans, options),
  };
}

// ── Per-arm ATTEMPT-LEVEL reward dispersion (trial-level; pseudo-replicated) ─

export interface ArmRewardStats {
  arm: string;
  policy: ErroredPolicy;
  /** Individual TRIAL-level attempts contributing, not tasks — see the caveat below. */
  n: number;
  /**
   * Bootstrap interval over individual TRIAL-level attempts, not over
   * independent tasks. When `n_attempts > 1`, the attempts within one
   * (task, arm) bucket are correlated (same task, same difficulty, same
   * environment) rather than i.i.d. draws, so resampling them directly is
   * PSEUDO-REPLICATION: the interval is systematically narrower than a
   * correctly-resampled one and must not be read as "the" confidence
   * interval on this arm's mean reward. That role belongs to
   * `ArmPassAt1.ci`, which bootstraps per-TASK means instead — always
   * prefer that one for a publishable interval. This statistic exists as a
   * separate, explicitly-labeled quantity: how much the raw attempt outcomes
   * within the arm vary, which is a real (if differently-interpreted)
   * property of the data, not a mistake to delete.
   */
  ci: BootstrapCI | null;
}

/**
 * Per-arm mean reward + bootstrap CI, resampling individual TRIAL-level
 * reward values. See `ArmRewardStats.ci`'s doc comment: this is an
 * attempt-level dispersion statistic, not a substitute for `ArmPassAt1.ci`
 * (which correctly resamples per-task means and is the one to publish).
 * Per-task-mean pairing across ARMS is handled separately by
 * `computePairedDelta`.
 */
export function computeArmRewardStats(
  records: readonly TrialRecord[],
  arm: string,
  policy: ErroredPolicy,
  options: BootstrapOptions = {},
): ArmRewardStats {
  const values = usableRewardValues(
    records.filter((r) => r.arm === arm),
    policy,
  );
  return { arm, policy, n: values.length, ci: bootstrapMeanCI(values, options) };
}

// ── Paired-by-task bootstrap delta between two arms ─────────────────────────

export interface PairedDelta {
  armA: string;
  armB: string;
  policy: ErroredPolicy;
  /** Tasks with a usable mean (under `policy`) in BOTH arms — the only valid pairing set (attempt-level pairing is impossible; see module docstring). */
  nTasksPaired: number;
  tasksOnlyInA: string[];
  tasksOnlyInB: string[];
  meanA: number | null;
  meanB: number | null;
  /** `meanA - meanB`, computed on the observed (non-resampled) per-task means. `null` when `nTasksPaired === 0`. */
  delta: number | null;
  /** Percentile CI of the resampled delta distribution. `null` when `nTasksPaired === 0`. */
  ci: BootstrapCI | null;
}

/**
 * Paired-by-task bootstrap: for each resample, draw TASK indices with
 * replacement (the SAME indices for both arms in that resample, preserving
 * the pairing), compute `mean(A_resampled) - mean(B_resampled)`, and collect
 * the resulting delta distribution. This is deliberately not a per-trial
 * bootstrap — Harbor gives no attempt index, so per-trial pairing across arms
 * cannot be constructed at all (module docstring).
 */
export function computePairedDelta(
  summaries: readonly TaskArmRewardSummary[],
  armA: string,
  armB: string,
  policy: ErroredPolicy,
  options: BootstrapOptions = {},
): PairedDelta {
  const meansA = new Map<string, number>();
  const meansB = new Map<string, number>();
  for (const summary of summaries) {
    const value = meanForPolicy(summary, policy);
    if (value === null) continue;
    if (summary.arm === armA) meansA.set(summary.taskName, value);
    else if (summary.arm === armB) meansB.set(summary.taskName, value);
  }

  const pairedTasks = [...meansA.keys()].filter((t) => meansB.has(t)).sort();
  const tasksOnlyInA = [...meansA.keys()].filter((t) => !meansB.has(t)).sort();
  const tasksOnlyInB = [...meansB.keys()].filter((t) => !meansA.has(t)).sort();

  if (pairedTasks.length === 0) {
    return {
      armA,
      armB,
      policy,
      nTasksPaired: 0,
      tasksOnlyInA,
      tasksOnlyInB,
      meanA: null,
      meanB: null,
      delta: null,
      ci: null,
    };
  }

  const aValues = pairedTasks.map((t) => meansA.get(t) as number);
  const bValues = pairedTasks.map((t) => meansB.get(t) as number);
  const observedMeanA = mean(aValues);
  const observedMeanB = mean(bValues);

  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const resamples = validateResamples(options.resamples);
  const alpha = validateAlpha(options.alpha);
  const rng = mulberry32(seed);
  const n = pairedTasks.length;
  const deltas: number[] = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let sumA = 0;
    let sumB = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      sumA += aValues[idx] as number;
      sumB += bValues[idx] as number;
    }
    deltas[i] = sumA / n - sumB / n;
  }
  deltas.sort((a, b) => a - b);

  return {
    armA,
    armB,
    policy,
    nTasksPaired: n,
    tasksOnlyInA,
    tasksOnlyInB,
    meanA: observedMeanA,
    meanB: observedMeanB,
    delta: observedMeanA - observedMeanB,
    ci: {
      mean: observedMeanA - observedMeanB,
      ciLow: quantileSorted(deltas, alpha / 2),
      ciHigh: quantileSorted(deltas, 1 - alpha / 2),
      n,
      resamples,
      seed,
      alpha,
    },
  };
}

// ── Symmetric-exclusion paired delta (harness/infra errors on EITHER arm) ───

export interface SymmetricPairedDelta {
  armA: string;
  armB: string;
  /** Tasks where NEITHER arm had any errored trial, and both arms produced a usable (non-errored, reward-bearing) mean — the only valid pairing set for this comparison. */
  nTasksPaired: number;
  /** Tasks dropped because at least one arm had >=1 errored trial on that task — listed, never silently absorbed into either arm's mean. Disjoint from `tasksOnlyInA`/`tasksOnlyInB`: a task can be present in both arms yet still excluded here for erroring in one of them. */
  tasksExcludedAnyArmErrored: string[];
  tasksOnlyInA: string[];
  tasksOnlyInB: string[];
  meanA: number | null;
  meanB: number | null;
  delta: number | null;
  ci: BootstrapCI | null;
}

/**
 * Paired-by-task delta with a THIRD, symmetric exclusion rule, distinct from
 * both `ErroredPolicy` values: a task is dropped from the comparison the
 * moment EITHER arm has any errored trial on it — regardless of policy.
 *
 * Why this is a separate function rather than a third `ErroredPolicy`:
 * `"errored-as-zero"` and `"errored-excluded"` are both PER-ARM policies —
 * they decide, arm by arm, how to fold that arm's own errored trials into
 * that arm's own mean. Neither one is symmetric across arms. A harness/infra
 * failure that can only occur on one arm (e.g. `AkmPluginNotLoadedError`,
 * which by construction cannot fire on a plain `opencode` control arm) then
 * produces a biased comparison either way:
 *
 *   - `errored-as-zero` scores the affected arm's task as 0 while the other
 *     arm keeps its real score — a harness failure reads as "the treatment
 *     failed the task".
 *   - `errored-excluded` drops the trial from the affected arm's numerator
 *     AND denominator but keeps every trial of the OTHER arm — the affected
 *     arm's mean is now computed over a non-random survivor subset (the
 *     tasks where the harness happened not to fail), which is survivorship
 *     bias in the favorable direction.
 *
 * This function instead drops the TASK from the paired comparison entirely
 * whenever either arm errored on it at all, so the delta is computed only
 * over tasks both arms actually completed cleanly. It does not replace the
 * two `ErroredPolicy` deltas (which remain useful, disclosed, differently-
 * biased cross-checks per decision D4) — it is an additional, explicitly
 * conservative comparison for exactly the case they both mishandle.
 */
export function computeSymmetricPairedDelta(
  summaries: readonly TaskArmRewardSummary[],
  armA: string,
  armB: string,
  options: BootstrapOptions = {},
): SymmetricPairedDelta {
  const byTaskA = new Map<string, TaskArmRewardSummary>();
  const byTaskB = new Map<string, TaskArmRewardSummary>();
  for (const summary of summaries) {
    if (summary.arm === armA) byTaskA.set(summary.taskName, summary);
    else if (summary.arm === armB) byTaskB.set(summary.taskName, summary);
  }

  const tasksOnlyInA = [...byTaskA.keys()].filter((t) => !byTaskB.has(t)).sort();
  const tasksOnlyInB = [...byTaskB.keys()].filter((t) => !byTaskA.has(t)).sort();

  const meansA = new Map<string, number>();
  const meansB = new Map<string, number>();
  const tasksExcludedAnyArmErrored: string[] = [];
  for (const [taskName, summaryA] of byTaskA) {
    const summaryB = byTaskB.get(taskName);
    if (!summaryB) continue; // handled by tasksOnlyInA above
    if (summaryA.erroredCount > 0 || summaryB.erroredCount > 0) {
      tasksExcludedAnyArmErrored.push(taskName);
      continue;
    }
    // Clean on both sides: `errored-excluded` and `errored-as-zero` agree
    // exactly when erroredCount is 0, so either accessor gives the same
    // value here. `errored-excluded`'s null case still applies (a task with
    // only missing-reward trials produces no usable mean) and must still
    // fall out of the pairing rather than being coerced to 0.
    if (summaryA.meanRewardErroredExcluded === null || summaryB.meanRewardErroredExcluded === null) continue;
    meansA.set(taskName, summaryA.meanRewardErroredExcluded);
    meansB.set(taskName, summaryB.meanRewardErroredExcluded);
  }
  tasksExcludedAnyArmErrored.sort();

  const pairedTasks = [...meansA.keys()].sort();
  if (pairedTasks.length === 0) {
    return {
      armA,
      armB,
      nTasksPaired: 0,
      tasksExcludedAnyArmErrored,
      tasksOnlyInA,
      tasksOnlyInB,
      meanA: null,
      meanB: null,
      delta: null,
      ci: null,
    };
  }

  const aValues = pairedTasks.map((t) => meansA.get(t) as number);
  const bValues = pairedTasks.map((t) => meansB.get(t) as number);
  const observedMeanA = mean(aValues);
  const observedMeanB = mean(bValues);

  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const resamples = validateResamples(options.resamples);
  const alpha = validateAlpha(options.alpha);
  const rng = mulberry32(seed);
  const n = pairedTasks.length;
  const deltas: number[] = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let sumA = 0;
    let sumB = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      sumA += aValues[idx] as number;
      sumB += bValues[idx] as number;
    }
    deltas[i] = sumA / n - sumB / n;
  }
  deltas.sort((a, b) => a - b);

  return {
    armA,
    armB,
    nTasksPaired: n,
    tasksExcludedAnyArmErrored,
    tasksOnlyInA,
    tasksOnlyInB,
    meanA: observedMeanA,
    meanB: observedMeanB,
    delta: observedMeanA - observedMeanB,
    ci: {
      mean: observedMeanA - observedMeanB,
      ciLow: quantileSorted(deltas, alpha / 2),
      ciHigh: quantileSorted(deltas, 1 - alpha / 2),
      n,
      resamples,
      seed,
      alpha,
    },
  };
}

// ── Token / cost per arm, with null-count disclosure ────────────────────────

export interface NullableNumericStats {
  /** Trials with a non-null value. */
  n: number;
  /** Trials with a null value — ALWAYS reported alongside `n`, never silently dropped from the denominator without a count attached. */
  nullCount: number;
  mean: number | null;
  sum: number;
}

export interface ArmTokenStats {
  arm: string;
  /** Total trials in the arm (== `nullCount + n` for every field below, by construction). */
  nTrials: number;
  inputTokens: NullableNumericStats;
  cacheTokens: NullableNumericStats;
  outputTokens: NullableNumericStats;
  costUsd: NullableNumericStats;
}

function summarizeNullable(values: readonly (number | null)[]): NullableNumericStats {
  const present = values.filter((v): v is number => v !== null);
  const sum = present.reduce((acc, v) => acc + v, 0);
  return {
    n: present.length,
    nullCount: values.length - present.length,
    mean: present.length > 0 ? sum / present.length : null,
    sum,
  };
}

export function computeArmTokenStats(records: readonly TrialRecord[], arm: string): ArmTokenStats {
  const armRecords = records.filter((r) => r.arm === arm);
  return {
    arm,
    nTrials: armRecords.length,
    inputTokens: summarizeNullable(armRecords.map((r) => r.tokens.inputTokens)),
    cacheTokens: summarizeNullable(armRecords.map((r) => r.tokens.cacheTokens)),
    outputTokens: summarizeNullable(armRecords.map((r) => r.tokens.outputTokens)),
    costUsd: summarizeNullable(armRecords.map((r) => r.tokens.costUsd)),
  };
}

// ── akm tool engagement ──────────────────────────────────────────────────────

export interface ArmToolUseStats {
  arm: string;
  /** Trials whose stdout trajectory was readable — the denominator for every rate below. */
  nWithTrajectory: number;
  /** Trials with NO readable trajectory (errored before writing one, or logs excluded). Never folded into a rate. */
  nWithoutTrajectory: number;
  /** Trials that called at least one `akm_*` tool. */
  nWithAkmCall: number;
  /** `nWithAkmCall / nWithTrajectory`, or null when nothing was readable. */
  akmEngagementRate: number | null;
  akmCalls: NullableNumericStats;
  totalCalls: NullableNumericStats;
  /** Per-tool call totals across the arm, e.g. `{akm_curate: 6, write: 10}`. */
  byTool: Record<string, number>;
}

/**
 * Did the model actually reach for akm in this arm?
 *
 * Deliberately separate from reward: a treatment arm can score identically to
 * baseline either because akm did not help or because the model never
 * consulted it, and only this distinguishes them. On a task the corpus built
 * to reward retrieval, a low engagement rate is the finding.
 */
export function computeArmToolUseStats(records: readonly TrialRecord[], arm: string): ArmToolUseStats {
  const armRecords = records.filter((r) => r.arm === arm);
  const withTrajectory = armRecords.filter((r) => r.toolUse.akmCalls !== null);
  const byTool: Record<string, number> = {};
  for (const record of armRecords) {
    for (const [tool, count] of Object.entries(record.toolUse.byTool)) {
      byTool[tool] = (byTool[tool] ?? 0) + count;
    }
  }
  const nWithAkmCall = withTrajectory.filter((r) => (r.toolUse.akmCalls ?? 0) > 0).length;
  return {
    arm,
    nWithTrajectory: withTrajectory.length,
    nWithoutTrajectory: armRecords.length - withTrajectory.length,
    nWithAkmCall,
    akmEngagementRate: withTrajectory.length > 0 ? nWithAkmCall / withTrajectory.length : null,
    akmCalls: summarizeNullable(armRecords.map((r) => r.toolUse.akmCalls)),
    totalCalls: summarizeNullable(armRecords.map((r) => r.toolUse.totalCalls)),
    byTool,
  };
}

// ── Top-level orchestration ──────────────────────────────────────────────────

export interface ArmSummary {
  arm: string;
  nTrials: number;
  nTasks: number;
  passAt1: Record<ErroredPolicy, ArmPassAt1>;
  rewardStats: Record<ErroredPolicy, ArmRewardStats>;
  tokenStats: ArmTokenStats;
  toolUseStats: ArmToolUseStats;
}

export interface AnalysisStats {
  arms: ArmSummary[];
  /** Full per-(task, arm) breakdown — the input `report.ts` groups by corpus metadata. */
  taskArmSummaries: TaskArmRewardSummary[];
  /** One entry per unordered arm pair (alphabetically ordered: `armA < armB`) per policy. */
  deltas: PairedDelta[];
  /** One entry per unordered arm pair — the symmetric-exclusion comparison (see `computeSymmetricPairedDelta`), which drops a task from BOTH arms whenever either one errored on it. */
  symmetricDeltas: SymmetricPairedDelta[];
  bootstrap: { seed: number; resamples: number; alpha: number };
}

/** Run every statistic in this module over a full set of trial records. This is what `report.ts` and the CLI consume. */
export function computeAnalysisStats(records: readonly TrialRecord[], options: BootstrapOptions = {}): AnalysisStats {
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const bootstrapOptions: BootstrapOptions = { seed, resamples, alpha };

  const buckets = bucketByTaskArm(records);
  const taskArmSummaries = buckets.map(summarizeTaskArmRewards);

  const arms = [...new Set(records.map((r) => r.arm))].sort();
  const armSummaries: ArmSummary[] = arms.map((arm) => {
    const armTrials = records.filter((r) => r.arm === arm);
    const nTasks = new Set(armTrials.map((r) => r.taskName)).size;
    const passAt1 = Object.fromEntries(
      ERRORED_POLICIES.map((policy) => [policy, computePassAt1(taskArmSummaries, arm, policy, bootstrapOptions)]),
    ) as Record<ErroredPolicy, ArmPassAt1>;
    const rewardStats = Object.fromEntries(
      ERRORED_POLICIES.map((policy) => [policy, computeArmRewardStats(records, arm, policy, bootstrapOptions)]),
    ) as Record<ErroredPolicy, ArmRewardStats>;
    return {
      arm,
      nTrials: armTrials.length,
      nTasks,
      passAt1,
      rewardStats,
      tokenStats: computeArmTokenStats(records, arm),
      toolUseStats: computeArmToolUseStats(records, arm),
    };
  });

  const deltas: PairedDelta[] = [];
  const symmetricDeltas: SymmetricPairedDelta[] = [];
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const armA = arms[i] as string;
      const armB = arms[j] as string;
      for (const policy of ERRORED_POLICIES) {
        deltas.push(computePairedDelta(taskArmSummaries, armA, armB, policy, bootstrapOptions));
      }
      symmetricDeltas.push(computeSymmetricPairedDelta(taskArmSummaries, armA, armB, bootstrapOptions));
    }
  }

  return { arms: armSummaries, taskArmSummaries, deltas, symmetricDeltas, bootstrap: { seed, resamples, alpha } };
}
