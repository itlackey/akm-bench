export interface BenchRuntimeProvenance {
  akmVersion: string;
  opencodeVersion: string;
  bunVersion: string;
  akmMode?: string;
  containerImage?: string;
  benchmarkCommit?: string;
  benchmarkDirty?: boolean;
}

/**
 * Read runtime identity established by the container entrypoint.
 *
 * The supported Docker path resolves the executable versions before the
 * benchmark starts and fails on an image-pin mismatch. Host-native callers
 * do not get invented provenance: absent entrypoint values leave this block
 * out of the report.
 */
export function readBenchRuntimeProvenance(
  env: Record<string, string | undefined> = process.env,
): BenchRuntimeProvenance | undefined {
  const akmVersion = env.AKM_BENCH_RUNTIME_AKM_VERSION?.trim();
  const opencodeVersion = env.AKM_BENCH_RUNTIME_OPENCODE_VERSION?.trim();
  if (!akmVersion || !opencodeVersion) return undefined;

  const dirtyRaw = env.AKM_BENCH_IMAGE_REPO_DIRTY?.trim();
  return {
    akmVersion,
    opencodeVersion,
    bunVersion: process.versions.bun ?? "unknown",
    ...(env.BENCH_DOCKER_AKM_MODE?.trim() ? { akmMode: env.BENCH_DOCKER_AKM_MODE.trim() } : {}),
    ...(env.BENCH_CONTAINER_IMAGE?.trim() ? { containerImage: env.BENCH_CONTAINER_IMAGE.trim() } : {}),
    ...(env.AKM_BENCH_IMAGE_REPO_COMMIT?.trim() ? { benchmarkCommit: env.AKM_BENCH_IMAGE_REPO_COMMIT.trim() } : {}),
    ...(dirtyRaw === "true" || dirtyRaw === "false" ? { benchmarkDirty: dirtyRaw === "true" } : {}),
  };
}
