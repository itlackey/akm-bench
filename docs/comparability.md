# Comparability rules

**This repo produces Tier-B numbers. They are never publishable beside a
third-party benchmark result.**

The project's goal is to publish akm metrics that stand next to other tools'
published numbers (mem0, Zep, a bare long-context baseline). That comparison
can only come from a third-party benchmark run through its own official
evaluator — which is [`akm-eval`](https://github.com/itlackey/akm-eval)'s job,
under the rules in its `docs/comparability.md`.

What this repo runs is a corpus **we wrote**. A favourable result here is
partly a statement about our own task authorship, so it cannot support a claim
about akm versus a competitor, however carefully it is measured.

## The rule

**B1. Never place a number from this repo in a table, chart, or summary
alongside a third-party benchmark number.** Not with a footnote, not in an
adjacent column. A reader who sees "LongMemEval 0.880" and "akm-bench +0.202"
in one table will read the second as validating the first, and it does not.

**B2. Say what a figure is, every time it appears.** "First-party corpus A/B,
28-task train slice" — not "akm improves agent performance by 20%". The
sentence must survive being quoted alone.

**B3. Comparisons here are longitudinal only** — this corpus against itself,
across akm versions. That is a real and useful claim ("did akm get better at
our tasks"), and it is the only one this repo can make.

**B4. One variable per round.** Same rule as akm-eval's A5, same reason. When
akm-cli, the plugin, and a runtime all move together, no delta attributes to
any of them; the report says so instead of implying attribution.

**B5. Arms differ only in the treatment.** Same model on both arms, same
budgets, same permissions. `bin/ab-run` enforces the model; the runbook's
asymmetry list covers what it cannot.

**B6. A task only measures akm if the control fails it.** See below — this is
currently the largest source of misleading figures in the repo.

**B7. Report what looks bad**, with the same prominence as what looks good.

## B6 in detail: the calibration gate

`knowledge/benchmark-design-knowledge-gap-principle` (in the akm stash) states
the rule this corpus was built to satisfy: an eval task measures an external
skill only when the information needed to succeed is **not** recoverable from
the model's pretraining, verified by a no-skill control that **fails on every
seed**.

The 2026-09-03 round measured how well the current corpus satisfies it:

| grouping | control | akm | delta | engagement |
| --- | --- | --- | --- | --- |
| fictional (`drillbit`, `inkwell`) | 0.000 | 0.889 | +0.889 | 89% |
| real-world (everything else) | 0.848 | 0.864 | +0.015 | 5% |

By the gate, **22 of 28 train-slice tasks are not measuring akm** — the
control already passes them (az-cli, opencode and reference all score 1.000).
Their contribution to any aggregate is noise around zero, and they drag the
aggregate delta toward zero in proportion to how many of them there are.

Two consequences that shape how results here must be read and reported:

- **The aggregate delta is a function of corpus composition.** Change the
  ratio of gap-bearing to non-gap tasks and the headline number moves without
  akm changing at all. Never report the aggregate without the
  engagement-conditioned split beside it (the standard report renders both).
- **"Engagement rate" is not a behavioural metric on this corpus.** It has
  tracked the fraction of tasks with a genuine knowledge gap: 18 of 84
  treatment trials are gap-bearing (21.4%), and measured engagement across
  three rounds was 25.0%, 21.4%, 22.6%. Treating it as a plugin-tuning target
  is measuring the corpus and calling it the model.

### Changing the corpus without invalidating history

B6 argues for corpus change; B3 depends on the corpus holding still. Both
hold if changes are **versioned rather than edited**:

- Never silently retire, reword, or re-verify a task in a slice that has
  published results. That breaks every prior comparison, invisibly.
- Introduce changes as a **new numbered slice** (`v2`), leave the old slice
  runnable, and run both across one transition round so the two are tied
  together by a measured overlap.
- Record, per slice, the no-skill control pass rate per task. A task whose
  control passes is disclosed as non-discriminating rather than quietly
  dropped — that disclosure is itself a finding, and hiding it is the failure
  mode this document exists to prevent.
