/**
 * akm-bench `evolve` — Track B longitudinal three-phase runner (spec §4 + §6.4).
 *
 * `runEvolve()` orchestrates three phases against a single eval-domain corpus:
 *
 *   • Phase 1 (signal accumulation): run K seeds × tasks (train slice only)
 *     under the akm arm, then record `akm feedback <gold_ref> --positive` /
 *     `--negative` events per outcome.
 *   • Phase 2 (evolve): for every asset whose negative feedback crosses the
 *     threshold, invoke `akm distill` and `akm reflect`, validate every
 *     resulting proposal via `akm proposal show --json`, then accept or
 *     reject per lint outcome. After processing, rebuild the index.
 *   • Phase 3 (re-evaluate): run the eval slice under THREE arms — `pre` (the
 *     original un-evolved fixture), `post` (the evolved fixture), `synthetic`
 *     (no stash, scratchpad-only "Bring Your Own Skills" prompt).
 *
 * Leakage prevention (spec §7.4): before invoking distill we pass
 * `--exclude-tags slice:eval` so eval-slice feedback never enters distill's
 * LLM input. Phase 1 feedback is tagged with `slice:train`, so train signal
 * remains available even when train/eval share a gold ref.
 *
 * Test seams: every external interaction is funnelled through one of three
 * injectable functions:
 *   - `spawn` — forwarded to `runOne` (drives the agent harness).
 *   - `akmCli(args, cwd, env)` — invoked for every `akm <verb>` subprocess.
 *   - `materialiseStash` — when false, `runUtility` doesn't touch
 *     `fixtures/stashes/`.
 * Tests inject fakes; production wires the real `Bun.spawnSync` and the
 * real `loadFixtureStash`.
 */

import fs from "node:fs";
import { resolveAkmCommand } from "./akm-command";
import { registerCleanup } from "./cleanup";
import type { TaskMetadata, TaskSlice } from "./corpus";
import {
  computeLessonMetrics,
  computePostTaskLessonLineage,
  type LessonMetrics,
  type PostTaskLessonLineage,
} from "./evolve-metrics";
import { writeOpencodeJson } from "./environment";
import { type LoadedFixtureStash, loadFixtureStash } from "./fixture-stash";
import {
  computeFeedbackIntegrity,
  computeLongitudinalMetrics,
  computeProposalQualityMetrics,
  type FeedbackIntegrityMetrics,
  type LongitudinalMetrics,
  type ProposalLogEntry,
  type ProposalQualityMetrics,
} from "./metrics";
import type { LoadedOpencodeConfig } from "./opencode-config";
import type { UtilityRunReport } from "./report";
import { runUtility } from "./runner";
import type { SpawnFn } from "./support/agent";
import { benchMkdtemp } from "./tmp";

const PHASE2_REFLECT_CONSTRAINED_TASK =
  "Apply a single-issue patch only; preserve frontmatter, schema, and ids; avoid unrelated rewrites; output must satisfy proposal lint.";

const PHASE2_REFLECT_LINT_REPAIR_TASK =
  "Fix proposal lint issues only; preserve frontmatter/schema/ids; keep a minimal diff.";

const PHASE2_REFLECT_RETRY_TASK =
  "Apply a minimal targeted fix for the repeated-failure signal only; preserve frontmatter/schema/ids; avoid broad rewrites; keep changes under 12 lines.";

const PHASE2_REFLECT_TIMEOUT_MS = 180000;
const AKM_COMMAND_WATCHDOG_MS = 120000;
const PHASE2_REFLECT_RETRY_DISABLE_THRESHOLD_MS = 240000;
const PHASE2_REFLECT_RETRY_TIMEOUT_MS = 120000;
const PHASE2_SKIP_REFLECT_ON_ALL_NEGATIVE = true;

/** Result of an `akm` subprocess invocation. */
export interface AkmCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Subprocess seam — run `akm <args>` with the given cwd + env. */
export type AkmCliFn = (args: string[], cwd: string, env: Record<string, string>) => Promise<AkmCliResult>;

/** Caller-facing options for `runEvolve`. */
export interface RunEvolveOptions {
  tasks: TaskMetadata[];
  model: string;
  /** K seeds per arm. Defaults to 5. */
  seedsPerArm?: number;
  /** Token budget per run. Defaults to 30000. */
  budgetTokens?: number;
  /** Wallclock budget per run in ms. Defaults to 600000. */
  budgetWallMs?: number;
  /**
   * Phase 2 reflect timeout in ms. Defaults to 180000 and is intentionally
   * independent from per-run agent budgetWallMs.
   */
  phase2ReflectTimeoutMs?: number;
  /** Toggle Phase 2 distill/reflect/proposal processing. Defaults to true. */
  phase2Enabled?: boolean;
  /** Retry timeout for Phase 2 reflect timeout-retries. Defaults to 120000ms. */
  phase2ReflectRetryTimeoutMs?: number;
  /**
   * Stability guard: skip initial Phase 2 reflect when a ref has all-negative
   * Phase 1 feedback and crossed the absolute threshold (positive=0,
   * negative>=threshold.absoluteCount). Defaults to true.
   */
  phase2SkipReflectOnAllNegative?: boolean;
  /** Injected agent-spawn for tests. */
  spawn?: SpawnFn;
  /** Injected akm subprocess for tests. */
  akmCli?: AkmCliFn;
  /**
   * Threshold for promoting an asset to proposal generation. An asset
   * crosses the threshold iff `negative >= absoluteCount` OR
   * `negative / (negative + positive) > ratio`. Defaults: `{ absoluteCount: 2,
   * ratio: 0.5 }`.
   */
  negativeThreshold?: { absoluteCount: number; ratio: number };
  /**
   * Test seam: when false, `runUtility` does not materialise fixture stashes.
   * Defaults to true. Real runs always materialise.
   */
  materialiseStash?: boolean;
  /** Override timestamp (tests). */
  timestamp?: string;
  /** Override branch (tests). */
  branch?: string;
  /** Override commit (tests). */
  commit?: string;
  /**
   * Pre-loaded opencode provider config. Loaded ONCE by the CLI and forwarded
   * into every `runUtility` phase (Phase 1, Phase 3 pre/post/synthetic).
   * When omitted, the per-run `OPENCODE_CONFIG` dir is left empty.
   */
  opencodeProviders?: LoadedOpencodeConfig;
}

/** One Phase-1 feedback event the runner emitted (or attempted). */
export interface FeedbackLogEntry {
  taskId: string;
  seed: number;
  goldRef: string;
  signal: "positive" | "negative";
  /** True when the akmCli invocation exited 0. */
  ok: boolean;
}

/** Phase 1 diagnostics surfaced in evolve reports. */
export interface Phase1Diagnostics {
  /** Per-ref feedback totals accumulated from Phase 1 runs. */
  perRefFeedback: Array<{ ref: string; positive: number; negative: number }>;
  /** Refs promoted to Phase 2 distill/reflect after thresholding. */
  refsToEvolve: string[];
}

export interface TimedPhase {
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
}

export interface TimedAkmCommand {
  phase: "phase1" | "phase2";
  command: string;
  args: string[];
  elapsedMs: number;
  exitCode: number;
  watchdogExceeded: boolean;
}

export interface EvolvePhaseTimings {
  phase1: TimedPhase;
  phase2: TimedPhase;
  phase3: TimedPhase & {
    arms: {
      preElapsedMs: number;
      postElapsedMs: number;
      syntheticElapsedMs: number;
    };
  };
  totalElapsedMs: number;
  akmCommands: TimedAkmCommand[];
}

/** Aggregate evolve report. Renders to JSON + markdown via `renderEvolveReport`. */
export interface EvolveRunReport {
  timestamp: string;
  branch: string;
  commit: string;
  model: string;
  /**
   * Slice-or-domain label stamped into the §13.3 envelope's `corpus.slice`
   * for each arm. Evolve always runs the eval slice for arms; we mirror
   * `runUtility`'s convention.
   */
  domain: string;
  seedsPerArm: number;
  /** Phase 1 feedback events recorded. */
  feedbackLog: FeedbackLogEntry[];
  /** Phase 1 per-ref totals + promoted refs (additive diagnostics). */
  phase1Diagnostics: Phase1Diagnostics;
  /** Phase + per-command timings for timeout attribution. */
  phaseTimings: EvolvePhaseTimings;
  /** Phase 2 proposal events recorded. */
  proposalLog: ProposalLogEntry[];
  /** Aggregate proposal-quality metrics. */
  proposals: ProposalQualityMetrics;
  /**
   * Per-lesson quality + reuse metrics (#264). One row per `kind === "lesson"`
   * proposal, joined to the post-arm `assetsLoaded` stream for reuse stats and
   * to the pre-arm runs for negative-transfer attribution. Always present —
   * `lessons.lessons` is `[]` when no lesson-kind proposals were generated.
   */
  lessons: LessonMetrics;
  /** Minimal warm/post task lineage for generated lessons that fired. */
  lessonLineage: PostTaskLessonLineage;
  /** Aggregate longitudinal metrics. */
  longitudinal: LongitudinalMetrics;
  /**
   * Feedback-signal integrity 2x2 confusion matrix (§6.8). Joins each
   * Phase 1 feedback event to the akm-arm run that produced it (per
   * `feedbackLog[i].taskId`/`seed`) and labels TP/FP/TN/FN per the run's
   * outcome. Computed by `computeFeedbackIntegrity`.
   */
  feedbackIntegrity: FeedbackIntegrityMetrics;
  /**
   * Phase 1 utility report (akm arm only, train slice). Exposed so
   * downstream metrics like `computeFeedbackIntegrity` can join feedback
   * events back to the run that produced them. Additive in the report
   * envelope.
   */
  phase1: UtilityRunReport;
  /** Phase 3 arm reports. Each is a §13.3-shape utility report. */
  arms: { pre: UtilityRunReport; post: UtilityRunReport; synthetic: UtilityRunReport };
  /** Operator-visible warnings. */
  warnings: string[];
}

/**
 * Per-asset feedback aggregate computed at the end of Phase 1. The threshold
 * check operates on this struct.
 */
interface FeedbackCounts {
  positive: number;
  negative: number;
}

/**
 * Drive the three-phase Track B runner.
 *
 * Pre: `tasks` is already filtered to one domain (or `all`). The runner
 * partitions internally on `task.slice`.
 *
 * Sandboxing: at the start of every real run the runner materialises one
 * dedicated tmp stash per fixture (the `evolveStash`) plus a fresh sibling
 * snapshot per fixture (the `preStash`). Phase 1 + Phase 2 pin
 * `AKM_STASH_DIR` to the appropriate `evolveStash` for every spawned `akm`
 * invocation; Phase 3's pre arm uses `preStash`, the post arm uses
 * `evolveStash`, and the synthetic arm uses no stash. The operator's real
 * `process.env.AKM_STASH_DIR` is never read or written by `runEvolve`. All
 * stashes are cleaned up in a top-level try/finally.
 */
export async function runEvolve(options: RunEvolveOptions): Promise<EvolveRunReport> {
  const seedsPerArm = options.seedsPerArm ?? 5;
  const budgetTokens = options.budgetTokens ?? 30000;
  const budgetWallMs = options.budgetWallMs ?? 600000;
  const phase2ReflectTimeoutMs = resolvePhase2ReflectTimeoutMs(options.phase2ReflectTimeoutMs);
  const phase2ReflectRetryTimeoutMs = resolvePhase2ReflectRetryTimeoutMs(options.phase2ReflectRetryTimeoutMs);
  const phase2Enabled = options.phase2Enabled ?? true;
  const phase2SkipReflectOnAllNegative = options.phase2SkipReflectOnAllNegative ?? PHASE2_SKIP_REFLECT_ON_ALL_NEGATIVE;
  const negativeThreshold = options.negativeThreshold ?? { absoluteCount: 2, ratio: 0.5 };
  const materialiseStash = options.materialiseStash ?? true;
  const akmCli = options.akmCli ?? defaultAkmCli;
  const warnings: string[] = [];

  const trainTasks = options.tasks.filter((t) => effectiveSlice(t) === "train");
  const evalTasks = options.tasks.filter((t) => effectiveSlice(t) === "eval");

  const uniqueTrainGoldRefs = new Set(
    trainTasks
      .map((t) => t.goldRef)
      .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0),
  );
  if (uniqueTrainGoldRefs.size < 2) {
    warnings.push(
      `preflight: low train gold_ref diversity (${uniqueTrainGoldRefs.size} unique ref(s)); evolve Phase 2 may overfit or produce unstable proposal quality metrics`,
    );
  }

  // Use the first task's domain (or "all") as the corpus label. The CLI
  // already filtered to one domain; this is just for the report header.
  const domain = uniqueDomain(options.tasks);

  // ── Sandbox setup: per-fixture evolveStash + preStash. ───────────────────
  // We materialise one tmp stash per unique `task.stash` so Phase 1
  // accumulates feedback into the same on-disk stash that Phase 2 mutates,
  // and that Phase 3's post arm reads back. The operator's real
  // AKM_STASH_DIR is never touched. The pre arm gets a fresh snapshot of
  // the same starting fixture (no Phase 2 mutations applied).
  const fixtureNames = new Set<string>();
  for (const t of options.tasks) fixtureNames.add(t.stash);

  const evolveStashes = new Map<string, LoadedFixtureStash>();
  const preStashes = new Map<string, LoadedFixtureStash>();
  const evolveDirByFixture = new Map<string, string>();
  const preDirByFixture = new Map<string, string>();
  const preCacheDirByFixture = new Map<string, string>();
  /** Per-fixture XDG_CACHE_HOME dirs allocated for evolve-stash indexing. */
  const evolveCacheDirByFixture = new Map<string, string>();
  const phase2XdgConfigRoot = benchMkdtemp("akm-evolve-xdg-config-");
  const phase2OpencodeConfigRoot = options.opencodeProviders ? benchMkdtemp("akm-evolve-opencode-") : undefined;
  const phase2OpencodeConfigPath = phase2OpencodeConfigRoot ? `${phase2OpencodeConfigRoot}/opencode.json` : undefined;

  if (phase2OpencodeConfigRoot) {
    writeOpencodeJson(phase2OpencodeConfigRoot, options.model, options.opencodeProviders);
  }

  // SIGINT trap (#267): every per-fixture stash registers its cleanup with
  // the shared registry so an external Ctrl-C reaps the tmp dirs even when
  // the top-level try/finally never runs. We deregister in the matching
  // finally block before invoking the synchronous cleanup so the handler
  // doesn't double-fire.
  const stashDeregistrations: Array<() => void> = [];

  if (materialiseStash) {
    for (const name of fixtureNames) {
      try {
        const evolved = loadFixtureStash(name, { skipIndex: false });
        evolveStashes.set(name, evolved);
        evolveDirByFixture.set(name, evolved.stashDir);
        evolveCacheDirByFixture.set(name, benchMkdtemp(`akm-evolve-cache-${name}-`));
        stashDeregistrations.push(
          registerCleanup(() => {
            try {
              evolved.cleanup();
            } catch {
              /* swallow */
            }
          }),
        );
      } catch (err) {
        warnings.push(`evolve: failed to materialise evolve stash for fixture "${name}": ${(err as Error).message}`);
      }
      try {
        const pre = loadFixtureStash(name, { skipIndex: false });
        preStashes.set(name, pre);
        preDirByFixture.set(name, pre.stashDir);
        if (pre.indexCacheHome) preCacheDirByFixture.set(name, pre.indexCacheHome);
        stashDeregistrations.push(
          registerCleanup(() => {
            try {
              pre.cleanup();
            } catch {
              /* swallow */
            }
          }),
        );
      } catch (err) {
        warnings.push(`evolve: failed to materialise pre stash for fixture "${name}": ${(err as Error).message}`);
      }
    }
  }

  // Resolve the evolveStash dir for a given asset ref. We map ref → fixture
  // by looking up which task's gold ref it matches; if no task owns it (or
  // multiple do, which is unusual), we fall back to the first available
  // evolveStash. The simple — and most common — case is a single fixture
  // per `--tasks <domain>` invocation.
  const refToFixture = new Map<string, string>();
  for (const t of options.tasks) {
    if (t.goldRef) refToFixture.set(t.goldRef, t.stash);
  }
  const fallbackEvolveDir = [...evolveDirByFixture.values()][0];
  const fallbackEvolveCacheDir = [...evolveCacheDirByFixture.values()][0];
  const opencodeConfigPath = phase2OpencodeConfigPath;
  const phase2AkmConfigTemplate = loadPhase2AkmConfigTemplate();
  function phase2XdgConfigHome(scope: string, stashDir?: string): string {
    const dir = `${phase2XdgConfigRoot}/${sanitizePathComponent(scope)}`;
    fs.mkdirSync(dir, { recursive: true });
    const akmDir = `${dir}/akm`;
    fs.mkdirSync(akmDir, { recursive: true });
    const config = JSON.parse(JSON.stringify(phase2AkmConfigTemplate)) as Record<string, unknown>;
    if (stashDir && stashDir.length > 0) config.stashDir = stashDir;
    if (!config.agent || typeof config.agent !== "object") {
      config.agent = { default: "opencode" };
    } else {
      const agent = config.agent as Record<string, unknown>;
      if (typeof agent.default !== "string" || agent.default.trim().length === 0) {
        agent.default = "opencode";
      }
    }
    fs.writeFileSync(`${akmDir}/config.json`, JSON.stringify(config, null, 2), { mode: 0o600 });
    return dir;
  }
  function envForRef(ref: string | undefined): Record<string, string> {
    const baseEnv = { ...(process.env as Record<string, string>) };
    if (!materialiseStash) {
      // Tests opt out of fixture materialisation entirely; we still strip
      // the operator's AKM_STASH_DIR so the fake CLI sees a known sentinel.
      delete baseEnv.AKM_STASH_DIR;
      if (opencodeConfigPath) baseEnv.OPENCODE_CONFIG = opencodeConfigPath;
      return baseEnv;
    }
    const fixture = ref ? refToFixture.get(ref) : undefined;
    const dir = (fixture && evolveDirByFixture.get(fixture)) ?? fallbackEvolveDir;
    const cacheDir = (fixture && evolveCacheDirByFixture.get(fixture)) ?? fallbackEvolveCacheDir;
    if (dir) baseEnv.AKM_STASH_DIR = dir;
    else delete baseEnv.AKM_STASH_DIR;
    if (cacheDir) baseEnv.XDG_CACHE_HOME = cacheDir;
    // Forward the opencode config path so `akm reflect` (which spawns
    // `opencode run`) can find the LLM provider configuration.
    if (opencodeConfigPath) baseEnv.OPENCODE_CONFIG = opencodeConfigPath;
    return baseEnv;
  }

  const runStartedAtMs = Date.now();
  let phase1StartedAtMs = runStartedAtMs;
  let phase1EndedAtMs = runStartedAtMs;
  let phase2StartedAtMs = runStartedAtMs;
  let phase2EndedAtMs = runStartedAtMs;
  let phase3StartedAtMs = runStartedAtMs;
  let phase3EndedAtMs = runStartedAtMs;
  let phase3PreElapsedMs = 0;
  let phase3PostElapsedMs = 0;
  let phase3SyntheticElapsedMs = 0;
  const akmCommandTimings: TimedAkmCommand[] = [];

  async function invokeAkm(
    phase: "phase1" | "phase2",
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<AkmCliResult> {
    const startedAtMs = Date.now();
    const result = await akmCli(args, cwd, env);
    const elapsedMs = Date.now() - startedAtMs;
    const command = args[0] ?? "unknown";
    const watchdogExceeded = elapsedMs > AKM_COMMAND_WATCHDOG_MS;
    akmCommandTimings.push({
      phase,
      command,
      args: args.slice(),
      elapsedMs,
      exitCode: result.exitCode,
      watchdogExceeded,
    });
    process.stderr.write(
      `[evolve] ${phase} akm ${command} exit=${result.exitCode} elapsed_ms=${elapsedMs}${watchdogExceeded ? " watchdog_exceeded" : ""}\n`,
    );
    if (watchdogExceeded) {
      warnings.push(`watchdog: ${phase} akm ${command} exceeded ${AKM_COMMAND_WATCHDOG_MS}ms (${elapsedMs}ms)`);
    }
    return result;
  }

  // ── Phase 1 pre-flight: copy pre-built index into each evolve cache. ──────
  // `loadFixtureStash` already populated `stash.indexCacheHome` with the
  // pre-built FTS5 index (from `__akm_index__/`). We copy it into the
  // dedicated `evolveCacheDirByFixture` so `akmCli` feedback/distill calls
  // find the DB in the right place — no `akm index` spawn needed.
  if (materialiseStash) {
    process.stderr.write(`[evolve] copying pre-built indexes for ${evolveDirByFixture.size} fixture(s)\n`);
    for (const [fixtureName, stash] of evolveStashes) {
      const cacheDir = evolveCacheDirByFixture.get(fixtureName);
      if (!cacheDir) continue;
      if (stash.indexCacheHome) {
        try {
          copyDirRecursiveSync(stash.indexCacheHome, cacheDir);
          process.stderr.write(`[evolve] index copied: ${fixtureName}\n`);
        } catch (err) {
          warnings.push(`evolve: failed to copy index for "${fixtureName}": ${(err as Error).message}`);
        }
      } else {
        warnings.push(`evolve: no pre-built index for "${fixtureName}" — Phase 1 feedback may be degraded`);
      }
    }
  }

  let preReport: UtilityRunReport;
  let postReport: UtilityRunReport;
  let syntheticReport: UtilityRunReport;
  let phase1Report: UtilityRunReport;
  const feedbackLog: FeedbackLogEntry[] = [];
  const phase1FeedbackByRef = new Map<string, FeedbackCounts>();
  const refsToEvolve: string[] = [];
  const proposalLog: ProposalLogEntry[] = [];
  const repairedRefs = new Set<string>();

  try {
    // ── Phase 1: accumulate signal on the train slice (akm arm only). ─────
    phase1StartedAtMs = Date.now();
    phase1Report = await runUtility({
      tasks: trainTasks,
      arms: ["akm"],
      model: options.model,
      seedsPerArm,
      budgetTokens,
      budgetWallMs,
      slice: "train",
      ...(options.spawn ? { spawn: options.spawn } : {}),
      // We pre-materialised the per-fixture evolve stash above; tell the
      // runner to forward those dirs and skip its own per-task materialise.
      materialiseStash,
      ...(materialiseStash ? { stashDirByFixture: evolveDirByFixture } : {}),
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
      ...(options.opencodeProviders ? { opencodeProviders: options.opencodeProviders } : {}),
    });
    process.stderr.write(`[evolve] Phase 1 complete: ${phase1Report.akmRuns?.length ?? 0} akm run(s)\n`);

    // Issue feedback events per (task, seed) outcome on the akm arm.
    const phase1Cwd = options.tasks[0]?.taskDir ?? process.cwd();
    for (const run of phase1Report.akmRuns ?? []) {
      const taskMeta = options.tasks.find((t) => t.id === run.taskId);
      const goldRef = taskMeta?.goldRef;
      if (!goldRef) continue;
      if (run.outcome === "harness_error") continue;
      const signal: "positive" | "negative" = run.outcome === "pass" ? "positive" : "negative";
      const args = [
        "feedback",
        goldRef,
        signal === "positive" ? "--positive" : "--negative",
        "--tag",
        `slice:${taskMeta?.slice ?? "train"}`,
      ];
      // Wrap in try/catch so a single throwing akmCli (e.g. subprocess
      // crash) cannot leave `feedbackByRef` partially populated and let
      // Phase 2 proceed on corrupt state.
      try {
        const cliResult = await invokeAkm("phase1", args, phase1Cwd, envForRef(goldRef));
        feedbackLog.push({ taskId: run.taskId, seed: run.seed, goldRef, signal, ok: cliResult.exitCode === 0 });
        if (cliResult.exitCode !== 0) {
          warnings.push(`phase1: akm feedback for ${goldRef} (${signal}) failed: ${cliResult.stderr.trim()}`);
        }
      } catch (err) {
        feedbackLog.push({ taskId: run.taskId, seed: run.seed, goldRef, signal, ok: false });
        warnings.push(`phase1.feedback_dispatch_failed: ${goldRef} ${(err as Error).message}`);
      }
      const counts = phase1FeedbackByRef.get(goldRef) ?? { positive: 0, negative: 0 };
      if (signal === "positive") counts.positive += 1;
      else counts.negative += 1;
      phase1FeedbackByRef.set(goldRef, counts);
    }
    phase1EndedAtMs = Date.now();

    // ── Phase 2: evolve. ────────────────────────────────────────────────────
    phase2StartedAtMs = Date.now();
    for (const [ref, counts] of phase1FeedbackByRef.entries()) {
      if (crossesNegativeThreshold(counts, negativeThreshold)) refsToEvolve.push(ref);
    }
    refsToEvolve.sort();

    if (phase2Enabled) {
      // §7.4 leakage prevention (#267): Phase 1 feedback is tagged with
      // `slice:train`. Distill excludes `slice:eval` tags so eval feedback
      // never leaks into the LLM input while preserving train feedback.
      for (const ref of refsToEvolve) {
      const counts = phase1FeedbackByRef.get(ref) ?? { positive: 0, negative: 0 };
      const fixtureName = refToFixture.get(ref) ?? "default";
      const phase2StashDir = evolveDirByFixture.get(fixtureName);
      const evolveEnv: Record<string, string> = {
        ...envForRef(ref),
        XDG_CONFIG_HOME: phase2XdgConfigHome(`phase2-${fixtureName}`, phase2StashDir),
      };

      const distillArgs = [
        "distill",
        ref,
        "--exclude-tags",
        "slice:eval",
      ];
      const distillResult = await invokeAkm("phase2", distillArgs, phase1Cwd, evolveEnv);
      if (distillResult.exitCode !== 0) {
        warnings.push(`phase2: akm distill ${ref} failed: ${distillResult.stderr.trim()}`);
      }
      if (phase2SkipReflectOnAllNegative && isAllNegativeThresholdRef(counts, negativeThreshold.absoluteCount)) {
        warnings.push(
          `phase2.reflect_skipped_all_negative: akm reflect ${ref} skipped (positive=0 negative=${counts.negative} threshold=${negativeThreshold.absoluteCount})`,
        );
        continue;
      }
      const reflectArgs = [
        "reflect",
        ref,
        "--task",
        PHASE2_REFLECT_CONSTRAINED_TASK,
        "--timeout-ms",
        String(phase2ReflectTimeoutMs),
      ];
      const reflectResult = await invokeAkm("phase2", reflectArgs, phase1Cwd, evolveEnv);
      if (reflectResult.exitCode !== 0) {
        const reflectFailure = summariseAkmFailure(reflectResult);
        if (isLikelyTimeoutFailure(reflectFailure)) {
          if (phase2ReflectRetryTimeoutMs >= PHASE2_REFLECT_RETRY_DISABLE_THRESHOLD_MS) {
            warnings.push(
              `phase2.reflect_retry_skipped: akm reflect ${ref} timed out and retry is disabled for retry timeout >= ${PHASE2_REFLECT_RETRY_DISABLE_THRESHOLD_MS}ms`,
            );
            warnings.push(`phase2: akm reflect ${ref} skipped/failed: ${reflectFailure}`);
            continue;
          }
          warnings.push(
            `phase2.reflect_retry_timeout: akm reflect ${ref} timed out; retrying once with narrower task and timeout ${phase2ReflectRetryTimeoutMs}ms`,
          );
          const retryReflectResult = await invokeAkm(
            "phase2",
            [
              "reflect",
              ref,
              "--task",
              PHASE2_REFLECT_RETRY_TASK,
              "--timeout-ms",
              String(phase2ReflectRetryTimeoutMs),
            ],
            phase1Cwd,
            evolveEnv,
          );
          if (retryReflectResult.exitCode !== 0) {
            warnings.push(`phase2: akm reflect ${ref} skipped/failed: ${summariseAkmFailure(retryReflectResult)}`);
          }
          continue;
        }
        // `reflect` requires `agent.default` to be configured — a missing
        // config is non-fatal for the bench; we record and continue.
        warnings.push(`phase2: akm reflect ${ref} skipped/failed: ${reflectFailure}`);
      }
      }

      // Walk the proposal queue per fixture (each evolveStash has its own
      // proposal log on disk). When we materialised stashes we iterate every
      // fixture that produced proposals; in the common single-fixture case
      // this is one pass.
      const proposalFixtures = materialiseStash ? [...evolveDirByFixture.keys()] : [undefined];
      for (const fixtureName of proposalFixtures) {
      let acceptedCountForFixture = 0;
      const proposalEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
      if (materialiseStash && fixtureName) {
        const dir = evolveDirByFixture.get(fixtureName);
        if (dir) proposalEnv.AKM_STASH_DIR = dir;
        const cacheDir = evolveCacheDirByFixture.get(fixtureName);
        if (cacheDir) proposalEnv.XDG_CACHE_HOME = cacheDir;
        proposalEnv.XDG_CONFIG_HOME = phase2XdgConfigHome(`phase2-${fixtureName}`, dir);
      } else if (!materialiseStash) {
        delete proposalEnv.AKM_STASH_DIR;
        proposalEnv.XDG_CONFIG_HOME = phase2XdgConfigHome("phase2-default");
      }
      const fixtureLabel = fixtureName ?? "default";
      const listResult = await invokeAkm("phase2", ["proposal", "list", "--json"], phase1Cwd, proposalEnv);
      if (listResult.exitCode !== 0) {
        const stderr = listResult.stderr.trim() || "<empty stderr>";
        warnings.push(
          `phase2: akm proposal list --json failed for fixture "${fixtureLabel}" (exit ${listResult.exitCode}); skipping this fixture's proposal queue. stderr: ${stderr}`,
        );
        continue;
      }
      const processedProposalIds = new Set<string>();
      const queue = parseProposalList(listResult.stdout);
      while (queue.length > 0) {
        const p = queue.shift();
        if (!p || processedProposalIds.has(p.id)) continue;
        processedProposalIds.add(p.id);
        const showResult = await invokeAkm("phase2", ["proposal", "show", p.id, "--json"], phase1Cwd, proposalEnv);
        if (showResult.exitCode !== 0) {
          const stderr = showResult.stderr.trim() || "<empty stderr>";
          const showFailureReason = `proposal show failed (exit ${showResult.exitCode}): ${stderr}`;
          const rejectResult = await invokeAkm(
            "phase2",
            ["proposal", "reject", p.id, "--reason", showFailureReason],
            phase1Cwd,
            proposalEnv,
          );
          warnings.push(`phase2: proposal ${p.id} rejected due to show command failure: ${showFailureReason}`);
          proposalLog.push({
            proposalId: p.id,
            assetRef: p.assetRef,
            kind: p.kind,
            lintPass: false,
            decision: "reject",
            rejectReason: showFailureReason,
          });
          if (rejectResult.exitCode !== 0) {
            warnings.push(`phase2: akm proposal reject ${p.id} failed after show failure: ${rejectResult.stderr.trim()}`);
          }
          continue;
        }

        const showInfo = parseProposalShow(showResult.stdout);
        if (showInfo.status === "lint_pass") {
          const acceptResult = await invokeAkm("phase2", ["proposal", "accept", p.id], phase1Cwd, proposalEnv);
          if (acceptResult.exitCode === 0) acceptedCountForFixture += 1;
          proposalLog.push({
            proposalId: p.id,
            assetRef: p.assetRef,
            kind: p.kind,
            lintPass: true,
            decision: acceptResult.exitCode === 0 ? "accept" : "reject",
            ...(acceptResult.exitCode === 0 ? {} : { rejectReason: `accept failed: ${acceptResult.stderr.trim()}` }),
          });
        } else {
          const reason =
            showInfo.status === "lint_fail"
              ? showInfo.message ?? "lint failed"
              : showInfo.status === "show_error"
                ? showInfo.message ?? "proposal show error"
                : showInfo.message ?? "proposal show parse error";
          const rejectReason =
            showInfo.status === "lint_fail"
              ? `lint failed: ${reason}`
              : showInfo.status === "show_error"
                ? `proposal show failed: ${reason}`
                : `proposal show parse error: ${reason}`;

          if (showInfo.status === "lint_fail" && !repairedRefs.has(p.assetRef)) {
            repairedRefs.add(p.assetRef);
            const repairReflectResult = await invokeAkm(
              "phase2",
              [
                "reflect",
                p.assetRef,
                "--task",
                PHASE2_REFLECT_LINT_REPAIR_TASK,
                "--timeout-ms",
                String(phase2ReflectTimeoutMs),
              ],
              phase1Cwd,
              proposalEnv,
            );
            if (repairReflectResult.exitCode !== 0) {
              warnings.push(`phase2: lint-repair reflect ${p.assetRef} failed: ${summariseAkmFailure(repairReflectResult)}`);
            }

            const refreshedListResult = await invokeAkm(
              "phase2",
              ["proposal", "list", "--json"],
              phase1Cwd,
              proposalEnv,
            );
            if (refreshedListResult.exitCode !== 0) {
              const stderr = refreshedListResult.stderr.trim() || "<empty stderr>";
              warnings.push(
                `phase2: akm proposal list --json refresh failed for fixture "${fixtureLabel}" after lint repair on ${p.assetRef} (exit ${refreshedListResult.exitCode}); stderr: ${stderr}`,
              );
            } else {
              const refreshed = parseProposalList(refreshedListResult.stdout);
              for (const candidate of refreshed) {
                if (candidate.assetRef !== p.assetRef) continue;
                if (processedProposalIds.has(candidate.id)) continue;
                queue.push(candidate);
              }
            }
          }

          const rejectResult = await invokeAkm(
            "phase2",
            ["proposal", "reject", p.id, "--reason", rejectReason],
            phase1Cwd,
            proposalEnv,
          );
          if (showInfo.status === "show_error" || showInfo.status === "parse_error") {
            warnings.push(
              `phase2: proposal ${p.id} rejected due to ${showInfo.status === "show_error" ? "show error" : "show parse error"}: ${reason}`,
            );
          }
          proposalLog.push({
            proposalId: p.id,
            assetRef: p.assetRef,
            kind: p.kind,
            lintPass: false,
            decision: "reject",
            rejectReason,
          });
          if (rejectResult.exitCode !== 0) {
            warnings.push(`phase2: akm proposal reject ${p.id} failed: ${rejectResult.stderr.trim()}`);
          }
        }
      }

      // Rebuild the index so accepted lessons surface in Phase 3.
      // Only needed when at least one proposal was accepted — if all were
      // rejected (or none generated) the index is unchanged.
      if (acceptedCountForFixture > 0) {
        process.stderr.write(`[evolve] rebuilding index after ${acceptedCountForFixture} accepted proposal(s) for ${fixtureLabel}\n`);
        const indexResult = await invokeAkm("phase2", ["index"], phase1Cwd, proposalEnv);
        if (indexResult.exitCode !== 0) {
          warnings.push(`phase2: akm index rebuild failed: ${indexResult.stderr.trim()}`);
        }
      } else {
        process.stderr.write(`[evolve] skipping index rebuild — 0 accepted proposals\n`);
      }
      }
    } else {
      warnings.push("phase2: disabled by config (phase2Enabled=false); skipping distill/reflect/proposal/index");
    }
    phase2EndedAtMs = Date.now();

    // ── Phase 3: re-evaluate (eval slice). ─────────────────────────────────
    // pre arm: fresh snapshot of the starting fixture (no Phase 2 mutations
    // applied). post arm: the mutated evolveStash so accepted lessons reach
    // the eval slice. synthetic arm: no stash.
    phase3StartedAtMs = Date.now();
    const phase3PreStartedAtMs = Date.now();
    preReport = await runUtility({
      tasks: evalTasks,
      arms: ["akm"],
      model: options.model,
      seedsPerArm,
      budgetTokens,
      budgetWallMs,
      slice: "eval",
      ...(options.spawn ? { spawn: options.spawn } : {}),
      materialiseStash,
      ...(materialiseStash ? { stashDirByFixture: preDirByFixture } : {}),
      ...(materialiseStash ? { indexCacheHomeByFixture: preCacheDirByFixture } : {}),
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
      ...(options.opencodeProviders ? { opencodeProviders: options.opencodeProviders } : {}),
    });
    phase3PreElapsedMs = Date.now() - phase3PreStartedAtMs;

    const phase3PostStartedAtMs = Date.now();
    postReport = await runUtility({
      tasks: evalTasks,
      arms: ["akm"],
      model: options.model,
      seedsPerArm,
      budgetTokens,
      budgetWallMs,
      slice: "eval",
      // Stamp arm metadata so spawn fakes can distinguish pre-vs-post via
      // an env probe. We thread it via a fresh `spawn` wrapper when one
      // was supplied.
      materialiseStash,
      ...(materialiseStash ? { stashDirByFixture: evolveDirByFixture } : {}),
      ...(materialiseStash ? { indexCacheHomeByFixture: evolveCacheDirByFixture } : {}),
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
      ...(options.spawn ? { spawn: wrapSpawnWithArm(options.spawn, "post") } : {}),
      ...(options.opencodeProviders ? { opencodeProviders: options.opencodeProviders } : {}),
    });
    phase3PostElapsedMs = Date.now() - phase3PostStartedAtMs;

    // synthetic: no stash. We pass a spawn wrapper that strips
    // AKM_STASH_DIR and injects the "Bring Your Own Skills" tag so test
    // fakes (and a future real harness) can branch. #267 — also forward a
    // per-task scratchpad prompt via the runner's `buildPrompt` seam so the
    // synthetic arm actually exercises the BYOS prompt path rather than
    // relying on the noakm default.
    const phase3SyntheticStartedAtMs = Date.now();
    syntheticReport = await runUtility({
      tasks: evalTasks,
      arms: ["akm"],
      model: options.model,
      seedsPerArm,
      budgetTokens,
      budgetWallMs,
      slice: "eval",
      materialiseStash: false,
      buildPrompt: (task, _arm) => buildSyntheticPrompt(task.id),
      ...(options.timestamp ? { timestamp: options.timestamp } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.commit ? { commit: options.commit } : {}),
      ...(options.spawn ? { spawn: wrapSpawnWithArm(options.spawn, "synthetic", undefined, true) } : {}),
      ...(options.opencodeProviders ? { opencodeProviders: options.opencodeProviders } : {}),
    });
    phase3SyntheticElapsedMs = Date.now() - phase3SyntheticStartedAtMs;
    phase3EndedAtMs = Date.now();
  } finally {
    // Deregister BEFORE running cleanup so a SIGINT during teardown
    // doesn't double-fire the cleanup fns (per cleanup.ts contract).
    for (const deregister of stashDeregistrations) deregister();
    for (const s of evolveStashes.values()) {
      try {
        s.cleanup();
      } catch {
        /* swallow — best-effort tmp cleanup */
      }
    }
    for (const s of preStashes.values()) {
      try {
        s.cleanup();
      } catch {
        /* swallow — best-effort tmp cleanup */
      }
    }
    if (phase2OpencodeConfigRoot) {
      try {
        fs.rmSync(phase2OpencodeConfigRoot, { recursive: true, force: true });
      } catch {
        /* swallow — best-effort tmp cleanup */
      }
    }
    try {
      fs.rmSync(phase2XdgConfigRoot, { recursive: true, force: true });
    } catch {
      /* swallow — best-effort tmp cleanup */
    }
  }

  // ── Compute aggregates. ──────────────────────────────────────────────────
  const proposalsMetrics = computeProposalQualityMetrics(proposalLog);
  const longitudinal = computeLongitudinalMetrics(preReport, postReport, syntheticReport);
  const feedbackIntegrity = computeFeedbackIntegrity({ phase1: phase1Report, feedbackLog });
  // #264 — lesson quality + reuse metrics. The runner doesn't (yet) read
  // accepted lesson bodies off disk or load verifier source text; we pass
  // empty maps so the leakage check defaults to "low" until the read seam
  // lands. Reuse + negative-transfer attribution work today off the
  // pre/post arm `assetsLoaded` stream.
  const lessons = computeLessonMetrics({
    proposalLog,
    feedbackLog,
    preRuns: preReport.akmRuns ?? [],
    postRuns: postReport.akmRuns ?? [],
  });
  const lessonLineage = computePostTaskLessonLineage({
    lessons,
    postRuns: postReport.akmRuns ?? [],
  });
  const phaseTimings: EvolvePhaseTimings = {
    phase1: {
      startedAt: new Date(phase1StartedAtMs).toISOString(),
      endedAt: new Date(phase1EndedAtMs).toISOString(),
      elapsedMs: Math.max(0, phase1EndedAtMs - phase1StartedAtMs),
    },
    phase2: {
      startedAt: new Date(phase2StartedAtMs).toISOString(),
      endedAt: new Date(phase2EndedAtMs).toISOString(),
      elapsedMs: Math.max(0, phase2EndedAtMs - phase2StartedAtMs),
    },
    phase3: {
      startedAt: new Date(phase3StartedAtMs).toISOString(),
      endedAt: new Date(phase3EndedAtMs).toISOString(),
      elapsedMs: Math.max(0, phase3EndedAtMs - phase3StartedAtMs),
      arms: {
        preElapsedMs: phase3PreElapsedMs,
        postElapsedMs: phase3PostElapsedMs,
        syntheticElapsedMs: phase3SyntheticElapsedMs,
      },
    },
    totalElapsedMs: Math.max(0, Date.now() - runStartedAtMs),
    akmCommands: akmCommandTimings,
  };

  return {
    timestamp: options.timestamp ?? new Date().toISOString(),
    branch: options.branch ?? preReport.branch,
    commit: options.commit ?? preReport.commit,
    model: options.model,
    domain,
    seedsPerArm,
    feedbackLog,
    phase1Diagnostics: {
      perRefFeedback: [...phase1FeedbackByRef.entries()]
        .map(([ref, counts]) => ({ ref, positive: counts.positive, negative: counts.negative }))
        .sort((a, b) => a.ref.localeCompare(b.ref)),
      refsToEvolve: refsToEvolve.slice(),
    },
    phaseTimings,
    proposalLog,
    proposals: proposalsMetrics,
    lessons,
    lessonLineage,
    longitudinal,
    feedbackIntegrity,
    phase1: phase1Report,
    arms: { pre: preReport, post: postReport, synthetic: syntheticReport },
    warnings: [
      ...warnings,
      ...phase1Report.warnings,
      ...preReport.warnings,
      ...postReport.warnings,
      ...syntheticReport.warnings,
    ],
  };
}

/**
 * Default subprocess invoker — runs the resolved `akm` CLI in `cwd` with the
 * supplied env. Real runs use this; tests inject a fake.
 */
async function defaultAkmCli(args: string[], cwd: string, env: Record<string, string>): Promise<AkmCliResult> {
  const proc = Bun.spawnSync({
    cmd: [...resolveAkmCommand(), ...args],
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
  const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
  return { exitCode: proc.exitCode ?? -1, stdout, stderr };
}

/**
 * Threshold check: an asset crosses the negative threshold if either the
 * absolute negative count meets `absoluteCount` OR the negative *ratio* among
 * total feedback exceeds `ratio`. Either branch is sufficient — both are
 * spec-mandated defaults.
 */
function crossesNegativeThreshold(
  counts: FeedbackCounts,
  threshold: { absoluteCount: number; ratio: number },
): boolean {
  if (counts.negative >= threshold.absoluteCount) return true;
  const total = counts.positive + counts.negative;
  if (total === 0) return false;
  return counts.negative / total > threshold.ratio;
}

/** Best-effort partition. Honours explicit `slice:` and falls back to id-hash. */
function effectiveSlice(task: TaskMetadata): TaskSlice {
  if (task.slice) return task.slice;
  // Mirror corpus.effectiveSlice — SHA-1 first byte parity.
  // We avoid the import cycle by inlining the trivial fallback.
  let h = 0;
  for (let i = 0; i < task.id.length; i += 1) h = (h * 31 + task.id.charCodeAt(i)) | 0;
  return Math.abs(h) % 2 === 0 ? "train" : "eval";
}

function uniqueDomain(tasks: TaskMetadata[]): string {
  const set = new Set(tasks.map((t) => t.domain));
  if (set.size === 1) return [...set][0] ?? "all";
  return "all";
}

/**
 * Wrap a spawn fake so every child sees `BENCH_EVOLVE_ARM=<arm>` (and
 * `BENCH_EVOLVE_SCRATCHPAD=1` for the synthetic arm). Used by Phase 3 so
 * test fakes can distinguish the three arms without us having to expose a
 * `prompt` override on `runUtility`. Real production runs receive the same
 * env keys; the real `runAgent` harness ignores them.
 */
function wrapSpawnWithArm(inner: SpawnFn, arm: "post" | "synthetic", stashDir?: string, scratchpad = false): SpawnFn {
  return (cmd, opts) => {
    const env: Record<string, string> = { ...(opts.env ?? {}) };
    env.BENCH_EVOLVE_ARM = arm;
    if (scratchpad) env.BENCH_EVOLVE_SCRATCHPAD = "1";
    if (stashDir) env.AKM_STASH_DIR = stashDir;
    if (arm === "synthetic") delete env.AKM_STASH_DIR;
    return inner(cmd, { ...opts, env });
  };
}

/** Lightweight proposal record extracted from `akm proposal list --json`. */
interface ProposalListEntry {
  id: string;
  assetRef: string;
  kind: ProposalLogEntry["kind"];
}

/** Tolerant parser for `akm proposal list --json` stdout. */
function parseProposalList(stdout: string): ProposalListEntry[] {
  if (!stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { proposals?: unknown[] }).proposals)
      ? (parsed as { proposals: unknown[] }).proposals
      : [];
  const out: ProposalListEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : null;
    const assetRef =
      typeof rec.target_ref === "string"
        ? rec.target_ref
        : typeof rec.targetRef === "string"
          ? rec.targetRef
          : typeof rec.ref === "string"
            ? rec.ref
            : null;
    const kindRaw = typeof rec.kind === "string" ? rec.kind : typeof rec.source === "string" ? rec.source : "unknown";
    const kind: ProposalLogEntry["kind"] =
      kindRaw === "lesson" || kindRaw === "distill"
        ? "lesson"
        : kindRaw === "revision" || kindRaw === "reflect"
          ? "revision"
          : "unknown";
    if (!id || !assetRef) continue;
    out.push({ id, assetRef, kind });
  }
  return out;
}

/** Parsed lint outcome from `akm proposal show <id> --json`. */
interface ParsedProposalShow {
  status: "lint_pass" | "lint_fail" | "show_error" | "parse_error";
  message?: string;
}

function parseProposalShow(stdout: string): ParsedProposalShow {
  if (!stdout.trim()) {
    return { status: "parse_error", message: "empty proposal show output" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    const rawPreview = compactOneLine(stdout, 200);
    return {
      status: "parse_error",
      message: `invalid JSON (${(err as Error).message}); raw=${rawPreview}`,
    };
  }

  if (parsed.ok === false) {
    const showErrorParts: string[] = [];
    const code = asText(parsed.code);
    const error = asText(parsed.error);
    const message = asText(parsed.message);
    const details = asText(parsed.details);
    if (code) showErrorParts.push(`code=${code}`);
    if (error) showErrorParts.push(`error=${error}`);
    if (message) showErrorParts.push(`message=${message}`);
    if (details) showErrorParts.push(`details=${details}`);
    return {
      status: "show_error",
      message: showErrorParts.length > 0 ? showErrorParts.join("; ") : "ok=false from proposal show",
    };
  }

  const lintPass =
    parsed.lint_pass === true ||
    parsed.lintPass === true ||
    (typeof parsed.validation === "object" &&
      parsed.validation !== null &&
      (parsed.validation as Record<string, unknown>).ok === true) ||
    (typeof parsed.lint === "object" && parsed.lint !== null && (parsed.lint as Record<string, unknown>).pass === true);
  const lintMessage = buildLintDiagnostics(parsed);

  if (lintPass) return { status: "lint_pass", ...(lintMessage ? { message: lintMessage } : {}) };
  return { status: "lint_fail", ...(lintMessage ? { message: lintMessage } : {}) };
}

function buildLintDiagnostics(parsed: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const topLevelMessage = asText(parsed.message);
  if (topLevelMessage) parts.push(topLevelMessage);

  const lintRaw = parsed.lint;
  if (lintRaw && typeof lintRaw === "object") {
    const lint = lintRaw as Record<string, unknown>;
    const lintMessage = asText(lint.message) ?? asText(lint.error) ?? asText(lint.summary);
    if (lintMessage) parts.push(lintMessage);

    const issues = lint.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      for (let idx = 0; idx < issues.length; idx += 1) {
        const issueText = formatLintIssue(issues[idx]);
        if (issueText) parts.push(`issue_${idx + 1}=${issueText}`);
      }
    }
  }

  const validationRaw = parsed.validation;
  if (validationRaw && typeof validationRaw === "object") {
    const validation = validationRaw as Record<string, unknown>;
    const validationMessage = asText(validation.message) ?? asText(validation.error) ?? asText(validation.summary);
    if (validationMessage) parts.push(validationMessage);

    const findings = validation.findings;
    if (Array.isArray(findings) && findings.length > 0) {
      for (let idx = 0; idx < findings.length; idx += 1) {
        const findingText = formatLintIssue(findings[idx]);
        if (findingText) parts.push(`issue_${idx + 1}=${findingText}`);
      }
    }
  }

  if (parts.length === 0) return undefined;
  return parts.join("; ");
}

function formatLintIssue(issue: unknown): string | undefined {
  if (typeof issue === "string") return compactOneLine(issue, 180);
  if (!issue || typeof issue !== "object") return asText(issue);

  const rec = issue as Record<string, unknown>;
  const message = asText(rec.message) ?? asText(rec.error);
  const rule = asText(rec.rule) ?? asText(rec.ruleId) ?? asText(rec.code);
  const severity = asText(rec.severity) ?? asText(rec.level);
  const file = asText(rec.path) ?? asText(rec.file) ?? asText(rec.filePath);
  const line = asInteger(rec.line);
  const column = asInteger(rec.column) ?? asInteger(rec.col);
  const location =
    file || line !== undefined || column !== undefined
      ? `@${file ?? "<unknown>"}${line !== undefined ? `:${line}` : ""}${column !== undefined ? `:${column}` : ""}`
      : undefined;

  const pieces: string[] = [];
  if (severity) pieces.push(`[${severity}]`);
  if (rule) pieces.push(rule);
  if (location) pieces.push(location);
  if (message) pieces.push(message);
  if (pieces.length > 0) return compactOneLine(pieces.join(" "), 220);

  try {
    return compactOneLine(JSON.stringify(issue), 220);
  } catch {
    return undefined;
  }
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const compact = compactOneLine(value, 240);
    return compact.length > 0 ? compact : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function compactOneLine(value: string, maxLen: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, Math.max(0, maxLen - 3))}...`;
}

function sanitizePathComponent(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned.length > 0 ? cleaned : "default";
}

function loadPhase2AkmConfigTemplate(): Record<string, unknown> {
  const candidate = `${process.env.HOME ?? ""}/.config/akm/config.json`;
  if (candidate.length > 0 && fs.existsSync(candidate)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // ignore and fall through to minimal template
    }
  }
  return { agent: { default: "opencode" } };
}

function summariseAkmFailure(result: AkmCliResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return compactOneLine(stderr, 400);

  const stdout = result.stdout.trim();
  if (!stdout) return `<empty stderr/stdout; exit ${result.exitCode}>`;
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (parsed.ok === false) {
      const parts = [asText(parsed.reason), asText(parsed.error), asText(parsed.code)].filter(
        (part): part is string => typeof part === "string" && part.length > 0,
      );
      if (parts.length > 0) return parts.join("; ");
    }
  } catch {
    // fall through to raw preview
  }
  return compactOneLine(stdout, 400);
}

function resolvePhase2ReflectTimeoutMs(value: number | undefined): number {
  if (value === undefined) return PHASE2_REFLECT_TIMEOUT_MS;
  if (!Number.isFinite(value)) return PHASE2_REFLECT_TIMEOUT_MS;
  const normalized = Math.trunc(value);
  if (normalized < 1) return PHASE2_REFLECT_TIMEOUT_MS;
  return normalized;
}

function resolvePhase2ReflectRetryTimeoutMs(value: number | undefined): number {
  if (value === undefined) return PHASE2_REFLECT_RETRY_TIMEOUT_MS;
  if (!Number.isFinite(value)) return PHASE2_REFLECT_RETRY_TIMEOUT_MS;
  const normalized = Math.trunc(value);
  if (normalized < 1) return PHASE2_REFLECT_RETRY_TIMEOUT_MS;
  return normalized;
}

function isAllNegativeThresholdRef(counts: FeedbackCounts, thresholdAbsoluteCount: number): boolean {
  return counts.positive === 0 && counts.negative >= thresholdAbsoluteCount;
}

function isLikelyTimeoutFailure(summary: string): boolean {
  const lower = summary.toLowerCase();
  return lower.includes("timed out") || lower.includes("timeout");
}

/**
 * Run `akm index` on the evolve stash to populate the FTS5 database in the
 * cache directory that Phase 1 `akmCli` calls will use.
 *
 * `loadFixtureStash` already indexed the stash into an isolated XDG_CACHE_HOME
 * that is invisible to subsequent `akmCli` calls. Calling this helper with the
 * same `stashDir` + `cacheDir` that `envForRef` will forward ensures `akm
 * feedback` (and later `akm distill` / `akm reflect`) can look up refs in the
 * FTS5 index.
 *
 * Returns `{ ok: true }` on exit code 0, `{ ok: false, stderr }` otherwise.
 * Exported for tests.
 */
export async function indexEvolveStash(
  stashDir: string,
  cacheDir: string,
  akmCli: AkmCliFn,
  cwd: string,
): Promise<{ ok: boolean; stderr: string }> {
  const configDir = cacheDir + "/config";
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AKM_STASH_DIR: stashDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_CONFIG_HOME: configDir,
  };
  const result = await akmCli(["index"], cwd, env);
  return { ok: result.exitCode === 0, stderr: result.stderr };
}

/** Exposed for tests so the synthetic-arm prompt construction can be asserted. */
export function buildSyntheticPrompt(taskId: string): string {
  return [
    `Task: ${taskId}`,
    "Arm: synthetic (Bring Your Own Skills)",
    "No akm stash is available. Before solving the task, write a short scratchpad of the skills",
    "and steps you intend to use, then proceed. Cite the scratchpad in your trace so the verifier",
    "can attribute the approach to your own reasoning rather than retrieved guidance.",
  ].join("\n");
}

/** Synchronous recursive directory copy (used for pre-built index transfer). */
function copyDirRecursiveSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = `${src}/${entry.name}`;
    const d = `${dest}/${entry.name}`;
    if (entry.isDirectory()) copyDirRecursiveSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}
