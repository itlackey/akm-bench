# Lesson Lifecycle

This document describes the lesson lifecycle that the current `evolve`
implementation supports today.

The sequence is:

`feedback -> distill -> reflect -> proposal acceptance -> lesson reuse`

That is slightly narrower than the broader AKM story. This repo does not manage
an abstract proposal review process beyond what the current runner actually
does: inspect proposals, accept lint-clean ones, reject lint-failing ones, then
re-index and measure reuse.

## 1. Feedback

During `evolve`, Phase 1 runs the domain's `train` slice under the `akm` arm.

For each non-`harness_error` run:

- if the run outcome is `pass`, the runner dispatches
  `akm feedback <gold_ref> --positive`
- otherwise, the runner dispatches
  `akm feedback <gold_ref> --negative`

The runner records each dispatch attempt in `feedbackLog` with:

- `taskId`
- `seed`
- `goldRef`
- `signal`
- `ok`

This log is later used to compute `feedback_integrity` and to attribute lesson
source failures.

## 2. Distill and Reflect

After Phase 1, the runner aggregates feedback by `goldRef`.

An asset is sent to the evolution step when either of these conditions is met:

- negative feedback count is at least `absoluteCount`
- negative feedback ratio is greater than `ratio`

The defaults are:

- `absoluteCount = 2`
- `ratio = 0.5`

For each selected ref, the runner executes:

```sh
akm distill <ref>
akm reflect <ref>
```

If the eval slice contains gold refs, the runner also passes them to distill via
`--exclude-feedback-from` and matching environment variables so distillation
does not ingest eval-slice feedback.

Important current behavior:

- `distill` is the only step that receives the eval-feedback exclusion list
- `reflect` is still run, but does not take that flag
- failures in either command produce warnings and do not abort the entire run

## 3. Proposal Acceptance

After `distill` and `reflect`, the runner walks the proposal queue in the
evolved stash:

1. `akm proposal list --json`
2. `akm proposal show <id> --json`
3. if `lint_pass` is true: `akm proposal accept <id>`
4. otherwise: `akm proposal reject <id> --reason "lint failed: ..."`

This is the current acceptance policy implemented by the repo:

- lint-clean proposals are accepted automatically
- lint-failing proposals are rejected automatically

There is no additional human review stage in `akm-bench` itself.

Each proposal becomes a `proposalLog` row with:

- `proposalId`
- `assetRef`
- `kind`
- `lintPass`
- `decision`
- optional `rejectReason`

The report's `proposals` block summarizes those rows with total proposal count,
acceptance rate, lint pass rate, and per-asset counts.

## 4. Re-index

Once proposals have been accepted or rejected, the runner executes:

```sh
akm index
```

This makes accepted lessons visible to the subsequent eval rerun.

## 5. Lesson Reuse

Phase 3 re-runs the eval slice in three conditions:

- `arms.pre`: original fixture stash, before Phase 2 mutations
- `arms.post`: evolved stash, after accepted proposals and re-indexing
- `arms.synthetic`: no stash, scratchpad-only prompt

Lesson reuse is measured from the `post` arm.

For lesson-kind proposals, the current report computes:

- `lessons_created_count`
- `lessons_accepted_count`
- `lesson_reuse_rate`
- `lesson_reuse_success_rate`
- `lesson_negative_transfer_count`
- one `lessons[]` row per lesson-kind proposal

Per-lesson rows currently expose:

- `ref`
- `source_failures`
- `lint_pass`
- `accepted`
- `first_reused_on`
- `reuse_count`
- `reuse_pass_rate`
- `negative_transfer_count`
- `leakage_risk`

## What "source_failures" Means Today

`source_failures` is derived from Phase 1 negative feedback events whose
`goldRef` matches the lesson ref.

This means the current implementation supports:

- which train-slice task ids produced negative feedback for that ref
- whether a lesson generated from that ref was later accepted
- whether that lesson ref was loaded during `post` runs

It does not currently expose transcript-level provenance beyond that task-level
join.

## What "proposal acceptance" Means Today

In this repo, proposal acceptance means only this:

- the runner observed a proposal via `proposal list`
- `proposal show --json` indicated lint passed
- `proposal accept` exited successfully

Accepted proposals are then eligible to appear in the re-indexed stash and to be
loaded during `arms.post` runs.

## Supported Boundaries

These points are intentionally limited to what the current codebase supports:

- accepted lessons are measured through `assetsLoaded` in `post` runs
- feedback quality is measured separately through `feedback_integrity`
- lesson leakage risk currently defaults to low unless lesson body and verifier
  source text are supplied to the metrics function
- the evolve report embeds utility-style reports for `pre`, `post`, and
  `synthetic`; it does not replace them with a separate lesson-only schema

## Minimal Mental Model

If you are reading an evolve artifact, the current lesson lifecycle is:

1. A train-slice run passes or fails.
2. The runner records positive or negative feedback on the task's `gold_ref`.
3. Refs with enough negative signal go through `distill` and `reflect`.
4. Lint-clean proposals are accepted.
5. The stash is re-indexed.
6. The eval slice is rerun.
7. The report tells you whether accepted lesson refs were reused and whether
   they correlated with improvement or negative transfer.
