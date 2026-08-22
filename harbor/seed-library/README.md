# `harbor/seed-library` — P0 smoke fixture

**This is a SMOKE fixture, not the benchmark library.**

## What it is

A minimal, pre-seeded akm bundle in the akm **0.9 directory layout**. `AkmOpenCode.install()`
uploads this tree into the task container, merges it over a freshly scaffolded bundle
(`akm bundle create --dir /opt/akm/bundle --set-default`), and then runs `akm index --full`.

Its only job is to make the P0 A/B run *observable*: the treatment arm needs a non-empty,
deterministic library so that `akm_search` / `akm_show` / `akm_curate` return something and
so the install-time self-check can assert on exact entry counts. Nothing here is tuned to
make the model succeed at any particular benchmark task.

## Provenance

Copied verbatim (content and frontmatter unchanged) from the akm-plugins eval fixtures:

    /home/user/itlackey/akm-plugins/evals/fixtures/stash/

15 of the 20 fixture assets were taken. Deliberately **excluded**:

| Excluded | Why |
|---|---|
| `workflows/release.md` | Fails akm 0.9.1 workflow-schema validation (`name`/`keywords` are not allowed frontmatter keys; `steps` is required). It is skipped with a warning and indexes to 0 entries. Carrying it would train readers to ignore warnings. |
| `secrets/staging` | Contains a placeholder credential string. A benchmark fixture in a shared repo should carry no credential-shaped material at all, real or fake. |
| `env/staging.env` | Pairs with `secrets/`; without it the bundle needs no `chmod 700` dance after seeding. |
| `memories/session-x.md` | `akm_remember` and auto-feedback **write** into `memories/` during a trial. Starting empty makes "did the agent write a memory?" a clean signal instead of a diff against a seeded file. |

## Contents (15 assets)

| Type dir | Count | Assets |
|---|---|---|
| `knowledge/` | 4 | api-error-codes, deployment-runbook, onboarding, repo-conventions |
| `skills/` | 3 | code-review, debug-runtime, refactor-py (each a `SKILL.md`) |
| `commands/` | 3 | bump-version, scaffold-test, summarize-diff |
| `agents/` | 2 | planner, reviewer |
| `scripts/` | 2 | lint.sh, smoke.sh |
| `lessons/` | 1 | postmortem-cache-stampede |

These per-type counts are asserted at install time — they are mirrored in
`SEED_EXPECTED_BY_TYPE` in `harbor/akm_opencode.py`. **If you add or remove an asset here,
update that constant** or the install-time self-check will fail the trial.

After seeding, `akm index --full` reports roughly **27** entries: these 15 assets plus the
~12 `facts/conventions/*` templates that `akm bundle create` scaffolds on its own. A
scaffold-only bundle indexes to ~12, which is why "entry count > 0" proves nothing and the
self-check uses a floor of 15 plus the per-type table above.

## Open decision (not resolved by P0)

What the *real* benchmark library should be is still open. Candidates: a library derived from
the benchmark repo under test, a hand-authored library targeting the task distribution, or a
library harvested from prior agent runs. P0 only establishes that a seeded library reaches the
container and that the model can call `akm_*` against it.

## Gotchas

- `README.md` lives at the seed root, **not** inside a type directory, so `akm index` ignores
  it. `install()` copies only the type subdirectories (`for d in seed/*/`), so this file never
  reaches the bundle.
- akm's FTS **does not stem**. `akm search "deploy"` returns zero hits against
  `deployment-runbook`; `"deployment"`, `"rollback"`, and `"runbook"` all hit. Use prefix
  enumeration (`akm search "knowledge/"`) or `akm curate` for deterministic assertions.
- The bundle is seeded **per container**. `akm_remember` and auto-feedback mutate it during a
  trial, so a shared read-write volume would let trials contaminate each other.
