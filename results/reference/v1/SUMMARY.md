## Reference Suite v1 Summary

Status: pending canonical run publication.

Fill this file only from real artifacts stored in this directory.

### Publication Record

- Suite: `reference-suite-v1`
- Status: `pending`
- Published by:
- Date (UTC):
- Branch:
- Commit:

### Environment

- Harness: `opencode`
- Model:
- Opencode config ref / source:
- Host / runtime notes:
- `BENCH_OPENCODE_MODEL`:
- Other relevant env vars:

### Commands Used

```sh
# Utility
bun run src/cli.ts config/reference-suite-v1.json --results-dir ./results/reference/v1

# Attribution
bun run src/cli.ts attribute --base ./results/reference/v1/<utility-report>.json --top 5 > ./results/reference/v1/attribute-<branch>-<commit>-<timestamp>-<model>.json

# Evolve (example domain; replace if another canonical domain is chosen)
bun run src/cli.ts evolve --tasks drillbit --seeds 5 --results-dir ./results/reference/v1
```

### Input Metadata

- Seeds per arm:
- Parallelism:
- Budget tokens:
- Budget wall ms:
- Reference task list source: `config/reference-suite-v1.json`
- Utility `selectedTaskIds`:
- Utility `taskCorpusHash`:
- Utility `fixtureContentHash`:
- Utility `fixtures` map:

### Published Artifacts

- Utility report:
- Attribution report:
- Evolve report:

### Headline Results

Do not fill this section until the corresponding checked-in artifacts exist.

- Utility `aggregate.akm.pass_rate`:
- Utility `aggregate.akm.tokens_per_pass`:
- Utility `aggregate.akm.tokens_per_run`:
- Utility `aggregate.akm.wallclock_ms`:
- Attribution top assets summary:
- Evolve `longitudinal.interpretation`:
- Evolve `longitudinal.improvement_slope`:
- Evolve `longitudinal.over_synthetic_lift`:
- Evolve degradation count:

### Notes

- Warnings observed:
- Deviations from the default workflow:
- Publication caveats:
