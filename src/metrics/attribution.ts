/**
 * akm-bench attribution metrics (§6.5, #249).
 */

import fs from "node:fs";
import path from "node:path";

import type { TaskMetadata } from "../corpus";
import type { RunResult } from "../driver";
import { getStashesRoot } from "../fixtures-root";
import type { RunRecordSerialized, UtilityRunReport } from "../run-record";
import { serializeRunForReport } from "../run-record";
import { parseAssetRef } from "../support/asset-ref";
import { safeRealpath } from "../support/fs";
import { benchMkdtemp } from "../tmp";

// ── Per-asset attribution (§6.5) ───────────────────────────────────────────

/**
 * Extract the unique asset refs an agent loaded during a run by scanning
 * `events[]` and `verifierStdout` for `akm show <ref>` invocations.
 *
 * Detection strategy (all heuristic, all conservative):
 *   1. `event.eventType === "show"` with `event.ref` (forward-compat — akm
 *      itself does not currently emit `show` events).
 *   2. Substring match on `akm show <ref>` in stdout. The ref shape is the
 *      AKM 0.9 `[bundle//]conceptId[#fragment]` contract.
 *   3. Tool-call JSON `{"args":["show","<ref>"]}` — the form opencode logs
 *      when the agent invokes the akm CLI as a tool. We extract refs that
 *      look like asset refs from the args array entries adjacent to "show".
 *
 * Returns refs in first-seen order, deduplicated. Bounded scan: stdout is
 * truncated at 16 MiB (the same cap the trajectory parser uses) to keep
 * runaway agents from OOMing the bench.
 */
const ASSET_LOAD_STDOUT_SCAN_CAP = 16 * 1024 * 1024;
export function extractAssetLoads(runResult: RunResult): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (ref: string): void => {
    if (!ref || !isSafeAssetRef(ref)) return;
    if (seen.has(ref)) return;
    seen.add(ref);
    out.push(ref);
  };

  // 1. Events stream.
  for (const event of runResult.events) {
    if (event.eventType === "show" && typeof event.ref === "string") {
      push(event.ref);
    }
    const meta = event.metadata;
    if (meta && typeof meta === "object" && event.eventType === "show") {
      const candidate = (meta as Record<string, unknown>).ref;
      if (typeof candidate === "string") push(candidate);
    }
  }

  // 2 & 3. Stdout scanning. Bound the scan so a runaway agent stdout cannot
  // OOM the bench. Truncation is silent — the trajectory parser already
  // surfaces a warning for the same data on its own scan.
  let haystack = runResult.agentStdout ?? runResult.verifierStdout ?? "";
  if (haystack.length > ASSET_LOAD_STDOUT_SCAN_CAP) {
    haystack = haystack.slice(0, ASSET_LOAD_STDOUT_SCAN_CAP);
  }

  // `akm show <ref>` literal form. Quoted refs may contain spaces; unquoted
  // refs stop at the first shell delimiter. `push` validates the whole token
  // before accepting it.
  const literalRe = /\bakm\s+show\s+(?:"([^"]+)"|'([^']+)'|([^\s"'`]+))/g;
  for (const literalMatch of haystack.matchAll(literalRe)) {
    push((literalMatch[1] ?? literalMatch[2] ?? literalMatch[3]) as string);
  }

  // Tool-call JSON form. `"args":[..., "show", "<ref>", ...]`. We extract
  // every refish token in the haystack that follows a "show" arg in JSON-y
  // form. A second cheap pass keeps the pattern simple.
  const toolCallRe = /"show"\s*,\s*"((?:\\.|[^"\\])+)"/g;
  for (const toolCallMatch of haystack.matchAll(toolCallRe)) {
    try {
      push(JSON.parse(`"${toolCallMatch[1]}"`) as string);
    } catch {
      // Malformed JSON-ish tool trace: ignore it.
    }
  }

  return out;
}

/**
 * Reject hostile asset refs before they reach any `fs.rmSync` call. The ref
 * comes from agent stdout (untrusted; the agent could be prompt-injected), so
 * parse it with the current grammar before resolving anything on disk.
 */
function isSafeAssetRef(ref: string): boolean {
  try {
    parseAssetRef(ref);
    return true;
  } catch {
    return false;
  }
}

/** Per-asset attribution row (§6.5). */
export interface PerAssetAttributionRow {
  /** Asset ref, e.g. `skills/docker-homelab`. */
  assetRef: string;
  /** Number of akm-arm runs that loaded this asset AND passed. */
  loadCountPassing: number;
  /** Number of akm-arm runs that loaded this asset AND failed (or budget/harness). */
  loadCountFailing: number;
  /** Total akm-arm runs that loaded this asset (passing + failing). */
  loadCount: number;
  /**
   * Among runs that loaded the asset, the fraction that passed. `null` when
   * load_count is zero (defensive — that asset would not appear in the table
   * at all in normal flow, but a future caller might construct one manually).
   */
  loadPassRate: number | null;
}

/** Per-asset attribution table (§6.5). */
export interface PerAssetAttribution {
  rows: PerAssetAttributionRow[];
  /** Total akm-arm runs aggregated. Sample size for the table as a whole. */
  totalAkmRuns: number;
}

/**
 * Aggregate per-asset load + pass counts across all akm-arm runs in a report.
 *
 * Sort order (stable, deterministic):
 *   1. loadCount descending (most-used first)
 *   2. loadPassRate descending (working assets above broken ones at the same load count)
 *   3. assetRef ascending (alphabetical tiebreak)
 *
 * Only `arm === "akm"` runs contribute. The `noakm` arm has no stash and
 * cannot load assets, so including it would zero-bias the rates.
 */
export function computePerAssetAttribution(report: UtilityRunReport): PerAssetAttribution {
  const passing = new Map<string, number>();
  const failing = new Map<string, number>();
  let totalAkmRuns = 0;

  // The §13.3 task entry doesn't carry RunResults — we read them from the
  // shared akm-arm runs collection that the runner stamps onto `report.akmRuns`.
  const akmRuns = collectAkmRuns(report);
  for (const r of akmRuns) {
    totalAkmRuns += 1;
    const isPass = r.outcome === "pass";
    for (const ref of r.assetsLoaded ?? []) {
      const bucket = isPass ? passing : failing;
      bucket.set(ref, (bucket.get(ref) ?? 0) + 1);
    }
  }

  const refs = new Set<string>([...passing.keys(), ...failing.keys()]);
  const rows: PerAssetAttributionRow[] = [];
  for (const ref of refs) {
    const p = passing.get(ref) ?? 0;
    const f = failing.get(ref) ?? 0;
    const total = p + f;
    rows.push({
      assetRef: ref,
      loadCountPassing: p,
      loadCountFailing: f,
      loadCount: total,
      loadPassRate: total === 0 ? null : p / total,
    });
  }

  rows.sort((a, b) => {
    if (b.loadCount !== a.loadCount) return b.loadCount - a.loadCount;
    const ar = a.loadPassRate ?? -1;
    const br = b.loadPassRate ?? -1;
    if (br !== ar) return br - ar;
    return a.assetRef.localeCompare(b.assetRef);
  });

  return { rows, totalAkmRuns };
}

/**
 * Pull the akm-arm RunResults out of a UtilityRunReport. The runner stamps
 * them into the optional `akmRuns` field on the report so attribution can
 * post-process them without re-running.
 */
function collectAkmRuns(report: UtilityRunReport): RunResult[] {
  if (Array.isArray(report.akmRuns)) return report.akmRuns;
  return [];
}

// ── runs[] serialisation (#249) ────────────────────────────────────────────

/**
 * Project a list of RunResults onto the compact `runs[]` rows persisted
 * inside the §13.3 JSON envelope (#249). One row per (task, arm, seed)
 * triple; the renderer walks the input order verbatim, which the runner
 * already builds deterministically (per-task block, noakm before akm,
 * seeds in ascending order).
 *
 * Aggregate metrics (per-task, trajectory, failure-mode, search-bridge,
 * attribution) MUST be recomputable from these rows + task metadata. This
 * helper is the canonical projection — keep it in lockstep with the field
 * list in the issue body.
 */
export function aggregateRunsForReport(runs: RunResult[]): RunRecordSerialized[] {
  return runs.map(serializeRunForReport);
}

/**
 * Hydrate a persisted `runs[]` row back into the `RunResult` shape that
 * downstream metrics helpers (`computePerAssetAttribution`, `aggregateCorpus`,
 * etc.) expect. Used by `bench attribute` / `bench compare` when they read a
 * §13.3 envelope from disk: the persisted row carries a compact subset, but
 * it carries everything those helpers need.
 *
 * Fields the row deliberately does NOT carry are filled with safe defaults:
 *   • `events: []` — events.jsonl is not persisted; downstream attribution
 *     only consults `assetsLoaded` and `verifierStdout`.
 *   • `verifierStdout: ""` — full stdout is intentionally omitted from the
 *     envelope (#249 acceptance criterion). `assetsLoaded` already carries
 *     the post-hoc extraction the agent run produced.
 *   • `schemaVersion: 1` — the report schema implies it.
 *
 * Tokens are passed through as-is so any future fields land on the
 * rehydrated row automatically.
 */
export function rehydrateRunFromSerialized(row: RunRecordSerialized): RunResult {
  // The compact row uses a permissive Record shape for tokens (see
  // RunRecordSerialized). Coerce defensively so older artefacts with only
  // {input, output} hydrate cleanly.
  const tok = row.tokens as { input?: number; output?: number } & Record<string, unknown>;
  return {
    schemaVersion: 1,
    taskId: row.task_id,
    arm: row.arm,
    seed: row.seed,
    model: row.model,
    outcome: row.outcome as RunResult["outcome"],
    tokens: {
      ...tok,
      input: typeof tok.input === "number" ? tok.input : 0,
      output: typeof tok.output === "number" ? tok.output : 0,
    } as RunResult["tokens"],
    wallclockMs: row.wallclock_ms,
    trajectory: {
      correctAssetLoaded: row.trajectory.correct_asset_loaded,
      feedbackRecorded: row.trajectory.feedback_recorded,
    },
    events: [],
    agentStdout: "",
    verifierStdout: "",
    verifierExitCode: row.verifier_exit_code,
    assetsLoaded: [...row.assets_loaded],
    failureMode: (row.failure_mode ?? null) as RunResult["failureMode"],
  };
}

// ── runMaskedCorpus (§6.5 leave-one-out) ──────────────────────────────────

/**
 * Marginal-contribution row for one masked asset.
 *
 * `marginalContribution = basePassRate − maskedPassRate`. Positive means the
 * asset *helped* — masking it hurt pass rate. Negative means the asset hurt
 * — masking it improved pass rate (a candidate for deletion / rewrite).
 */
export interface MaskedAttributionRow {
  assetRef: string;
  basePassRate: number;
  maskedPassRate: number;
  marginalContribution: number;
}

/** `runMaskedCorpus` result envelope. */
export interface MaskedCorpusResult {
  baseReport: UtilityRunReport;
  attributions: MaskedAttributionRow[];
  /**
   * Number of masked-corpus runs actually performed. Equals `min(topN,
   * unique-loaded-asset count)`. Operators reading the JSON envelope use this
   * to verify cost accounting.
   */
  runsPerformed: number;
  /**
   * Strategy used to construct each masked stash. Currently always
   * `"leave-one-out"`: every re-run masks exactly one asset ref from the
   * source fixture stash. Recorded in the JSON envelope so operators can
   * tell at a glance whether a future strategy (e.g. `"leave-pair-out"`)
   * was used.
   */
  maskingStrategy: "leave-one-out";
  /**
   * The exact asset refs masked, one per masked re-run. Order matches
   * `attributions[]`. Recorded in the JSON envelope so the operator can
   * audit which assets contributed to the marginal-contribution numbers.
   */
  maskedRefs: string[];
}

/** Caller-facing options for `runMaskedCorpus`. */
export interface RunMaskedCorpusOptions {
  /** Base report from a prior `bench utility` run. Required. */
  baseReport: UtilityRunReport;
  /** Top N most-loaded assets to mask. Defaults to 5; clamped to asset count. */
  topN?: number;
  /**
   * Re-runner. Tests inject a fake; production wires to `runUtility`. Receives
   * options identical to the original run but with each task's stash already
   * remapped to a tmp dir that has the named asset removed.
   */
  runUtility: (
    options: Omit<RunUtilityOptionsForMask, "spawn" | "materialiseStash"> & {
      tasks: TaskMetadata[];
      spawn?: RunUtilityOptionsForMask["spawn"];
      materialiseStash?: boolean;
    },
  ) => Promise<UtilityRunReport>;
  /**
   * The original `runUtility` call's options, passed through so the masked
   * runs use the same model / arms / seedsPerArm / budgets. The caller gives
   * us this; we reuse it modulo the per-task tasks override.
   */
  baseOptions: RunUtilityOptionsForMask;
  /**
   * Root directory for the source fixture stashes. Defaults to
   * `fixtures/stashes/` relative to the repo. Tests inject a tmp dir.
   */
  fixturesRoot?: string;
}

/**
 * Subset of RunUtilityOptions we need for masked re-runs. We avoid importing
 * the runner module directly so metrics.ts has no cycle.
 */
export interface RunUtilityOptionsForMask {
  arms: Arm[];
  model: string;
  seedsPerArm?: number;
  budgetTokens?: number;
  budgetWallMs?: number;
  slice?: "all" | "train" | "eval";
  branch?: string;
  commit?: string;
  timestamp?: string;
  /**
   * Test-only injection seam for the child-process spawn function. The
   * masked re-runner forwards this verbatim to `runUtility`, which uses it
   * to launch the agent harness for each masked task. SECURITY: a non-test
   * caller MUST NOT set this — production code paths leave it `undefined`
   * so the runner falls back to the vetted default `SpawnFn`. The field is
   * typed `any` only to keep metrics.ts independent of `src/integrations/agent/spawn`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Test-injection seam (see JSDoc above). SpawnFn lives in src/integrations/agent/spawn; importing it would pull node-specific types into metrics.ts. Production callers leave this undefined.
  spawn?: any;
  materialiseStash?: boolean;
}

/** The two arm names. Duplicated here so metrics.ts has no runner.ts import. */
export type Arm = "noakm" | "akm";

/**
 * Pick the top-N most-loaded assets from a base report and re-run the corpus
 * with each one masked from its source stash. Returns a marginal-contribution
 * row per masked asset.
 *
 * Cost: N * (tasks × arms × seedsPerArm) re-runs. Operators clamp N before
 * calling — but we also clamp internally if `topN` exceeds the unique-asset
 * count to avoid surprising no-op runs.
 *
 * Source-fixture safety: every masked re-run materialises a fresh tmp copy
 * of the fixture stash, deletes the masked asset's files there, and points
 * the re-run at the tmp dir. The shipped fixture in `fixtures/stashes/`
 * is NEVER mutated.
 */
export async function runMaskedCorpus(opts: RunMaskedCorpusOptions): Promise<MaskedCorpusResult> {
  const baseReport = opts.baseReport;
  const fixturesRoot = opts.fixturesRoot ?? getStashesRoot();

  const attribution = computePerAssetAttribution(baseReport);
  const desired = Math.max(1, opts.topN ?? 5);
  const clamped = Math.min(desired, attribution.rows.length);

  const baseAkmPassRate = baseReport.aggregateAkm.passRate;
  const top = attribution.rows.slice(0, clamped);
  const attributions: MaskedAttributionRow[] = [];
  const maskedRefs: string[] = [];

  for (const row of top) {
    const maskedTasks: TaskMetadata[] = [];
    const tmpDirs: string[] = [];
    try {
      for (const baseTask of baseReport.taskMetadata ?? []) {
        const maskedStashDir = materialiseMaskedStash(fixturesRoot, baseTask.stash, row.assetRef);
        if (maskedStashDir) tmpDirs.push(maskedStashDir);
        // Issue #251: forward the masked stashDir via the explicit
        // `stashDirOverride` field on the cloned TaskMetadata. We MUST NOT
        // mutate `baseTask.stash` (the fixture name) — the runner uses that
        // to call `loadFixtureStash`, and overloading it breaks the
        // `__no-stash__` resolution branch in runner.ts. The runner's AKM-arm
        // branch checks `task.stashDirOverride` first.
        //
        // When `materialiseMaskedStash` returned `null` (asset not present in
        // this fixture, or hostile ref shape rejected by the validator), we
        // intentionally leave both fields untouched. The runner falls back to
        // the normal materialisation flow against the unchanged source
        // fixture — so the re-run still happens, but the result mirrors the
        // base. This is a meaningful diagnostic (the ref didn't bind in this
        // fixture) and is the same accounting `cost-accounting`-style tests
        // assert against.
        if (maskedStashDir) {
          maskedTasks.push({ ...baseTask, stashDirOverride: maskedStashDir });
        } else {
          maskedTasks.push({ ...baseTask });
        }
      }

      const maskedReport = await opts.runUtility({
        ...opts.baseOptions,
        tasks: maskedTasks,
        // The masked stash already has the correct content on disk, and the
        // runner now resolves it via `task.stashDirOverride`. We still pass
        // `materialiseStash: false` so the runner does not call
        // `loadFixtureStash` against the (unmasked) named fixture — that
        // would waste work and risk re-indexing the source dir.
        materialiseStash: false,
      });

      const maskedPassRate = maskedReport.aggregateAkm.passRate;
      attributions.push({
        assetRef: row.assetRef,
        basePassRate: baseAkmPassRate,
        maskedPassRate,
        marginalContribution: baseAkmPassRate - maskedPassRate,
      });
      maskedRefs.push(row.assetRef);
    } finally {
      // Cleanup runs in BOTH success and failure paths (acceptance criterion).
      // Best-effort: a tmpfs failure here is logged via the `try/catch` below
      // and the host OS reaps the tmp dir on reboot.
      for (const dir of tmpDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; tmpfs cleanup will handle leaks.
        }
      }
    }
  }

  return {
    baseReport,
    attributions,
    runsPerformed: clamped,
    maskingStrategy: "leave-one-out",
    maskedRefs,
  };
}

/**
 * Copy a fixture stash into a fresh tmp dir, delete every file matching the
 * masked asset ref, and return the tmp dir path. Returns `null` if the named
 * asset is not present in the fixture (we still re-run, but the result will
 * mirror the base — which is itself a meaningful diagnostic).
 *
 * The masking heuristic resolves the current concept id to the built-in AKM
 * adapter's physical placement, removes that file/directory from a temporary
 * copy, and trims any legacy `.stash.json` entry that names the same file.
 */
export function materialiseMaskedStash(fixturesRoot: string, stashName: string, assetRef: string): string | null {
  // #271: validate stashName containment BEFORE touching the filesystem.
  // `stashName` originates from a task YAML which, while authored, is part
  // of the fixture corpus the bench loads; a fixture with `stash: "../../etc"`
  // would otherwise resolve outside `fixturesRoot` and let masking edits or
  // copies escape the bench sandbox. path.relative gives the cleanest
  // containment check (handles `..` AND absolute path injection in one go).
  const fixturesRootResolved = path.resolve(fixturesRoot);
  const sourceDir = path.resolve(fixturesRootResolved, stashName);
  const rel = path.relative(fixturesRootResolved, sourceDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(path.join(sourceDir, "MANIFEST.json"))) return null;

  // Validate the WHOLE ref before touching the filesystem.
  if (!isSafeAssetRef(assetRef)) return null;
  const { conceptId } = parseAssetRef(assetRef);
  const relativeTargets = physicalPathsForConceptId(conceptId);
  if (relativeTargets.length === 0) return null;

  const tmpRoot = benchMkdtemp(`akm-bench-masked-${stashName}-`);
  copyDirRecursive(sourceDir, tmpRoot);
  const targets = relativeTargets
    .map((relativeTarget) => path.resolve(tmpRoot, relativeTarget))
    .filter((target) => isPathContained(tmpRoot, target));
  let removed = false;

  // Trim compatibility metadata before removing directory targets that may
  // contain their own `.stash.json`.
  walkStashJsonFiles(tmpRoot, (jsonPath) => {
    let raw: string;
    try {
      raw = fs.readFileSync(jsonPath, "utf8");
    } catch {
      return;
    }
    let parsed: { entries?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(raw) as { entries?: Array<Record<string, unknown>> };
    } catch {
      return;
    }
    const entries = parsed.entries ?? [];
    const kept: Array<Record<string, unknown>> = [];
    const jsonDir = path.dirname(jsonPath);
    for (const entry of entries) {
      const filename = entry.filename;
      const entryTarget = typeof filename === "string" ? path.resolve(jsonDir, filename) : undefined;
      const belongsToMaskedTarget =
        entryTarget !== undefined &&
        isPathContained(tmpRoot, entryTarget) &&
        targets.some((target) => entryTarget === target || isPathContained(target, entryTarget));
      if (belongsToMaskedTarget) {
        // Remove the entry's content file(s). The on-disk `filename` is read
        // from the fixture .stash.json (trusted) but the value still passes
        // through path.relative containment so a malicious fixture can't use
        // this path to escape either.
        if (typeof filename === "string" && isSafeAssetNameSegment(filename)) {
          const target = path.resolve(jsonDir, filename);
          if (isPathContained(tmpRoot, target)) {
            try {
              fs.rmSync(target, { force: true });
              removed = true;
            } catch {
              // ignore
            }
          }
        }
        continue;
      }
      kept.push(entry);
    }
    if (kept.length === entries.length) return; // nothing changed
    if (kept.length === 0) {
      try {
        fs.rmSync(jsonPath, { force: true });
      } catch {
        // ignore
      }
    } else {
      fs.writeFileSync(jsonPath, `${JSON.stringify({ ...parsed, entries: kept }, null, 2)}\n`);
    }
  });

  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed = true;
    } catch {
      // Best effort; a still-present target means this candidate was not masked.
    }
  }

  if (!removed) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    return null;
  }
  return tmpRoot;
}

const MARKDOWN_CONCEPT_DIRS = new Set([
  "agents",
  "commands",
  "facts",
  "instructions",
  "knowledge",
  "lessons",
  "memories",
  "sessions",
]);

/** Physical spellings owned by the built-in AKM adapter for one concept id. */
function physicalPathsForConceptId(conceptId: string): string[] {
  const [family, ...tailParts] = conceptId.split("/");
  if (!family || tailParts.length === 0) return [];
  const tail = tailParts.join("/");
  const exact = `${family}/${tail}`;
  if (family === "skills") {
    // Current skills are directories containing SKILL.md. Keep the flat
    // markdown spelling as a fixture-compatibility target for old reports.
    return [exact, `${exact}.md`];
  }
  if (family === "scripts" || family === "secrets") return [exact];
  if (MARKDOWN_CONCEPT_DIRS.has(family)) return [exact.endsWith(".md") ? exact : `${exact}.md`];
  if (family === "workflows") {
    return /\.(?:md|yml)$/i.test(exact) ? [exact] : [`${exact}.md`, `${exact}.yml`];
  }
  if (family === "tasks") return [exact.endsWith(".yml") ? exact : `${exact}.yml`];
  if (family === "env") {
    if (tail === "default") return [`${family}/.env`, `${family}/default.env`];
    if (tail.endsWith("/default")) {
      return [`${family}/${tail.slice(0, -"default".length)}.env`, `${exact}.env`];
    }
    return [exact.endsWith(".env") ? exact : `${exact}.env`];
  }
  return [];
}

/**
 * Reject any segment that could escape the tmp stash root when used as a
 * relative path component:
 *   - empty string
 *   - any `/` or `\\` (path separators)
 *   - a `..` segment in any form
 *   - a leading `/` (POSIX absolute) or `C:` (Windows drive)
 *   - any null byte
 *
 * Mirrors src/core/asset-ref.ts validateName(), but returns a boolean
 * (callers map this to "skip" rather than "throw").
 */
function isSafeAssetNameSegment(value: string): boolean {
  if (!value) return false;
  if (value.includes("\0")) return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value === ".." || value === ".") return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return true;
}

/**
 * After resolving a target path, confirm it lives under `root`. Defense in
 * depth: even if a traversal-shaped name slipped past the segment check,
 * this catches escapes via symlinks or odd `path.join` semantics.
 *
 * #271: aligned with `isWithin` in `src/core/common.ts` — both inputs go
 * through `safeRealpath` so a symlink inside `root` that points outside
 * cannot fool the `path.relative` containment check. The shared helper
 * also handles not-yet-existing children (walks up to the closest existing
 * ancestor and resolves symlinks there) so we keep the existing semantics
 * for `target` paths the masking heuristic is about to create.
 */
export function isPathContained(root: string, target: string): boolean {
  const rootResolved = safeRealpath(root);
  const targetResolved = safeRealpath(target);
  const rel = path.relative(rootResolved, targetResolved);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function walkStashJsonFiles(root: string, visit: (jsonPath: string) => void): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile() && entry.name === ".stash.json") visit(abs);
    }
  }
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/** Aggregate trajectory booleans across a bag of runs. */
