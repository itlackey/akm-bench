## Published Reference Artifacts v1

This directory is reserved for the published `akm-bench` reference artifacts for
reference-suite `v1`.

Current status: scaffolded only. No canonical `v1` benchmark run artifacts have
been checked in here yet.

What belongs here after a real run:

- One canonical utility artifact written by:
  `bun run src/cli.ts config/reference-suite-v1.json --results-dir ./results/reference/v1`
- One canonical attribution artifact derived from that utility artifact:
  `bun run src/cli.ts attribute --base ./results/reference/v1/<utility-report>.json --top 5`
- One canonical evolve artifact from a real temporal run, typically on a domain
  with checked-in train/eval pairs such as `drillbit` or `inkwell`
- One completed `SUMMARY.md` describing the exact run conditions and headline
  outcomes

Expected artifact naming:

- Utility and evolve reports are persisted by the CLI as:
  `bench-report-<track>-<branch>-<commit>-<timestamp>-<model>.json`
- Attribution reports are currently printed to stdout by `bench attribute`; save
  the JSON under a publication-oriented filename such as
  `attribute-<branch>-<commit>-<timestamp>-<model>.json`

Required run metadata before publishing:

- Git branch and commit SHA used for the run
- UTC timestamp of the run
- Model identifier stamped into the report
- Exact commands used
- Seeds and parallelism
- Corpus identity fields from the utility artifact:
  `selectedTaskIds`, `taskCorpusHash`, `fixtures`, and `fixtureContentHash`
- Any relevant environment or provider settings needed to reproduce the run
- Notes on known warnings, partial failures, or reasons an artifact should not be
  treated as canonical

Do not add benchmark numbers here unless they come from a real persisted run
artifact checked into this directory.
