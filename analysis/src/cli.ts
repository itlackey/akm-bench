#!/usr/bin/env bun
/**
 * akm-bench-analyze CLI (implementation brief §6 / plan phase P1).
 *
 * Usage:
 *   akm-bench-analyze <jobs-dir> [--corpus <tasks-dir>] [--json <out>] [--md <out>]
 *
 * `<jobs-dir>` is walked per `loader.ts` (a directory of `jobs/<job>/<trial>/result.json`).
 * `--corpus <tasks-dir>` left-joins each task's `task.toml` `[metadata]` (`corpus.ts`).
 * With neither `--json` nor `--md`, the markdown report is printed to stdout.
 * Any loader/corpus warning is printed to stderr AND folded into the report's
 * own disclosure block, so the CLI's stderr output is a superset convenience,
 * never the only place a warning is recorded.
 */

import fs from "node:fs";
import path from "node:path";

import { loadJobs } from "./loader";
import { buildAnalysisReport, renderJson, renderMarkdown } from "./report";

export interface CliArgs {
  jobsDir: string;
  corpusDir: string | null;
  jsonOut: string | null;
  mdOut: string | null;
}

const USAGE = "Usage: akm-bench-analyze <jobs-dir> [--corpus <tasks-dir>] [--json <out>] [--md <out>]";

export class CliUsageError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  let jobsDir: string | null = null;
  let corpusDir: string | null = null;
  let jsonOut: string | null = null;
  let mdOut: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        throw new CliUsageError(USAGE);
      case "--corpus":
        corpusDir = requireValue(argv, ++i, "--corpus");
        break;
      case "--json":
        jsonOut = requireValue(argv, ++i, "--json");
        break;
      case "--md":
        mdOut = requireValue(argv, ++i, "--md");
        break;
      default:
        if (arg?.startsWith("--")) throw new CliUsageError(`unknown option: ${arg}\n${USAGE}`);
        if (jobsDir !== null) throw new CliUsageError(`unexpected extra argument: ${arg}\n${USAGE}`);
        jobsDir = arg ?? null;
        break;
    }
  }

  if (!jobsDir) throw new CliUsageError(`<jobs-dir> is required\n${USAGE}`);
  return { jobsDir, corpusDir, jsonOut, mdOut };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new CliUsageError(`${flag} requires a value\n${USAGE}`);
  return value;
}

export function run(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
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
  }

  const report = buildAnalysisReport(records, {
    jobsDir: args.jobsDir,
    corpusDir: args.corpusDir,
    extraWarnings: warnings,
  });

  let wroteOutput = false;
  if (args.jsonOut) {
    fs.mkdirSync(path.dirname(args.jsonOut), { recursive: true });
    fs.writeFileSync(args.jsonOut, renderJson(report));
    wroteOutput = true;
  }
  if (args.mdOut) {
    fs.mkdirSync(path.dirname(args.mdOut), { recursive: true });
    fs.writeFileSync(args.mdOut, renderMarkdown(report));
    wroteOutput = true;
  }
  if (!wroteOutput) {
    process.stdout.write(renderMarkdown(report));
  }

  // A well-formed, valid-looking report over ZERO trials is a silent CI
  // green light for a broken invocation (wrong --jobs-dir, a directory one
  // level off Harbor's <jobsDir>/<job>/<trial>/result.json shape, a job that
  // never actually ran). The report is still written above -- the data
  // that WAS found (none) is real and worth keeping -- but the exit code
  // must not claim success for it.
  return records.length === 0 ? 1 : 0;
}

function main() {
  process.exitCode = run(process.argv.slice(2));
}

// Bun (and Node >= 20.11) exposes `import.meta.main`; guarding on it keeps
// `run()`/`parseArgs()` importable from tests without executing the CLI.
// biome-ignore lint/suspicious/noExplicitAny: `import.meta.main` is a Bun/Node runtime extension not modeled in the project's `ImportMeta` type.
if ((import.meta as any).main) {
  main();
}
