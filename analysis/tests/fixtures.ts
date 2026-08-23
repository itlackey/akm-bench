/**
 * Synthetic Harbor job-tree fixtures for `analysis/tests`.
 *
 * Builds a directory tree shaped exactly like real `harbor run` output (see
 * `analysis/src/loader.ts`'s module docstring for the verified layout) plus a
 * matching corpus `tasks/` directory (see `analysis/src/corpus.ts`) —
 * entirely from literal JSON/TOML. No Harbor, no Docker, no network.
 *
 * Fixed shape used by every test in this directory — 2 arms x 4 tasks x 3
 * attempts = 24 trials, split across two jobs (one per arm: the realistic
 * "baseline job" + "treatment job" shape a real akm-bench sweep produces),
 * with exactly:
 *
 *   - 1 errored trial            (control  / task-a / attempt 3)
 *   - 1 null-token trial         (treatment / task-b / attempt 1)
 *   - 1 multi-key reward trial   (control  / task-c / attempt 2)
 *   - 1 task with NO corpus entry (task-d — no `task.toml` at all)
 *
 * `buildSyntheticJobTree()` is deterministic (same output every call), so
 * `analysis/tests/*.test.ts` hardcode expected ("golden") numbers against it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentKwargsDigest } from "../src/loader";

export const CONTROL_AGENT = { name: "opencode", version: "1.18.21" } as const;
export const TREATMENT_AGENT = { name: "akm-opencode", version: "1.18.21+akm-opencode@0.9.202808220049" } as const;

/**
 * How Harbor really splits a model.
 *
 * VERIFIED against Harbor v0.22.0 `BaseAgent.to_agent_info()`: it splits
 * `model_name` on the FIRST `/` and writes the halves into SEPARATE
 * `ModelInfo` fields — `name` gets the bare model, `provider` gets the
 * prefix. `config.agent.model_name` keeps the joined form. An earlier
 * revision of this fixture put the joined `anthropic/claude-sonnet-4-5` into
 * `model_info.name`, which Harbor never does; that made these golden tests
 * agree with a shape real output does not have, and hid the fact that
 * `deriveArm()` was dropping the provider from every arm label.
 */
export const MODEL_PROVIDER = "anthropic";
export const MODEL_BARE_NAME = "claude-sonnet-4-5";
/** The joined form, as it appears in `config.agent.model_name` (and on a `-m` flag). */
export const MODEL_NAME = `${MODEL_PROVIDER}/${MODEL_BARE_NAME}`;

/**
 * `config.agent.kwargs` per arm. Non-empty on BOTH arms, which is what a real
 * job config produces (every arm pins `version:`) — and therefore what makes
 * these constants exercise `deriveArm()`'s kwargs-digest suffix rather than
 * its empty-kwargs shortcut.
 */
export const CONTROL_KWARGS = { version: CONTROL_AGENT.version } as const;
export const TREATMENT_KWARGS = { version: TREATMENT_AGENT.version, akm_cli_spec: "akm-cli@0.9.1" } as const;

/** Mirrors `deriveArm()`'s label construction so the fixture and the loader cannot drift apart silently. */
function armLabel(agent: { name: string; version: string }, kwargs: Record<string, unknown>): string {
  const base = `${agent.name}@${agent.version}//${MODEL_NAME}`;
  return Object.keys(kwargs).length === 0 ? base : `${base}#${armKwargsDigest8(kwargs)}`;
}

function armKwargsDigest8(kwargs: Record<string, unknown>): string {
  return agentKwargsDigest(kwargs).slice(0, 8);
}

export const CONTROL_ARM = armLabel(CONTROL_AGENT, CONTROL_KWARGS);
export const TREATMENT_ARM = armLabel(TREATMENT_AGENT, TREATMENT_KWARGS);

export const TASK_NAMES = ["task-a", "task-b", "task-c", "task-d"] as const;
/** task-d is deliberately left out of the corpus fixture — the missing-metadata case. */
export const TASK_WITH_NO_METADATA = "task-d";

export const HARBOR_VERSION = "0.22.0";

type Arm = "control" | "treatment";

interface TrialSpec {
  taskName: string;
  attempt: number;
  reward: number | null;
  extraRewards?: Record<string, number>;
  errored?: boolean;
  nullTokens?: boolean;
}

/** Base reward-per-attempt matrix, BEFORE the errored/null-token/multi-key overrides below are applied. */
const REWARDS_BY_ARM: Record<Arm, Record<string, [number, number, number]>> = {
  control: {
    "task-a": [1, 0, 1],
    "task-b": [0, 0, 1],
    "task-c": [1, 1, 0],
    "task-d": [0, 1, 1],
  },
  treatment: {
    "task-a": [1, 1, 1],
    "task-b": [1, 0, 1],
    "task-c": [1, 1, 1],
    "task-d": [0, 1, 1],
  },
};

function buildTrialSpecs(arm: Arm): TrialSpec[] {
  const specs: TrialSpec[] = [];
  for (const taskName of TASK_NAMES) {
    const rewards = REWARDS_BY_ARM[arm][taskName];
    for (let i = 0; i < 3; i++) {
      const attempt = i + 1;
      const spec: TrialSpec = { taskName, attempt, reward: rewards[i] as number };
      if (arm === "control" && taskName === "task-a" && attempt === 3) {
        spec.errored = true;
        spec.reward = null;
      }
      if (arm === "control" && taskName === "task-c" && attempt === 2) {
        spec.extraRewards = { workflow_compliance: 0.8 };
      }
      if (arm === "treatment" && taskName === "task-b" && attempt === 1) {
        spec.nullTokens = true;
      }
      specs.push(spec);
    }
  }
  return specs;
}

function trialResultJson(arm: Arm, spec: TrialSpec, trialName: string): Record<string, unknown> {
  const agent = arm === "control" ? CONTROL_AGENT : TREATMENT_AGENT;
  const checksum = `sha256:${spec.taskName}-checksum`;

  const verifierResult = spec.errored ? null : { rewards: { reward: spec.reward, ...(spec.extraRewards ?? {}) } };

  const agentResult = spec.errored
    ? null
    : spec.nullTokens
      ? { n_input_tokens: null, n_cache_tokens: null, n_output_tokens: null, cost_usd: null }
      : {
          n_input_tokens: 1000 + spec.attempt * 10,
          n_cache_tokens: 100,
          n_output_tokens: 200 + spec.attempt * 5,
          cost_usd: 0.01 * spec.attempt,
        };

  return {
    id: `${trialName}-uuid`,
    task_name: spec.taskName,
    trial_name: trialName,
    trial_uri: `local:${spec.taskName}`,
    task_id: { type: "local", path: `/fixtures/tasks/${spec.taskName}` },
    source: null,
    task_checksum: checksum,
    config: {
      task: { path: `/fixtures/tasks/${spec.taskName}` },
      agent: {
        name: agent.name,
        import_path: arm === "treatment" ? "harbor.akm_opencode:AkmOpenCode" : null,
        model_name: MODEL_NAME,
        kwargs: arm === "treatment" ? { ...TREATMENT_KWARGS } : { ...CONTROL_KWARGS },
        env: {},
      },
      environment: {},
      verifier: {},
    },
    agent_info: {
      name: agent.name,
      version: agent.version,
      // Bare model name + separate provider — exactly what Harbor writes.
      model_info: { name: MODEL_BARE_NAME, provider: MODEL_PROVIDER },
    },
    agent_result: agentResult,
    verifier_result: verifierResult,
    exception_info: spec.errored
      ? {
          exception_type: "AkmPluginNotLoadedError",
          exception_message: "synthetic fixture error",
          exception_traceback: "",
          occurred_at: "2026-08-01T00:00:00Z",
        }
      : null,
    started_at: "2026-08-01T00:00:00Z",
    finished_at: "2026-08-01T00:05:00Z",
    environment_setup: { started_at: "2026-08-01T00:00:00Z", finished_at: "2026-08-01T00:01:00Z" },
    agent_setup: { started_at: "2026-08-01T00:01:00Z", finished_at: "2026-08-01T00:02:00Z" },
    agent_execution: { started_at: "2026-08-01T00:02:00Z", finished_at: "2026-08-01T00:04:00Z" },
    verifier: { started_at: "2026-08-01T00:04:00Z", finished_at: "2026-08-01T00:05:00Z" },
  };
}

export interface SyntheticJobTree {
  root: string;
  jobsDir: string;
  tasksDir: string;
  controlJobId: string;
  treatmentJobId: string;
}

/** Build a fresh synthetic job tree under a new temp directory. Call `cleanupSyntheticJobTree()` when done. */
export function buildSyntheticJobTree(): SyntheticJobTree {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-analysis-fixture-"));
  const jobsDir = path.join(root, "jobs");
  const tasksDir = path.join(root, "tasks");
  const controlJobId = "job-control";
  const treatmentJobId = "job-treatment";

  writeJob(jobsDir, controlJobId, "control");
  writeJob(jobsDir, treatmentJobId, "treatment");
  writeCorpus(tasksDir);

  return { root, jobsDir, tasksDir, controlJobId, treatmentJobId };
}

export function cleanupSyntheticJobTree(tree: SyntheticJobTree): void {
  fs.rmSync(tree.root, { recursive: true, force: true });
}

function writeJob(jobsDir: string, jobId: string, arm: Arm): void {
  const jobDir = path.join(jobsDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Job-level result.json: deliberately a SUMMARY only (no `trial_results`
  // key) — matches Harbor's own `exclude_trial_results=True` write path.
  // `loadJobs()` must never read trial data from this file; nothing here
  // could be mistaken for a trial dir anyway since it's a FILE, not a
  // directory, but the shape is included for realism and so a future loader
  // change that starts reading job-level result.json has a fixture to catch it.
  fs.writeFileSync(
    path.join(jobDir, "result.json"),
    JSON.stringify({ id: jobId, started_at: "2026-08-01T00:00:00Z", n_total_trials: 12, stats: {} }, null, 2),
  );
  fs.writeFileSync(
    path.join(jobDir, "lock.json"),
    JSON.stringify(
      { schema_version: 3, harbor: { version: HARBOR_VERSION }, n_concurrent_trials: 1, trials: [] },
      null,
      2,
    ),
  );

  for (const spec of buildTrialSpecs(arm)) {
    const trialName = `${spec.taskName}__${arm}-${spec.attempt}`;
    const trialDir = path.join(jobDir, trialName);
    fs.mkdirSync(trialDir, { recursive: true });
    fs.writeFileSync(
      path.join(trialDir, "result.json"),
      JSON.stringify(trialResultJson(arm, spec, trialName), null, 2),
    );
  }
}

const CORPUS_METADATA: Record<string, Record<string, string>> = {
  "task-a": { domain: "docker-homelab", slice: "train", difficulty: "easy", memory_ability: "procedural_lookup" },
  "task-b": { domain: "drillbit", slice: "train", difficulty: "medium", memory_ability: "multi_asset_composition" },
  "task-c": { domain: "inkwell", slice: "eval", difficulty: "hard", memory_ability: "conflict_resolution" },
  // task-d intentionally omitted: the missing-metadata case.
};

function writeCorpus(tasksDir: string): void {
  for (const [taskName, metadata] of Object.entries(CORPUS_METADATA)) {
    const taskDir = path.join(tasksDir, taskName);
    fs.mkdirSync(taskDir, { recursive: true });
    const lines = [
      "[metadata]",
      ...Object.entries(metadata).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    ];
    fs.writeFileSync(path.join(taskDir, "task.toml"), `${lines.join("\n")}\n`);
  }
}
