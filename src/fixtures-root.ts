import path from "node:path";

const DEFAULT_FIXTURES_ROOT = path.resolve(import.meta.dir, "..", "fixtures");

export function getFixturesRoot(): string {
  const override = process.env.BENCH_FIXTURES_DIR?.trim();
  return override ? path.resolve(override) : DEFAULT_FIXTURES_ROOT;
}

export function getStashesRoot(): string {
  return path.join(getFixturesRoot(), "stashes");
}

export function getCorpusRoot(): string {
  return path.join(getFixturesRoot(), "corpus");
}

export function getTasksRootFromFixtures(): string {
  return path.join(getCorpusRoot(), "tasks");
}

export function getWorkflowsRoot(): string {
  return path.join(getCorpusRoot(), "workflows");
}
