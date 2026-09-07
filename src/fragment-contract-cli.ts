import fs from "node:fs";
import path from "node:path";
import {
  compareFragmentContractReports,
  type FragmentContractExpectation,
  readFragmentContractReport,
  runFragmentContract,
} from "./fragment-contract";

function usage(): string {
  return `Usage:
  bun run src/fragment-contract-cli.ts run [--expect baseline|candidate] [--akm-bin PATH] [--output FILE]
  bun run src/fragment-contract-cli.ts compare --baseline FILE --candidate FILE [--output FILE]

The run is deterministic, isolated, and does not call a model. Use baseline for
AKM 0.9.14 and candidate for the local 0.9.15 implementation.`;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function writeResult(value: unknown, outputPath?: string): void {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (outputPath) {
    const absolute = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, rendered, "utf8");
  }
  process.stdout.write(rendered);
}

function validateFlags(args: string[], allowed: Set<string>): void {
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token) continue;
    if (!token.startsWith("--")) continue;
    if (!allowed.has(token)) throw new Error(`unknown option: ${token}`);
    index++;
  }
}

function run(args: string[]): number {
  validateFlags(args, new Set(["--expect", "--akm-bin", "--output"]));
  const expectation = (valueAfter(args, "--expect") ?? "candidate") as FragmentContractExpectation;
  if (expectation !== "baseline" && expectation !== "candidate") {
    throw new Error("--expect must be baseline or candidate");
  }
  const akmBin = valueAfter(args, "--akm-bin");
  const output = valueAfter(args, "--output");
  const report = runFragmentContract({
    expectation,
    ...(akmBin ? { akmCommand: [path.resolve(akmBin)] } : {}),
  });
  writeResult(report, output);
  return report.summary.gatePassed ? 0 : 1;
}

function compare(args: string[]): number {
  validateFlags(args, new Set(["--baseline", "--candidate", "--output"]));
  const baselinePath = valueAfter(args, "--baseline");
  const candidatePath = valueAfter(args, "--candidate");
  if (!baselinePath || !candidatePath) throw new Error("compare requires --baseline and --candidate");
  const comparison = compareFragmentContractReports(
    readFragmentContractReport(path.resolve(baselinePath)),
    readFragmentContractReport(path.resolve(candidatePath)),
  );
  writeResult(comparison, valueAfter(args, "--output"));
  return comparison.gatePassed ? 0 : 1;
}

function main(argv: string[]): number {
  const [subcommand, ...args] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (subcommand === "run") return run(args);
  if (subcommand === "compare") return compare(args);
  throw new Error(`unknown subcommand: ${subcommand}\n${usage()}`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
