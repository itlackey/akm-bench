#!/usr/bin/env bun
/**
 * akm-bench-calibrate CLI — the `docs/comparability.md` B6 calibration gate.
 *
 * Usage:
 *   akm-bench-calibrate <jobs-dir> [--corpus <tasks-dir>] [--control-arm <arm>]
 *                       [--json <out>] [--md <out>] [--require-gate]
 *
 * Reports, per task, whether the no-skill control arm already passes it. A task
 * whose control passes cannot measure akm, and is REPORTED as such rather than
 * dropped.
 *
 * `<jobs-dir>` is the same shape `akm-bench-analyze` takes — a directory of
 * `<job>/<trial>/result.json`, NOT a single job directory.
 *
 * `--require-gate` turns the report into a CI check: exit 1 if any task fails
 * the gate. Off by default, deliberately — the v1 slice fails it by a wide
 * margin and a permanently-red default would train everyone to ignore it. It
 * is meant for a new slice that is supposed to be clean.
 */

import fs from "node:fs";
import path from "node:path";

import {
  ControlArmAmbiguousError,
  computeCalibration,
  renderCalibrationJson,
  renderCalibrationMarkdown,
} from "./calibration";
import { loadCorpusMetadata } from "./corpus";
import { loadJobs } from "./loader";

export interface CalibrateCliArgs {
  jobsDir: string;
  corpusDir: string | null;
  controlArm: string | null;
  jsonOut: string | null;
  mdOut: string | null;
  requireGate: boolean;
}

const USAGE =
  "Usage: akm-bench-calibrate <jobs-dir> [--corpus <tasks-dir>] [--control-arm <arm>] [--json <out>] [--md <out>] [--require-gate]";

export class CalibrateCliUsageError extends Error {}

export function parseArgs(argv: string[]): CalibrateCliArgs {
  let jobsDir: string | null = null;
  let corpusDir: string | null = null;
  let controlArm: string | null = null;
  let jsonOut: string | null = null;
  let mdOut: string | null = null;
  let requireGate = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        throw new CalibrateCliUsageError(USAGE);
      case "--corpus":
        corpusDir = requireValue(argv, ++i, "--corpus");
        break;
      case "--control-arm":
        controlArm = requireValue(argv, ++i, "--control-arm");
        break;
      case "--json":
        jsonOut = requireValue(argv, ++i, "--json");
        break;
      case "--md":
        mdOut = requireValue(argv, ++i, "--md");
        break;
      case "--require-gate":
        requireGate = true;
        break;
      default:
        if (arg?.startsWith("--")) throw new CalibrateCliUsageError(`unknown option: ${arg}\n${USAGE}`);
        if (jobsDir !== null) throw new CalibrateCliUsageError(`unexpected extra argument: ${arg}\n${USAGE}`);
        jobsDir = arg ?? null;
        break;
    }
  }

  if (!jobsDir) throw new CalibrateCliUsageError(`<jobs-dir> is required\n${USAGE}`);
  return { jobsDir, corpusDir, controlArm, jsonOut, mdOut, requireGate };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new CalibrateCliUsageError(`${flag} requires a value\n${USAGE}`);
  return value;
}

export function run(argv: string[]): number {
  let args: CalibrateCliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof CalibrateCliUsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const warnings: string[] = [];
  const records = loadJobs(args.jobsDir, {
    onWarning: (message) => {
      warnings.push(message);
      process.stderr.write(`warning: ${message}\n`);
    },
  });

  if (records.length === 0) {
    process.stderr.write(`warning: no trials found under ${args.jobsDir}\n`);
    return 1;
  }

  let corpus = null;
  if (args.corpusDir) {
    const index = loadCorpusMetadata(args.corpusDir);
    for (const message of index.warnings) {
      warnings.push(message);
      process.stderr.write(`warning: ${message}\n`);
    }
    corpus = index;
  }

  let report: ReturnType<typeof computeCalibration>;
  try {
    report = computeCalibration(records, {
      jobsDir: args.jobsDir,
      corpusDir: args.corpusDir,
      corpus,
      controlArm: args.controlArm,
      extraWarnings: warnings,
    });
  } catch (err) {
    if (err instanceof ControlArmAmbiguousError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  let wroteOutput = false;
  if (args.jsonOut) {
    fs.mkdirSync(path.dirname(args.jsonOut), { recursive: true });
    fs.writeFileSync(args.jsonOut, renderCalibrationJson(report));
    wroteOutput = true;
  }
  if (args.mdOut) {
    fs.mkdirSync(path.dirname(args.mdOut), { recursive: true });
    fs.writeFileSync(args.mdOut, renderCalibrationMarkdown(report));
    wroteOutput = true;
  }
  if (!wroteOutput) {
    process.stdout.write(renderCalibrationMarkdown(report));
  }

  const failing = report.totals.tasks - report.totals.discriminating;
  if (args.requireGate && failing > 0) {
    process.stderr.write(
      `error: ${failing} of ${report.totals.tasks} tasks fail the calibration gate (--require-gate)\n`,
    );
    return 1;
  }
  return 0;
}

function main() {
  process.exitCode = run(process.argv.slice(2));
}

// biome-ignore lint/suspicious/noExplicitAny: `import.meta.main` is a Bun/Node runtime extension not modeled in the project's `ImportMeta` type.
if ((import.meta as any).main) {
  main();
}
