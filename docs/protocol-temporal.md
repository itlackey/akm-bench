# Temporal Protocol

This document describes the current temporal benchmark protocol implemented by
`bun run src/cli.ts evolve`.

The protocol is longitudinal: it records feedback on a train slice, evolves the
stash, then re-evaluates the eval slice in pre, post, and synthetic conditions.

## What This Protocol Measures

The temporal protocol measures whether lessons derived from the train slice help
on the eval slice after they are accepted into the stash.

The headline comparisons are:

- `post` vs `pre`: improvement after evolution
- `post` vs `synthetic`: whether the evolved stash beats the self-notes baseline

## Inputs

Install dependencies once:

```sh
bun install
```

Provide an opencode config through the same discovery paths used by the legacy
CLI.

Use one domain that already has both `train` and `eval` tasks.

Checked-in examples from `README.md` and `docs/reference-workflow.md`:

```sh
bun run src/cli.ts evolve --tasks drillbit --seeds 5 --results-dir ./results/reference
```

```sh
bun run src/cli.ts evolve --tasks inkwell --seeds 5 --results-dir ./results/reference
```

Optional threshold overrides:

```sh
bun run src/cli.ts evolve --tasks drillbit --seeds 5 --negative-threshold-count 2 --negative-threshold-ratio 0.5 --results-dir ./results/reference
```

The clearest checked-in train/eval pairs are:

- `drillbit/backup-policy-train` and `drillbit/backup-policy`
- `drillbit/scale-replicas-train` and `drillbit/scale-replicas`
- `inkwell/add-healthcheck-train` and `inkwell/add-healthcheck`
- `inkwell/new-service-train` and `inkwell/new-service`

## Phase Structure

### Phase 1: Signal Accumulation

The runner filters the selected domain to `train` tasks and runs the `akm` arm
only.

For each non-`harness_error` run with a `goldRef`, it dispatches one of:

- `akm feedback <gold_ref> --positive`
- `akm feedback <gold_ref> --negative`

The signal is derived from outcome:

- `pass` -> positive
- `fail` or `budget_exceeded` -> negative

### Phase 2: Evolve

The runner aggregates Phase 1 feedback by asset ref. A ref is selected for
evolution when either condition is true:

- `negative >= absoluteCount`
- `negative / (positive + negative) > ratio`

Default threshold:

- `absoluteCount = 2`
- `ratio = 0.5`

For each selected ref, the runner calls:

- `akm distill <ref>`
- `akm reflect <ref>`

When eval gold refs exist, the runner also passes the train/eval leakage guard
to distill:

- CLI flag: `--exclude-feedback-from <csv>`
- env fallback: `AKM_DISTILL_EXCLUDE_FEEDBACK_FROM=<csv>`

Then, for each proposal returned by `akm proposal list --json`, it calls:

- `akm proposal show <id> --json`
- `akm proposal accept <id>` when lint passes
- `akm proposal reject <id> --reason ...` when lint fails

Finally it rebuilds the index with:

- `akm index`

### Phase 3: Re-evaluate

The runner filters the same domain to `eval` tasks and performs three utility-
style runs:

- `arms.pre`: original pre-evolution stash snapshot
- `arms.post`: evolved stash after accepted proposals
- `arms.synthetic`: no stash, synthetic scratchpad prompt

All three Phase 3 arms are emitted as embedded utility-style envelopes.

## Stash And Isolation Behavior

When stash materialization is enabled, the runner creates isolated temporary
copies per fixture:

- one evolve stash that receives feedback and accepted proposals
- one pre stash snapshot that remains unchanged

The operator's real `AKM_STASH_DIR` is not used by the evolve runner.

## Standard Outputs

Every successful evolve run produces:

- JSON on `stdout`
- a markdown summary on `stderr`, unless `--json` is passed
- a persisted JSON artifact under `results/` or `--results-dir`

Artifact naming is:

```text
bench-report-evolve-<branch>-<commit>-<timestamp>-<model>.json
```

The top-level JSON contract is `schemaVersion: 1` and `track: "evolve"`.

Top-level blocks include:

- `proposals`
- `lessons`
- `longitudinal`
- `arms.pre`
- `arms.post`
- `arms.synthetic`
- `perAsset` from the post arm
- `failure_modes` from the post arm
- optional `searchBridge` from the post arm
- optional `feedback_integrity`
- `warnings[]`

## How To Interpret The Results

`longitudinal` is the primary interpretation block.

- `improvement_slope = post_pass_rate - pre_pass_rate`
- `over_synthetic_lift = post_pass_rate - synthetic_pass_rate`
- `interpretation = "improvement_detected"` only when
  `improvement_slope > significance_threshold`
- `degradation_count` counts eval tasks where `post` fell below `pre` by more
  than one seed's worth of pass rate

Practical reading:

- positive `improvement_slope`: the evolved stash outperformed the pre snapshot
- positive `over_synthetic_lift`: the evolved stash beat the self-notes baseline
- non-zero `degradation_count`: some eval tasks regressed after evolution

Proposal and lesson blocks answer different questions:

- `proposals`: how many proposals were created, lint-clean, and accepted
- `lessons`: reuse and negative-transfer metrics for accepted lesson proposals

`feedback_integrity.aggregate.feedback_agreement` measures whether the Phase 1
feedback polarity matched the underlying run outcomes. The report adds a warning
when that agreement falls below `0.8`.

## Current Implementation Notes

- The current `evolve` CLI requires `--tasks <domain>` and filters the full
  corpus by domain name.
- The help text advertises `--parallel`, but the current `runEvolveCli` path
  does not forward the parsed parallel value into `runEvolve`.
- `--opencode-config` is resolved at CLI startup and forwarded into
  `runEvolve` for provider/model execution.
- The `pre`, `post`, and `synthetic` Phase 3 runs are all emitted as AKM-arm
  utility reports; the distinction is the stash condition, not a different
  top-level utility track.
