## Reference Suite v1 Summary

Status: **published**.

### Publication Record

- Suite: `reference-suite-v1`
- Status: `published`
- Published by: opencode agent
- Date (UTC): `2026-05-06`
- Branch: `main`
- Commit: `a8ee9f9`

### Environment

- Harness: `opencode`
- Model: `shredder/qwen/qwen3.5-9b`
- Opencode config ref / source: `config/opencode.local.json`
- Host / runtime notes: local LM Studio endpoint at `http://192.168.0.99:1234/v1`
- `BENCH_OPENCODE_MODEL`: `shredder/qwen/qwen3.5-9b`

### Commands Used

```sh
# Utility
bun run src/cli.ts config/reference-suite-v1.json --results-dir ./results/reference/v1

# Attribution
bun run src/cli.ts attribute --base ./results/reference/v1/bench-report-utility-main-a8ee9f9-2026-05-06T07-23-55.557Z-shredder-qwen-qwen3.5-9b.json --top 5 > ./results/reference/v1/bench-report-attribute-main-a8ee9f9-2026-05-06-shredder-qwen-qwen3.5-9b.json

# Evolve
bun run src/cli.ts evolve --tasks drillbit --seeds 5 --results-dir ./results/reference/v1
```

### Input Metadata

- Seeds per arm: `5`
- Parallelism: `1` (sequential)
- Budget tokens: `30000`
- Budget wall ms: `120000`
- Reference task list source: `config/reference-suite-v1.json`
- Utility `selectedTaskIds`: 26 tasks (az-cli:5, docker-homelab:6, drillbit:5, inkwell:6, opencode:4)
- Utility `taskCorpusHash`: `cfeaefe318bd871a9faf3d80130bc5701f9dc1115298b1e76440f73e1d502af0`
- Utility `fixtureContentHash`: `dc0e23c95f9b170504b484ef8133a759fee7885bbafe90755b7b9704e4a34cc1`

### Published Artifacts

- Utility report: `bench-report-utility-main-a8ee9f9-2026-05-06T07-23-55.557Z-shredder-qwen-qwen3.5-9b.json`
- Attribution report: `bench-report-attribute-main-a8ee9f9-2026-05-06-shredder-qwen-qwen3.5-9b.json`
- Evolve report: `bench-report-evolve-main-a8ee9f9-2026-05-06T08-06-28.627Z-shredder-qwen-qwen3.5-9b.json`

### Headline Results

- Utility `aggregate.akm.pass_rate`: **80.77%**
- Utility `aggregate.noakm.pass_rate`: **0%** (noakm arm not included in v1 config — not a measured baseline)
- Utility delta (akm − noakm): **+80.77pp** (equals raw akm pass rate; not a true lift measurement)
- Utility `aggregate.akm.tokens_per_pass`: `23575.7`
- Utility `aggregate.akm.tokens_per_run`: `23661.7`
- Utility `aggregate.akm.wallclock_ms`: `45037` (~45s per task)
- Attribution top assets: all 5 domain skills tied at **+0.808** marginal contribution (skill:inkwell, skill:docker-homelab, skill:az-cli, skill:drillbit, skill:opencode) — each essential for its domain
- Evolve `longitudinal.interpretation`: **no_improvement_detected**
- Evolve `longitudinal.improvement_slope`: `-0.04` (slightly negative — pre was 100%, post was 96%)
- Evolve `longitudinal.over_synthetic_lift`: pre=1.0, post=0.96, synthetic=0.32
- Evolve degradation count: `1` (single post-task failure out of 25)
- Evolve lessons accepted: `0` (drillbit tasks already at ceiling — no failures to learn from)

### Notes

- **noakm arm was not run** — the v1 config specifies `arms: ["akm"]` only. The reported `noakm.pass_rate: 0%` reflects zero runs, not a measured baseline. The delta (+80.77pp) is therefore the raw akm pass rate, not a true akm-vs-noakm lift.
- **Why akm-only?** Roughly half the suite (drillbit, inkwell, opencode meta-tasks) genuinely requires AKM assets — they reference proprietary CLI syntax or YAML schemas no model could know from training data. The remaining tasks (az-cli, docker-homelab) use public-domain knowledge and *could* run without AKM, but the suite was designed as a single-arm reference run. A future v2 suite should include `arms: ["noakm", "akm"]` to produce a true delta.
- Primary failure mode: `loaded_ignored` (25/130 runs) — concentrated in docker-homelab and inkwell domains
- Workflow overall compliance: `68.28%` (1364 violations across 6 workflow rules)
- Top violation codes: `missing_required_event` (681), `wrong_feedback_polarity` (461), `wrong_order` (121)
- Evolve result is expected: drillbit tasks were already at 100% pre-evolve pass rate, leaving no room for improvement. The statistical guard correctly reports `no_improvement_detected` rather than claiming noise as signal.
- Token measurement: 100% coverage, reliable
