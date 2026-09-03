# Task class: local convention over public default

**Status: 8 tasks authored, awaiting calibration (LC6).**

They are in the `akm-tasks-local-convention-v1` registry slice and are
deliberately NOT in `akm-tasks-train-v2`: the admission checklist below
requires LC6 — every task `discriminating` at k≥3 on a real run — and that run
has not happened. Run it with `bin/ab-run local-convention`, then
`bin/akm-bench-calibrate`.

What has been verified without a model, by
`harbor/tests/test_local_convention_tasks.py`:

| check | how |
| --- | --- |
| LC2 | the confident public default is stored per task in `solution/public-default.txt` and asserted to FAIL its verifier |
| LC4 | every `convention_tokens` value appears in the stash and in no agent-visible file |
| LC5 | gold passes; near-misses, undocumented extra flags, and empty input are rejected |

What **cannot** be checked without a model is LC2's premise — whether the model
actually produces the public default. A task it happens to answer correctly
from pretraining is guessable and must be re-authored, and only the calibration
run can tell you which.

This class exists to fill a hole the 2026-09-03 calibration measurement made
visible. It is the only task shape in which akm engagement is both *low* and
*costly*, and therefore the only one where the plugin's trigger wording could
possibly matter.

## Why the corpus needs it

The v1 train slice contains exactly two shapes, and both are degenerate for
the question "will the agent consult akm when it should?"

| shape | example | control | engagement | what it tests |
| --- | --- | --- | --- | --- |
| **fictional tool** | `drillbit`, `inkwell` | 0.000 | 89% | can the agent use akm when it obviously must |
| **real tool, public answer** | `az-cli`, `docker-homelab`, `opencode` | 0.848 | 5% | nothing about akm — the agent already knows |

Neither is a test of judgement. In the first the model *knows it is ignorant*:
`drillbit` is not a word, there is nowhere else to look, so consulting akm is
forced rather than chosen. In the second the model is right not to look, and
declining to is correct behaviour that costs nothing.

The measurement that follows from this is the one to keep in mind while
authoring: **engagement rate has tracked the fraction of the corpus that is
fictional** (18 of 84 treatment trials, 21.4%; measured engagement across three
rounds 25.0%, 21.4%, 22.6%). Adding more fictional tasks would raise
"engagement" without telling anyone anything new.

The missing shape is the one that actually happens in production:

> A **real** tool the model knows well, where the **local** answer differs from
> the public default — and nothing in the prompt signals that.

The model produces a confident, publicly-correct answer. It is wrong here. It
does not know it needs to look, so whether it looks is a genuine choice, and a
wrong choice has a real cost. That is the case worth measuring.

## Design requirements

A task in this class MUST satisfy all of the following. These are the
knowledge-gap principle's requirements
(`knowledge/benchmark-design-knowledge-gap-principle` in the akm stash),
specialised for the real-tool case.

**LC1. The tool is real and well-known.** `az`, `docker compose`, `kubectl`,
`git`. Not a fictional CLI — the entire point is that the model has a strong
prior and no reason to doubt it. If a reader cannot say "I know what that
command looks like", the task is a fictional-tool task wearing a real name.

**LC2. A publicly-correct answer exists and is wrong here.** The task must be
answerable — plausibly, confidently, in one shot — from pretraining alone, and
that answer must fail the verifier. If the model cannot produce a confident
wrong answer, the task is not testing the thing this class exists to test.

**LC3. The prompt does not hint that a local convention exists.** No "check our
standards", no "per the team's policy", no "look it up first". Those turn a
judgement test into an instruction-following test, which the corpus already
covers. The prompt reads exactly as the naive version of the request would.

**LC4. The local convention lives ONLY in the stash**, as a value no amount of
reasoning recovers: a specific tag key, a required flag, a naming scheme, a
mandated subscription or registry. It must not be derivable from the workspace,
the file tree, or the task description.

**LC5. The verifier asserts the stash-only token by exact match.** Not a fuzzy
match, not "contains `az`". The verifier passes only on the local form and
explicitly rejects the public default — mirroring
`harbor/tasks/drillbit--backup-policy/tests/verify.sh`, which accepts only the
documented command form and rejects invented flags, renamed flags and extra
flags.

**LC6. The task passes the calibration gate on real data.** Control fails every
attempt: `bin/akm-bench-calibrate <jobs-dir> --corpus harbor/tasks`. The
seed-tolerance rule is strict — one passing control seed makes the task
guessable and disqualifies it. Run at k≥3 before admitting the task to a slice.

**LC7. It is re-checked when the model changes.** LC2 depends on a property of
the model, not of the task. A convention that is obscure today can enter a
training corpus tomorrow, and a model upgrade can quietly turn a
knowledge-gap task into a non-discriminating one. Re-run the gate on every
model or major akm change; this is the one class whose calibration can rot
without anyone editing it.

## What this class is NOT

- **Not a trick question.** The local convention must be a plausible
  organisational policy, not an arbitrary string. A task that is merely weird
  measures the model's tolerance for weirdness.
- **Not a fictional tool with a real name.** If the invented convention is so
  alien that the tool is unrecognisable, LC1 has failed.
- **Not an instruction-following test.** LC3 exists to keep this distinct from
  the `workflow-compliance` family, which already measures whether an agent
  follows a stated process.

## Worked example

**Now authored** as `harbor/tasks/az-cli--storage-account-naming/`, in the
`akm-tasks-local-convention-v1` candidate slice — not `train-v2`, which LC6
gates. The stash asset below shipped as
`harbor/stashes/northwind-platform/knowledge/azure-resource-standards.md`.

The public default: `az storage account create` with any globally-unique name.
Every model knows this cold — and `az-cli--storage-account-create` currently
scores **1.000 on the control**, so we have direct evidence that the naive form
is already known. The local convention is a mandated naming scheme and a
required cost-centre tag, which exist only in the stash.

### The stash asset (the sole source of truth)

`harbor/stashes/az-cli/knowledge/storage-naming-policy.md`:

```markdown
---
description: Mandatory naming and tagging policy for Azure storage accounts
---
# Storage account naming policy

Every storage account MUST be created with:

- a name of the form `st<team><purpose><NN>` — lowercase, no separators,
  where `<NN>` is a two-digit sequence number. Example: `stpayrollarchive01`.
- the tag `cost-center=CC-4417`, which Finance reconciles monthly. An account
  without it is deleted by the nightly sweep.
- `--min-tls-version TLS1_2`, which is not the CLI default.
```

`CC-4417` and the `st<team><purpose><NN>` form are the stash-only tokens. Neither
is recoverable by reasoning — that is what makes the task discriminating.

### The instruction (no hint — LC3)

```markdown
Your working directory is `/app`.

Append to `commands.txt` the `az` command that creates a storage account for
the payroll team's archive, in resource group `rg-payroll`, location
`eastus`, with standard locally-redundant storage. Do not execute the
command — only write it.
```

A model answering from pretraining writes something like
`az storage account create --name payrollarchive --resource-group rg-payroll
--location eastus --sku Standard_LRS`. Confident, publicly correct, and wrong
on three counts here.

### The verifier (LC5)

Reuse the `drillbit--backup-policy` verifier template — it already implements
exact-form matching with flag-order tolerance. For this task:

```bash
WORDS=(az storage account create)
POSITIONAL=()
declare -A FLAGS=(
  [--name]=stpayrollarchive01
  [--resource-group]=rg-payroll
  [--location]=eastus
  [--sku]=Standard_LRS
  [--tags]=cost-center=CC-4417
  [--min-tls-version]=TLS1_2
)
# The public-default answer must be REJECTED, not merely unmatched: a name
# that does not follow the policy is the specific failure this task exists to
# catch, so name it explicitly rather than relying on the exact-match to
# happen to exclude it.
FORBIDDEN=(
  '--name[[:space:]]+(payrollarchive|payroll-archive|archivepayroll)'
)
```

The exact-match template already rejects a missing `--tags`, a missing
`--min-tls-version`, and any undocumented extra flag, so LC5 is satisfied by
construction once `FLAGS` names the stash-only values.

### task.toml metadata

Follows the existing convention (see `harbor/tasks/drillbit--backup-policy`),
with the class marked so it can be filtered and re-checked per LC7:

```toml
[metadata]
domain = "az-cli"
slice = "train-v2"
difficulty = "medium"
stash = "az-cli"
gold_ref = "knowledge/storage-naming-policy"
memory_ability = "local_convention_override"
task_family = "az-cli/storage-naming"
akm_keywords = "azure storage account naming policy tag cost center tls"
recheck_on = "model-change"
```

`memory_ability = "local_convention_override"` is a new value. It is what lets
a later run report this class separately, which matters because it is the only
class whose engagement number means anything.

## Admission checklist

Before a task of this class enters a slice:

- [ ] LC1: the tool is real and widely documented.
- [ ] LC2: a confident public answer exists and FAILS the verifier — write it
      out and run it through the verifier by hand.
- [ ] LC3: the prompt contains no hint that a local convention exists.
- [ ] LC4: the convention appears ONLY in the stash — grep the task directory,
      the workspace and the instruction for the token.
- [ ] LC5: the verifier asserts the stash-only token by exact match and names
      the public default in `FORBIDDEN`.
- [ ] LC6: `bin/akm-bench-calibrate` reports `discriminating` at k≥3.
- [ ] LC7: `recheck_on` is set, and the gate is re-run on model change.
- [ ] The task is added to a NEW slice, never to one with published results
      (`docs/comparability.md` B3).
