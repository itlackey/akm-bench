/**
 * Unit tests for `analysis/src/loader.ts`.
 */

import { describe, expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { deriveArm, loadJobs, parseTrialResult, readTrialToolUse } from "../src/loader";
import { buildSyntheticJobTree, CONTROL_ARM, cleanupSyntheticJobTree, TASK_NAMES, TREATMENT_ARM } from "./fixtures";

describe("deriveArm", () => {
  test("joins agent name, version and model with the documented separators", () => {
    // Harbor stores the BARE model in ModelInfo.name and the provider
    // separately; deriveArm rejoins them.
    expect(deriveArm("opencode", "1.18.21", "claude-sonnet-4-5", "anthropic")).toBe(
      "opencode@1.18.21//anthropic/claude-sonnet-4-5",
    );
  });

  test("keeps the provider, so two providers of the same model are different arms", () => {
    const anthropic = deriveArm("opencode", "1.18.21", "claude-sonnet-4-5", "anthropic");
    const bedrock = deriveArm("opencode", "1.18.21", "claude-sonnet-4-5", "bedrock");
    expect(anthropic).not.toBe(bedrock);
    expect(anthropic).toContain("anthropic/");
    expect(bedrock).toContain("bedrock/");
  });

  test("omits the provider segment when Harbor recorded no provider", () => {
    expect(deriveArm("opencode", "1.18.21", "some-local-model", null)).toBe("opencode@1.18.21//some-local-model");
  });

  test("falls back to the literal 'none' when no model is recorded", () => {
    expect(deriveArm("oracle", "1.0.0", null)).toBe("oracle@1.0.0//none");
  });

  test("never produces Harbor's own '__' evals-key separator", () => {
    const arm = deriveArm("akm-opencode", "1.18.21+akm-opencode@0.9.1", "claude-sonnet-4-5", "anthropic");
    expect(arm).not.toContain("__");
  });

  test("empty kwargs add no digest suffix", () => {
    expect(deriveArm("opencode", "1.18.21", "claude-sonnet-4-5", "anthropic", {})).toBe(
      "opencode@1.18.21//anthropic/claude-sonnet-4-5",
    );
  });

  test("D7: arms differing ONLY in shared_bundle_path do not collapse into one label", () => {
    // The akm-static / akm-accumulating pair in harbor/jobs/tb2-ab.yaml. Both
    // are the same class at the same pins, so if AkmOpenCode's per-arm
    // agent_info.name were ever lost, agent_info alone could not tell them
    // apart — the kwargs digest is the second, independent guard. Decision D7
    // forbids pooling these two.
    const staticArm = deriveArm("akm-opencode", "1.18.21+p", "claude-sonnet-4-5", "anthropic", {
      version: "1.18.21",
    });
    const accumulatingArm = deriveArm("akm-opencode", "1.18.21+p", "claude-sonnet-4-5", "anthropic", {
      version: "1.18.21",
      shared_bundle_path: "/shared/akm-bundle",
    });
    expect(staticArm).not.toBe(accumulatingArm);
  });

  test("the kwargs digest is stable under key reordering", () => {
    const a = deriveArm("x", "1", "m", "p", { b: 2, a: 1, nested: { z: 1, y: 2 } });
    const b = deriveArm("x", "1", "m", "p", { a: 1, nested: { y: 2, z: 1 }, b: 2 });
    expect(a).toBe(b);
  });
});

describe("loadJobs", () => {
  test("returns [] without throwing when jobsDir does not exist", () => {
    expect(loadJobs("/nonexistent/jobs/dir")).toEqual([]);
  });

  test("walks the synthetic fixture and finds exactly 24 trials", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      expect(records).toHaveLength(24);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("every trial resolves to one of the two expected arms, 12 trials each", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const byArm = new Map<string, number>();
      for (const r of records) byArm.set(r.arm, (byArm.get(r.arm) ?? 0) + 1);
      expect(byArm.get(CONTROL_ARM)).toBe(12);
      expect(byArm.get(TREATMENT_ARM)).toBe(12);
      expect(byArm.size).toBe(2);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("every task name in the fixture is represented, 6 trials each (2 arms x 3 attempts)", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const byTask = new Map<string, number>();
      for (const r of records) byTask.set(r.taskName, (byTask.get(r.taskName) ?? 0) + 1);
      for (const taskName of TASK_NAMES) expect(byTask.get(taskName)).toBe(6);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("never reads trial data from the job-level result.json summary", () => {
    const tree = buildSyntheticJobTree();
    try {
      const jobResult = JSON.parse(fs.readFileSync(path.join(tree.jobsDir, tree.controlJobId, "result.json"), "utf8"));
      expect(jobResult.trial_results).toBeUndefined();
      // If the loader ever mistakenly walked into job-level result.json as a
      // "trial", the trial count assertions elsewhere in this file would
      // fail (24, not 25) — this test documents the fixture's intent
      // explicitly rather than relying on that as an accidental side effect.
      const records = loadJobs(tree.jobsDir);
      expect(records.every((r) => r.trialName !== "result.json")).toBe(true);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("finds the one errored trial (control / task-a / attempt 3)", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const errored = records.filter((r) => r.errored);
      expect(errored).toHaveLength(1);
      expect(errored[0]?.taskName).toBe("task-a");
      expect(errored[0]?.arm).toBe(CONTROL_ARM);
      expect(errored[0]?.exceptionType).toBe("AkmPluginNotLoadedError");
      expect(errored[0]?.reward).toBeNull();
      expect(errored[0]?.rewards).toBeNull();
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("finds the one null-token trial (treatment / task-b / attempt 1) — reward still present", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const nullToken = records.find(
        (r) => r.arm === TREATMENT_ARM && r.taskName === "task-b" && r.tokens.inputTokens === null,
      );
      expect(nullToken).toBeDefined();
      expect(nullToken?.tokens).toEqual({ inputTokens: null, cacheTokens: null, outputTokens: null, costUsd: null });
      expect(nullToken?.errored).toBe(false);
      expect(nullToken?.reward).toBe(1);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("finds the one multi-key reward trial (control / task-c / attempt 2)", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const multiKey = records.find((r) => Object.keys(r.otherRewards).length > 0);
      expect(multiKey).toBeDefined();
      expect(multiKey?.taskName).toBe("task-c");
      expect(multiKey?.arm).toBe(CONTROL_ARM);
      expect(multiKey?.reward).toBe(1);
      expect(multiKey?.otherRewards).toEqual({ workflow_compliance: 0.8 });
      expect(multiKey?.rewards).toEqual({ reward: 1, workflow_compliance: 0.8 });
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("carries provenance (task_checksum, agent kwargs) through", () => {
    const tree = buildSyntheticJobTree();
    try {
      const records = loadJobs(tree.jobsDir);
      const treatmentRecord = records.find((r) => r.arm === TREATMENT_ARM && r.taskName === "task-a" && !r.errored);
      expect(treatmentRecord?.provenance.taskChecksum).toBe("sha256:task-a-checksum");
      expect(treatmentRecord?.provenance.agentImportPath).toBe("harbor.akm_opencode:AkmOpenCode");
      expect(treatmentRecord?.provenance.agentKwargs.akm_cli_spec).toBe("akm-cli@0.9.1");

      const controlRecord = records.find((r) => r.arm === CONTROL_ARM && r.taskName === "task-b");
      expect(controlRecord?.provenance.agentImportPath).toBeNull();
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("collects warnings instead of throwing on a malformed result.json", () => {
    const tree = buildSyntheticJobTree();
    try {
      const badTrialDir = path.join(tree.jobsDir, tree.controlJobId, "task-a__control-malformed");
      fs.mkdirSync(badTrialDir, { recursive: true });
      fs.writeFileSync(path.join(badTrialDir, "result.json"), "{ not valid json");

      const warnings: string[] = [];
      const records = loadJobs(tree.jobsDir, { onWarning: (m) => warnings.push(m) });

      expect(records).toHaveLength(24); // the malformed trial is skipped, not counted
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("task-a__control-malformed");
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("collects a warning (not a throw) for a result.json missing required identity fields", () => {
    const tree = buildSyntheticJobTree();
    try {
      const incompleteDir = path.join(tree.jobsDir, tree.controlJobId, "task-a__control-incomplete");
      fs.mkdirSync(incompleteDir, { recursive: true });
      fs.writeFileSync(path.join(incompleteDir, "result.json"), JSON.stringify({ task_name: "task-a" }));

      const warnings: string[] = [];
      const records = loadJobs(tree.jobsDir, { onWarning: (m) => warnings.push(m) });

      expect(records).toHaveLength(24);
      expect(warnings.some((w) => w.includes("not a recognizable Harbor TrialResult"))).toBe(true);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });
});

describe("parseTrialResult", () => {
  const location = { jobId: "job-1", trialName: "task-a__1", trialDir: "/jobs/job-1/task-a__1" };

  test("returns undefined when task_name is missing", () => {
    expect(parseTrialResult({ agent_info: { name: "opencode", version: "1.0" } }, location)).toBeUndefined();
  });

  test("returns undefined for non-object input", () => {
    expect(parseTrialResult(null, location)).toBeUndefined();
    expect(parseTrialResult("not an object", location)).toBeUndefined();
    expect(parseTrialResult(42, location)).toBeUndefined();
  });

  test("multi-step fallback: sums per-step agent_result when the top-level agent_result is absent", () => {
    const record = parseTrialResult(
      {
        task_name: "task-a",
        agent_info: { name: "opencode", version: "1.0" },
        agent_result: null,
        step_results: [
          { step_name: "s1", agent_result: { n_input_tokens: 10, n_output_tokens: 20, cost_usd: 0.1 } },
          { step_name: "s2", agent_result: { n_input_tokens: 5, n_output_tokens: null, cost_usd: 0.2 } },
        ],
      },
      location,
    );
    expect(record?.tokens.inputTokens).toBe(15);
    expect(record?.tokens.outputTokens).toBe(20); // only s1 reported output; null is not the same as 0
    expect(record?.tokens.costUsd).toBeCloseTo(0.3);
    expect(record?.tokens.cacheTokens).toBeNull(); // no step ever reported it
  });
});

/**
 * End-to-end regression for decision D7's three-arm shape
 * (`harbor/jobs/tb2-ab.yaml`, `harbor/jobs/swebench-ab.yaml`).
 *
 * The failure this locks out was reproduced against a job tree serialized by
 * Harbor's OWN pydantic models: baseline / akm-static / akm-accumulating
 * collapsed to TWO arm rows, because `agent_info` is identical on the two
 * treatment arms and the loader keyed only off it. The reported treatment
 * mean was then the average of a 100%-passing arm and a 0%-passing arm —
 * a number describing neither, published under one label.
 *
 * Two independent guards must both hold:
 *   1. `AkmOpenCode.arm_name()` gives the accumulating arm a distinct
 *      `agent_info.name` (`akm-opencode-accumulating`).
 *   2. `deriveArm()` folds `config.agent.kwargs` into the label, so the two
 *      stay apart even in results written before guard 1 existed.
 */
describe("three-arm (D7) separation", () => {
  const AKM_VERSION = "1.18.21+akm-opencode@0.9.202808220049";

  function trialPayload(agentName: string, kwargs: Record<string, unknown>, taskName: string, reward: number) {
    return {
      task_name: taskName,
      trial_name: `${taskName}__x`,
      task_checksum: "sha256:abc",
      config: {
        agent: {
          import_path: "harbor.akm_opencode:AkmOpenCode",
          model_name: "anthropic/claude-sonnet-4-5",
          kwargs,
          env: {},
        },
      },
      agent_info: {
        name: agentName,
        version: AKM_VERSION,
        model_info: { name: "claude-sonnet-4-5", provider: "anthropic" },
      },
      verifier_result: { rewards: { reward } },
    };
  }

  const loc = { jobId: "j", trialName: "t", trialDir: "/tmp/t" };

  test("guard 1: a distinct agent_info.name separates static from accumulating", () => {
    const staticRec = parseTrialResult(trialPayload("akm-opencode", { version: "1.18.21" }, "task-a", 1), loc);
    const accRec = parseTrialResult(
      trialPayload(
        "akm-opencode-accumulating",
        { version: "1.18.21", shared_bundle_path: "/shared/akm-bundle" },
        "task-a",
        0,
      ),
      loc,
    );
    expect(staticRec?.arm).not.toBe(accRec?.arm);
    expect(accRec?.arm).toContain("akm-opencode-accumulating");
  });

  test("guard 2: kwargs alone separate them even when agent_info is byte-identical", () => {
    // Exactly the pre-fix result.json shape: same name, same version, same
    // model — only `shared_bundle_path` differs.
    const staticRec = parseTrialResult(trialPayload("akm-opencode", { version: "1.18.21" }, "task-a", 1), loc);
    const accRec = parseTrialResult(
      trialPayload("akm-opencode", { version: "1.18.21", shared_bundle_path: "/shared/akm-bundle" }, "task-a", 0),
      loc,
    );
    expect(staticRec?.agentName).toBe(accRec?.agentName);
    expect(staticRec?.agentVersion).toBe(accRec?.agentVersion);
    expect(staticRec?.arm).not.toBe(accRec?.arm);
  });

  test("a full three-arm tree loads as THREE arms, not two", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-three-arm-"));
    try {
      const jobDir = path.join(root, "jobs", "akm-tb2-ab");
      fs.mkdirSync(jobDir, { recursive: true });
      const arms: [string, Record<string, unknown>, number][] = [
        ["opencode", { version: "1.18.21" }, 0],
        ["akm-opencode", { version: "1.18.21" }, 1],
        ["akm-opencode-accumulating", { version: "1.18.21", shared_bundle_path: "/shared/akm-bundle" }, 0],
      ];
      for (const [name, kwargs, reward] of arms) {
        for (const taskName of ["task-a", "task-b"]) {
          const trialDir = path.join(jobDir, `${taskName}__${name}`);
          fs.mkdirSync(trialDir, { recursive: true });
          fs.writeFileSync(
            path.join(trialDir, "result.json"),
            JSON.stringify(trialPayload(name, kwargs, taskName, reward)),
          );
        }
      }
      const records = loadJobs(path.join(root, "jobs"));
      expect(records).toHaveLength(6);
      expect(new Set(records.map((r) => r.arm)).size).toBe(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readTrialToolUse", () => {
  function withTrajectory(lines: string[] | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-tooluse-"));
    if (lines !== null) {
      fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agent", "opencode.txt"), lines.join("\n"));
    }
    return dir;
  }

  const toolEvent = (tool: string) => JSON.stringify({ type: "tool_use", part: { type: "tool", tool } });

  test("counts akm_* calls apart from every other tool", () => {
    const dir = withTrajectory([
      toolEvent("akm_curate"),
      toolEvent("write"),
      toolEvent("akm_show"),
      toolEvent("akm_show"),
      JSON.stringify({ type: "step_start" }),
    ]);
    const use = readTrialToolUse(dir);
    expect(use.akmCalls).toBe(3);
    expect(use.totalCalls).toBe(4);
    expect(use.byTool).toEqual({ akm_curate: 1, write: 1, akm_show: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a readable trajectory with no akm call is 0, not null", () => {
    // The distinction the whole metric rests on: the model was offered the
    // tools and did not use them, which is a finding -- not missing data.
    const dir = withTrajectory([toolEvent("write"), toolEvent("glob")]);
    const use = readTrialToolUse(dir);
    expect(use.akmCalls).toBe(0);
    expect(use.totalCalls).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a missing trajectory is null, not 0", () => {
    // A trial that errored before writing one must never be counted as
    // evidence that the model declined to call akm.
    const dir = withTrajectory(null);
    const use = readTrialToolUse(dir);
    expect(use.akmCalls).toBeNull();
    expect(use.totalCalls).toBeNull();
    expect(use.byTool).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("skips malformed lines instead of throwing", () => {
    const dir = withTrajectory(["not json at all", "{broken", "", toolEvent("akm_search")]);
    expect(readTrialToolUse(dir).akmCalls).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
