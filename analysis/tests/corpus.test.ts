/**
 * Unit tests for `analysis/src/corpus.ts`.
 */

import { describe, expect, test } from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { joinCorpus, loadCorpusMetadata } from "../src/corpus";
import { buildSyntheticJobTree, cleanupSyntheticJobTree, TASK_NAMES, TASK_WITH_NO_METADATA } from "./fixtures";

describe("loadCorpusMetadata", () => {
  test("returns an empty index without throwing when tasksDir does not exist", () => {
    const index = loadCorpusMetadata("/nonexistent/tasks/dir");
    expect(index.byTaskName.size).toBe(0);
    expect(index.warnings).toEqual([]);
  });

  test("indexes the 3 fixture tasks that carry a task.toml (task-d is deliberately absent)", () => {
    const tree = buildSyntheticJobTree();
    try {
      const index = loadCorpusMetadata(tree.tasksDir);
      expect(index.byTaskName.size).toBe(3);
      expect(index.byTaskName.has(TASK_WITH_NO_METADATA)).toBe(false);
      for (const taskName of TASK_NAMES) {
        if (taskName === TASK_WITH_NO_METADATA) continue;
        expect(index.byTaskName.has(taskName)).toBe(true);
      }
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("parses typed metadata fields via Bun.TOML", () => {
    const tree = buildSyntheticJobTree();
    try {
      const index = loadCorpusMetadata(tree.tasksDir);
      const taskA = index.byTaskName.get("task-a");
      expect(taskA?.domain).toBe("docker-homelab");
      expect(taskA?.slice).toBe("train");
      expect(taskA?.difficulty).toBe("easy");
      expect(taskA?.memoryAbility).toBe("procedural_lookup");
      expect(taskA?.raw.domain).toBe("docker-homelab");
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("a task.toml with no [metadata] table is indexed with empty metadata plus a warning, not skipped", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-corpus-test-"));
    try {
      const taskDir = path.join(root, "task-x");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, "task.toml"), '[environment]\ntype = "docker"\n');

      const index = loadCorpusMetadata(root);
      expect(index.byTaskName.has("task-x")).toBe(true);
      expect(index.byTaskName.get("task-x")?.raw).toEqual({});
      expect(index.byTaskName.get("task-x")?.domain).toBeUndefined();
      expect(index.warnings.some((w) => w.includes("no [metadata] table"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("indexes by the [task].name join key, not just the directory basename (regression: Harbor's TrialResult.task_name is config.task.name whenever [task] is present, verified against models/task/task.py -- every converted akm-bench task sets one, and it never equals the directory basename)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-corpus-test-"));
    try {
      const taskDir = path.join(root, "inkwell--set-rate-limit");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, "task.toml"),
        [
          'schema_version = "1.4"',
          "",
          "[task]",
          'name = "akm-bench/inkwell--set-rate-limit"',
          'version = "1.0.0"',
          "",
          "[metadata]",
          'domain = "inkwell"',
          "",
        ].join("\n"),
      );

      const index = loadCorpusMetadata(root);
      // The REAL join key Harbor writes to result.json's task_name:
      const declared = index.byTaskName.get("akm-bench/inkwell--set-rate-limit");
      expect(declared).toBeDefined();
      expect(declared?.domain).toBe("inkwell");
      expect(declared?.taskName).toBe("akm-bench/inkwell--set-rate-limit");
      // Also reachable by the directory basename, for a task-less-[task] caller.
      const byBasename = index.byTaskName.get("inkwell--set-rate-limit");
      expect(byBasename).toBe(declared);

      const join = joinCorpus(["akm-bench/inkwell--set-rate-limit"], index);
      expect(join.matched).toEqual(["akm-bench/inkwell--set-rate-limit"]);
      expect(join.missingTaskNames).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a task.toml that fails to parse is warned about and excluded, not thrown", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bench-corpus-test-"));
    try {
      const taskDir = path.join(root, "task-broken");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(path.join(taskDir, "task.toml"), "this is [ not valid toml =====");

      const index = loadCorpusMetadata(root);
      expect(index.byTaskName.has("task-broken")).toBe(false);
      expect(index.warnings.some((w) => w.includes("task-broken") && w.includes("could not parse TOML"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("joinCorpus", () => {
  test("left-joins task names against the index, reporting missing ones without crashing", () => {
    const tree = buildSyntheticJobTree();
    try {
      const index = loadCorpusMetadata(tree.tasksDir);
      const result = joinCorpus(TASK_NAMES, index);
      expect(result.matched).toEqual(["task-a", "task-b", "task-c"]);
      expect(result.missingTaskNames).toEqual(["task-d"]);
    } finally {
      cleanupSyntheticJobTree(tree);
    }
  });

  test("an empty index reports every task name as missing", () => {
    const result = joinCorpus(["x", "y"], { byTaskName: new Map(), warnings: [] });
    expect(result.matched).toEqual([]);
    expect(result.missingTaskNames).toEqual(["x", "y"]);
  });
});
