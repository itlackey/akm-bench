## Published Reference Artifacts v1

This directory contains the published `akm-bench` reference artifacts for
reference-suite `v1`.

Status: **published** — see `SUMMARY.md` for the authoritative record of run
conditions, environment, and headline results.

### Published Artifacts

- **Utility report**: `bench-report-utility-main-a8ee9f9-2026-05-06T07-23-55.557Z-shredder-qwen-qwen3.5-9b.json`
- **Attribution report**: `bench-report-attribute-main-a8ee9f9-2026-05-06-shredder-qwen-qwen3.5-9b.json`
- **Evolve report**: `bench-report-evolve-main-a8ee9f9-2026-05-06T08-06-28.627Z-shredder-qwen-qwen3.5-9b.json`

### Run Summary

- Model: `shredder/qwen/qwen3.5-9b` via LM Studio (`http://192.168.0.99:1234/v1`)
- Branch: `main`, Commit: `a8ee9f9`, Date: `2026-05-06`
- Utility `aggregate.akm.pass_rate`: **80.77%** (26 tasks across 5 domains)
- Attribution: all 5 domain skills tied at **+0.808** marginal contribution
- Evolve: `no_improvement_detected` (drillbit already at 100% pre-evolve)

### How These Were Generated

```sh
# Utility
bun run src/cli.ts config/reference-suite-v1.json --results-dir ./results/reference/v1

# Attribution
bun run src/cli.ts attribute --base ./results/reference/v1/<utility-report>.json --top 5

# Evolve
bun run src/cli.ts evolve --tasks drillbit --seeds 5 --results-dir ./results/reference/v1
```
