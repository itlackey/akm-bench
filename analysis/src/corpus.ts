/**
 * Corpus metadata loader and left-join (implementation brief §6 / plan phase
 * P1).
 *
 * Harbor's `TrialResult` never carries a task's `[metadata]` table — verified
 * absent at every level (docs/plans/benchmark-harness-decisions.md D12,
 * docs/plans/benchmark-harness-consolidation.md §3.1: "`task.toml`
 * `[metadata]` never reaches `result.json` at any level"). Every grouping we
 * care about (domain, slice, difficulty, memory_ability, ...) requires a
 * left-join from the corpus's own `task.toml` files onto `TrialResult.
 * task_name`.
 *
 * The join key is NOT always the task directory's basename. Verified against
 * Harbor v0.22.0 `Task.__init__` (`models/task/task.py`): `Task.name` is
 * `config.task.name` whenever a task.toml declares a `[task]` table, and
 * falls back to the directory basename ONLY when `[task]` is absent. Every
 * converted akm-bench task sets `[task] name = "akm-bench/<domain>--<id>"`
 * (docs/corpus-conversion.md), so `TrialResult.task_name` for those tasks is
 * that dotted string, not the directory basename — confirmed empirically:
 * indexing only by basename produces a 0% join match against a real
 * `harbor/tasks/` checkout. This module therefore indexes each task under
 * BOTH its directory basename (the fallback-case join key, and the legacy
 * assumption this module used to rely on exclusively) AND its `[task].name`
 * when present (the actual join key for every converted task), pointing at
 * the same `CorpusTaskMetadata` object.
 *
 * TOML parsing: `Bun.TOML.parse()` was verified sufficient on the installed
 * Bun 1.3.11 (handles nested tables, arrays, dotted keys) — no bespoke
 * TOML-subset parser was needed and none is shipped here.
 *
 * Missing metadata is ALWAYS a warning, never a crash: a task dir with no
 * `task.toml`, a `task.toml` with no `[metadata]` table, or a `task.toml`
 * that fails to parse all register the task as present-but-unmetadata'd (or
 * are simply absent from the index, for trial-side callers to report as
 * "missing" — see `joinCorpus()`), collected into `CorpusIndex.warnings`.
 */

import fs from "node:fs";
import path from "node:path";

export interface CorpusTaskMetadata {
  /**
   * The join key against `TrialRecord.taskName` — the task's declared
   * `[task].name` (e.g. `"akm-bench/inkwell--set-rate-limit"`) when
   * `task.toml` has a `[task]` table, else the task directory's basename.
   * This value is also indexed under the directory basename in
   * `CorpusIndex.byTaskName` when the two differ, so either key resolves to
   * this same object — but this field itself always holds the REAL join key,
   * never a basename that Harbor would not have written to `task_name`.
   */
  taskName: string;
  /** Absolute path to the directory containing this task's `task.toml`. */
  taskDir: string;
  /**
   * Common fields, pulled out of `raw` for convenience when present. The
   * corpus `[metadata]` schema is still an open decision as of this writing
   * (docs/plans/benchmark-harness-decisions.md D10), so these are read
   * loosely (any string value is accepted, no closed enum) rather than
   * validated against a fixed set — that keeps this module from breaking the
   * moment the real schema is decided.
   */
  domain?: string;
  slice?: string;
  difficulty?: string;
  memoryAbility?: string;
  taskFamily?: string;
  goldRef?: string;
  /** The full `[metadata]` table verbatim, including the typed fields above. Empty object when `task.toml` had no `[metadata]` table. */
  raw: Record<string, unknown>;
}

export interface CorpusIndex {
  /** Keyed by task directory basename (the join key). */
  byTaskName: Map<string, CorpusTaskMetadata>;
  /** Parse/lookup warnings collected while building the index (never thrown). */
  warnings: string[];
}

/**
 * Walk `tasksDir` recursively and index every directory containing a
 * `task.toml` by its basename.
 *
 * Recursive rather than one-level-deep: Harbor's own `-p <dir>` scan is
 * exactly one level (docs/plans/benchmark-harness-consolidation.md §3.1), but
 * this loader is a separate, read-only pass over the corpus and tolerates
 * either layout so it keeps working across whatever `[metadata]` /
 * directory-layout decision D10 lands on. A directory containing a
 * `task.toml` is never recursed into further (mirrors the legacy
 * `src/corpus.ts` `walkTaskDirs` convention).
 *
 * Returns an empty index (never throws) when `tasksDir` does not exist.
 */
export function loadCorpusMetadata(tasksDir: string): CorpusIndex {
  const byTaskName = new Map<string, CorpusTaskMetadata>();
  const warnings: string[] = [];
  if (!isDirectory(tasksDir)) return { byTaskName, warnings };

  /** Index `entry` under `key`, warning (never overwriting) on a collision. */
  const index = (key: string, entry: CorpusTaskMetadata, keyLabel: string) => {
    const existing = byTaskName.get(key);
    if (existing && existing.taskDir !== entry.taskDir) {
      warnings.push(
        `duplicate ${keyLabel} ${JSON.stringify(key)}: keeping ${existing.taskDir}, ignoring ${entry.taskDir}`,
      );
      return;
    }
    byTaskName.set(key, entry);
  };

  for (const taskDir of walkTaskDirs(tasksDir)) {
    const basename = path.basename(taskDir);

    const tomlPath = path.join(taskDir, "task.toml");
    let text: string;
    try {
      text = fs.readFileSync(tomlPath, "utf8");
    } catch (err) {
      warnings.push(`${tomlPath}: could not read task.toml (${errorMessage(err)})`);
      continue;
    }

    let parsed: unknown;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Bun.TOML is a Bun global not modeled by bun-types' Bun namespace declarations at this pin; narrowed immediately below.
      parsed = (Bun as any).TOML.parse(text);
    } catch (err) {
      warnings.push(`${tomlPath}: could not parse TOML (${errorMessage(err)})`);
      continue;
    }

    const root = asRecord(parsed);
    // The join key Harbor actually uses for `TrialResult.task_name`: `Task.name`
    // is `config.task.name` when a `[task]` table is present (every converted
    // akm-bench task), and the directory basename only when it is absent.
    const taskTable = root ? asRecord(root.task) : undefined;
    const declaredName = taskTable ? asString(taskTable.name) : undefined;
    const joinKey = declaredName ?? basename;

    const metadataTable = root ? asRecord(root.metadata) : undefined;
    if (!metadataTable) {
      warnings.push(`${tomlPath}: no [metadata] table; task ${JSON.stringify(joinKey)} indexed with empty metadata`);
    }
    const raw = metadataTable ?? {};

    const entry: CorpusTaskMetadata = {
      taskName: joinKey,
      taskDir,
      domain: asString(raw.domain),
      slice: asString(raw.slice),
      difficulty: asString(raw.difficulty),
      memoryAbility: asString(raw.memory_ability),
      taskFamily: asString(raw.task_family),
      goldRef: asString(raw.gold_ref),
      raw,
    };

    // Index under the REAL join key (declared [task].name when present, else
    // the basename) and, when that differs from the basename, ALSO under the
    // basename — a caller (or an older/differently-configured trial) may
    // still key off it, and it costs nothing to serve both.
    index(joinKey, entry, "task join key");
    if (basename !== joinKey) {
      index(basename, entry, "task directory basename");
    }
  }

  return { byTaskName, warnings };
}

export interface CorpusJoinResult {
  /** Task names (from the trial-side input) that matched a corpus entry. */
  matched: string[];
  /** Task names (from the trial-side input) with no corpus entry — sorted, for stable report output. */
  missingTaskNames: string[];
}

/**
 * Left-join a set of task names (typically `new Set(records.map(r =>
 * r.taskName))` from loaded trials) against a `CorpusIndex`.
 *
 * This is intentionally decoupled from `TrialRecord` — it takes plain task
 * names — so `corpus.ts` never needs to import `loader.ts`'s types and stays
 * usable standalone (e.g. against a hand-built task-name list in a test).
 * Missing metadata is reported via `missingTaskNames`, never thrown.
 */
export function joinCorpus(taskNames: Iterable<string>, index: CorpusIndex): CorpusJoinResult {
  const matched: string[] = [];
  const missingTaskNames: string[] = [];
  for (const taskName of taskNames) {
    if (index.byTaskName.has(taskName)) matched.push(taskName);
    else missingTaskNames.push(taskName);
  }
  matched.sort();
  missingTaskNames.sort();
  return { matched, missingTaskNames };
}

/** Walk the tasks tree depth-first, yielding every directory containing a `task.toml`. Mirrors `src/corpus.ts`'s `walkTaskDirs`. */
function* walkTaskDirs(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === "task.toml")) {
      yield dir;
      continue; // Don't recurse beneath a task directory.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
