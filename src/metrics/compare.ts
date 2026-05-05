/**
 * akm-bench compare metrics (§8).
 */

// ── Compare (§8, two-run diff) ─────────────────────────────────────────────

/**
 * Sign marker for delta rendering. `improve` / `regress` / `flat` are
 * direction labels; the markdown layer turns them into ▲ / ▼ / ▬. Kept as
 * a tagged label rather than the literal glyphs so JSON consumers don't have
 * to deal with non-ASCII.
 */
export type DeltaSign = "improve" | "regress" | "flat";

/**
 * One row of the per-task compare table. `baseMetrics` and `currentMetrics`
 * carry through the §13.3 per-task envelopes verbatim (snake-case keys
 * preserved) so the JSON consumer can read seed-stdev, budget-exceeded
 * counts, etc., without re-parsing the source reports.
 *
 * `id` may be present in only one side — `presence` distinguishes
 * "regression" rows (in both) from "added" / "removed" rows.
 */
export interface CompareTaskRow {
  id: string;
  /** Where this task appears: in both reports, only the base, or only the current. */
  presence: "both" | "base-only" | "current-only";
  /** Per-task metrics from the base report. `null` when the task is current-only. */
  baseMetrics: PerTaskJson | null;
  /** Per-task metrics from the current report. `null` when the task is base-only. */
  currentMetrics: PerTaskJson | null;
  /** akm pass_rate delta, current − base. `null` when one side is missing. */
  delta: { passRate: number | null; tokensPerPass: number | null; wallclockMs: number | null };
  /** Direction marker for `passRate`: `flat` when within tolerance or unmeasured. */
  signMarker: DeltaSign;
}

/** Snake-case per-task envelope as serialised by `renderUtilityReport`. */
export interface PerTaskJson {
  pass_rate: number;
  pass_at_1: 0 | 1;
  tokens_per_pass: number | null;
  wallclock_ms: number;
  pass_rate_stdev: number;
  budget_exceeded_count: number;
  harness_error_count: number;
  count: number;
}

/**
 * Aggregate (corpus-wide) compare row. Same null-safety as `CorpusDelta`:
 * `tokensPerPassDelta` is `null` when either side lacks a measurement.
 */
export interface CompareAggregate {
  passRateDelta: number;
  passRateSign: DeltaSign;
  tokensPerPassDelta: number | null;
  tokensPerPassSign: DeltaSign;
  wallclockMsDelta: number;
  wallclockMsSign: DeltaSign;
}

/**
 * Successful compare envelope. The CLI renders this as JSON when `--json` is
 * passed and as markdown otherwise.
 */
export interface CompareReportSuccess {
  ok: true;
  baseModel: string;
  currentModel: string;
  baseFixtureContentHash: string | null;
  currentFixtureContentHash: string | null;
  /** Warnings collected during compare (e.g. missing fixtureContentHash on a side). */
  warnings: string[];
  aggregate: CompareAggregate;
  perTask: CompareTaskRow[];
}

/** Failure envelope. `reason` is the discrete refusal cause; `message` is human-readable. */
export interface CompareReportFailure {
  ok: false;
  reason: "model_mismatch" | "hash_mismatch" | "corpus_mismatch" | "schema_mismatch" | "track_mismatch";
  message: string;
  baseModel?: string;
  currentModel?: string;
  baseFixtureContentHash?: string | null;
  currentFixtureContentHash?: string | null;
  /** When `reason === "hash_mismatch"`, the affected fixtures (best-effort). */
  affectedFixtures?: string[];
  /** #250 — task corpus hashes when `reason === "corpus_mismatch"`. */
  baseTaskCorpusHash?: string | null;
  currentTaskCorpusHash?: string | null;
  /** #250 — selected task IDs that diverge between base and current. */
  baseSelectedTaskIds?: string[];
  currentSelectedTaskIds?: string[];
}

/**
 * Caller-controlled overrides for `compareReports` (#250). When both flags
 * are false (the default), the comparator refuses mismatched corpora /
 * fixtures. Setting a flag converts the corresponding refusal into a
 * warning so an operator can still inspect a cross-corpus or cross-fixture
 * diff when they explicitly opt in.
 */
export interface CompareOptions {
  /** When true, accept mismatched task IDs / `taskCorpusHash`; emit a warning instead. */
  allowCorpusMismatch?: boolean;
  /** When true, accept mismatched `fixtureContentHash`; emit a warning instead. */
  allowFixtureMismatch?: boolean;
}

export type CompareResult = CompareReportSuccess | CompareReportFailure;

/**
 * Sign threshold below which a delta is rendered as `flat`. `pass_rate` is
 * normalised to `[0, 1]`, so a 0.005 (0.5pp) tolerance keeps tiny K-seed
 * sampling jitter from looking like a regression.
 */
const PASS_RATE_FLAT_TOLERANCE = 0.005;
/** `tokens_per_pass` and `wallclock_ms` use raw counts; 0 is the only "flat". */
const COUNT_FLAT_TOLERANCE = 0;

function classifyPassRate(delta: number | null): DeltaSign {
  if (delta === null) return "flat";
  if (Math.abs(delta) <= PASS_RATE_FLAT_TOLERANCE) return "flat";
  return delta > 0 ? "improve" : "regress";
}

function classifyCount(delta: number | null, lowerIsBetter: boolean): DeltaSign {
  if (delta === null) return "flat";
  if (Math.abs(delta) <= COUNT_FLAT_TOLERANCE) return "flat";
  if (lowerIsBetter) return delta < 0 ? "improve" : "regress";
  return delta > 0 ? "improve" : "regress";
}

/**
 * Minimal structural shape we read out of a parsed UtilityRunReport JSON.
 * We deliberately don't import the renderer's own types — the compare layer
 * consumes JSON envelopes from disk, so it needs to be tolerant of small
 * shape drift (e.g. the optional `fixtureContentHash` Wave A may add).
 */
export interface ParsedReportJson {
  schemaVersion?: number;
  track?: string;
  agent?: { harness?: string; model?: string };
  corpus?: {
    domains?: number;
    tasks?: number;
    slice?: string;
    seedsPerArm?: number;
    fixtureContentHash?: string | null;
    /** #250 — stable-sorted list of task IDs the run selected. */
    selectedTaskIds?: string[];
    /** #250 — deterministic hash over `selectedTaskIds` + per-task body bytes. */
    taskCorpusHash?: string | null;
    /** #250 — per-fixture content hash (fixture name → sha256 hex). */
    fixtures?: Record<string, string>;
  };
  aggregate?: {
    noakm?: { pass_rate?: number; tokens_per_pass?: number | null; wallclock_ms?: number };
    akm?: { pass_rate?: number; tokens_per_pass?: number | null; wallclock_ms?: number };
    delta?: { pass_rate?: number; tokens_per_pass?: number | null; wallclock_ms?: number };
  };
  tasks?: Array<{
    id: string;
    noakm?: PerTaskJson;
    akm?: PerTaskJson;
    delta?: { pass_rate?: number; tokens_per_pass?: number | null; wallclock_ms?: number };
  }>;
  warnings?: string[];
}

function readModel(r: ParsedReportJson): string {
  return r.agent?.model ?? "<unknown>";
}

function readFixtureHash(r: ParsedReportJson): string | null {
  const v = r.corpus?.fixtureContentHash;
  return v === undefined || v === null ? null : v;
}

function readTaskCorpusHash(r: ParsedReportJson): string | null {
  const v = r.corpus?.taskCorpusHash;
  return v === undefined || v === null ? null : v;
}

function readSelectedTaskIds(r: ParsedReportJson): string[] | null {
  const v = r.corpus?.selectedTaskIds;
  return Array.isArray(v) ? v : null;
}

function arraysEqualIgnoringOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return false;
  return true;
}

function akmAgg(r: ParsedReportJson): { pass_rate: number; tokens_per_pass: number | null; wallclock_ms: number } {
  const a = r.aggregate?.akm ?? {};
  return {
    pass_rate: a.pass_rate ?? 0,
    tokens_per_pass: a.tokens_per_pass ?? null,
    wallclock_ms: a.wallclock_ms ?? 0,
  };
}

/**
 * Diff two parsed UtilityRunReport JSONs.
 *
 * Refusal cases:
 *   • Either side missing `schemaVersion: 1` or `track: "utility"` →
 *     `schema_mismatch` / `track_mismatch`.
 *   • `agent.model` differs → `model_mismatch`.
 *   • Both sides report a `corpus.fixtureContentHash` and they differ →
 *     `hash_mismatch`. Missing hash on either side proceeds with a warning
 *     (Wave A may add it; older reports won't have it).
 *
 * On success the per-task table includes rows for every task in either side,
 * plus aggregate deltas computed against the akm arm only (the noakm arm is
 * the control — its delta is meaningless). `pass_rate` is in `[0, 1]`,
 * higher is better; `tokens_per_pass` and `wallclock_ms` are counts, lower
 * is better.
 */
export function compareReports(
  base: ParsedReportJson,
  current: ParsedReportJson,
  options: CompareOptions = {},
): CompareResult {
  // Schema-version gate.
  if (base.schemaVersion !== 1 || current.schemaVersion !== 1) {
    return {
      ok: false,
      reason: "schema_mismatch",
      message: `compare requires schemaVersion=1 on both sides; got base=${String(
        base.schemaVersion,
      )}, current=${String(current.schemaVersion)}`,
    };
  }
  // Track gate. Cross-track diffs are nonsensical.
  if (base.track !== "utility" || current.track !== "utility") {
    return {
      ok: false,
      reason: "track_mismatch",
      message: `compare only supports track="utility"; got base="${String(base.track)}", current="${String(
        current.track,
      )}"`,
    };
  }

  const baseModel = readModel(base);
  const currentModel = readModel(current);
  if (baseModel !== currentModel) {
    return {
      ok: false,
      reason: "model_mismatch",
      message: `cannot compare across different models: base="${baseModel}", current="${currentModel}". Rerun on the same model.`,
      baseModel,
      currentModel,
    };
  }

  const baseHash = readFixtureHash(base);
  const currentHash = readFixtureHash(current);
  const warnings: string[] = [];

  // #250 — task corpus hash + selected task IDs. Refused unless either side
  // is legacy (missing the hash) or the operator passed
  // `allowCorpusMismatch`. Legacy reports (no taskCorpusHash) degrade to a
  // warning so older artefacts can still be diffed.
  const baseTaskHash = readTaskCorpusHash(base);
  const currentTaskHash = readTaskCorpusHash(current);
  const baseIds = readSelectedTaskIds(base);
  const currentIds = readSelectedTaskIds(current);
  if (baseTaskHash !== null && currentTaskHash !== null && baseTaskHash !== currentTaskHash) {
    if (!options.allowCorpusMismatch) {
      return {
        ok: false,
        reason: "corpus_mismatch",
        message: `cannot compare across different task corpora: base taskCorpusHash="${baseTaskHash}", current="${currentTaskHash}". Rerun against the same task selection or pass --allow-corpus-mismatch to override.`,
        baseModel,
        currentModel,
        baseTaskCorpusHash: baseTaskHash,
        currentTaskCorpusHash: currentTaskHash,
        ...(baseIds ? { baseSelectedTaskIds: baseIds } : {}),
        ...(currentIds ? { currentSelectedTaskIds: currentIds } : {}),
      };
    }
    warnings.push(
      `task corpus hashes differ (base="${baseTaskHash}", current="${currentTaskHash}") — diff requested via --allow-corpus-mismatch`,
    );
  } else if (
    baseTaskHash === null &&
    currentTaskHash === null &&
    baseIds !== null &&
    currentIds !== null &&
    !arraysEqualIgnoringOrder(baseIds, currentIds)
  ) {
    // Both sides legacy (no taskCorpusHash) but both expose selectedTaskIds
    // and they differ. We can still detect a mismatched corpus from the ID
    // list alone — refuse unless the operator opted in.
    if (!options.allowCorpusMismatch) {
      return {
        ok: false,
        reason: "corpus_mismatch",
        message: `cannot compare across different selected task IDs. Rerun against the same task selection or pass --allow-corpus-mismatch to override.`,
        baseModel,
        currentModel,
        baseSelectedTaskIds: baseIds,
        currentSelectedTaskIds: currentIds,
      };
    }
    warnings.push("selected task IDs differ — diff requested via --allow-corpus-mismatch");
  }
  if (baseTaskHash === null)
    warnings.push("base report has no corpus.taskCorpusHash; proceeding without task-corpus-pin check");
  if (currentTaskHash === null)
    warnings.push("current report has no corpus.taskCorpusHash; proceeding without task-corpus-pin check");

  if (baseHash !== null && currentHash !== null && baseHash !== currentHash) {
    if (!options.allowFixtureMismatch) {
      return {
        ok: false,
        reason: "hash_mismatch",
        message: `cannot compare across different fixture-content hashes: base="${baseHash}", current="${currentHash}". Rerun against matching fixtures or pass --allow-fixture-mismatch to override.`,
        baseModel,
        currentModel,
        baseFixtureContentHash: baseHash,
        currentFixtureContentHash: currentHash,
      };
    }
    warnings.push(
      `fixture-content hashes differ (base="${baseHash}", current="${currentHash}") — diff requested via --allow-fixture-mismatch`,
    );
  }
  if (baseHash === null)
    warnings.push("base report has no corpus.fixtureContentHash; proceeding without fixture-pin check");
  if (currentHash === null)
    warnings.push("current report has no corpus.fixtureContentHash; proceeding without fixture-pin check");

  // Aggregate (akm arm is the one that matters — noakm is the control).
  const ba = akmAgg(base);
  const ca = akmAgg(current);
  const passRateDelta = ca.pass_rate - ba.pass_rate;
  const tokensPerPassDelta =
    ba.tokens_per_pass === null || ca.tokens_per_pass === null ? null : ca.tokens_per_pass - ba.tokens_per_pass;
  const wallclockMsDelta = ca.wallclock_ms - ba.wallclock_ms;

  const aggregate: CompareAggregate = {
    passRateDelta,
    passRateSign: classifyPassRate(passRateDelta),
    tokensPerPassDelta,
    tokensPerPassSign: classifyCount(tokensPerPassDelta, true),
    wallclockMsDelta,
    wallclockMsSign: classifyCount(wallclockMsDelta, true),
  };

  // Per-task rows. Outer-join on task id.
  const baseTasks = new Map<string, NonNullable<ParsedReportJson["tasks"]>[number]>();
  for (const t of base.tasks ?? []) baseTasks.set(t.id, t);
  const currentTasks = new Map<string, NonNullable<ParsedReportJson["tasks"]>[number]>();
  for (const t of current.tasks ?? []) currentTasks.set(t.id, t);

  const allIds = new Set<string>();
  for (const id of baseTasks.keys()) allIds.add(id);
  for (const id of currentTasks.keys()) allIds.add(id);

  const perTask: CompareTaskRow[] = [];
  for (const id of [...allIds].sort()) {
    const b = baseTasks.get(id);
    const c = currentTasks.get(id);
    const bM = b?.akm ?? null;
    const cM = c?.akm ?? null;
    const presence: CompareTaskRow["presence"] =
      b !== undefined && c !== undefined ? "both" : b !== undefined ? "base-only" : "current-only";

    const passRateDelta_ = bM !== null && cM !== null ? cM.pass_rate - bM.pass_rate : null;
    const tokensPerPassDelta_ =
      bM !== null && cM !== null && bM.tokens_per_pass !== null && cM.tokens_per_pass !== null
        ? cM.tokens_per_pass - bM.tokens_per_pass
        : null;
    const wallclockMsDelta_ = bM !== null && cM !== null ? cM.wallclock_ms - bM.wallclock_ms : null;

    perTask.push({
      id,
      presence,
      baseMetrics: bM,
      currentMetrics: cM,
      delta: { passRate: passRateDelta_, tokensPerPass: tokensPerPassDelta_, wallclockMs: wallclockMsDelta_ },
      signMarker: classifyPassRate(passRateDelta_),
    });
  }

  return {
    ok: true,
    baseModel,
    currentModel,
    baseFixtureContentHash: baseHash,
    currentFixtureContentHash: currentHash,
    warnings,
    aggregate,
    perTask,
  };
}
