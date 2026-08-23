> **Why this directory exists:** `harbor/stashes/` is uploaded VERBATIM into
> every treatment-arm container by `AkmOpenCode.install()`. Benchmark
> metadata — this README and `gold-ref-map.json` (which names gold refs and
> the abstention tasks) — must therefore live OUTSIDE that payload, or the
> treatment arm can read the answer key while the baseline arm cannot.
> Keep `harbor/stashes/` containing stash directories only.

# harbor/stashes/

Copies of the 7 legacy fixture stashes from `fixtures/stashes/` (the
`ranking-baseline` fixture is **not** copied here — grep confirms no
`task.yaml` in `fixtures/corpus/tasks/` references it as a `stash:` value).

These are the seed bundles the `AkmOpenCode` Harbor agent (owned by a
concurrent workflow, `harbor/akm_opencode.py`) uploads and materialises into
a trial's akm bundle when `[environment].env.AKM_TASK_STASH` names one of
these directories. Task `environment/` images never install akm or copy
stash content directly — see `docs/corpus-conversion.md` §"Arm neutrality".

## Verified: every stash indexes under akm 0.9.1

Verification method (hermetic, no operator config touched): for each stash,
copy it into a scratch bundle dir, then run

```sh
AKM_FORCE_INIT_TMP_STASH=1 \
AKM_BUNDLE_DIR=<scratch>/bundle \
AKM_CONFIG_DIR=<scratch>/config \
AKM_DATA_DIR=<scratch>/data \
AKM_CACHE_DIR=<scratch>/cache \
AKM_STATE_DIR=<scratch>/state \
bun /home/user/akm/src/cli.ts index --full
```

followed by

```sh
AKM_FORCE_INIT_TMP_STASH=1 AKM_BUNDLE_DIR=... AKM_CONFIG_DIR=... \
AKM_DATA_DIR=... AKM_CACHE_DIR=... AKM_STATE_DIR=... \
bun /home/user/akm/src/cli.ts info
```

to read back `indexStats`. All 7 succeeded (`verification.ok: true`,
`semanticSearchEnabled: false` — FTS-only, deterministic, no embedding
provider required).

| stash | entryCount | byType | notes |
| --- | --- | --- | --- |
| az-cli | 7 | knowledge 4, memory 2, skill 1 | clean |
| docker-homelab | 6 | knowledge 5, skill 1 | clean |
| drillbit | 1 | skill 1 | clean — smallest fixture, single SKILL.md |
| inkwell | 3 | memory 1, skill 1, workflow 1 | workflow migrated to the 0.9.1 schema — see below |
| minimal | 5 | agent 1, command 1, knowledge 1, script 1, skill 1 | clean |
| multi-domain | 30 | command 8, knowledge 16, skill 6 | clean |
| noisy | 42 | agent 1, command 12, knowledge 20, script 2, skill 7 | clean |

### Fixed: `inkwell/workflows/configure-inkwell-service.md` migrated to the 0.9.1 workflow schema

**Before** (first conversion pass): `akm index --full` on the `inkwell` stash
logged

```
[index] zero-row .../bundle/workflows: workflow-noise
1 workflow spec skipped due to validation errors; rerun with --verbose ...
```

The file predated akm 0.9's workflow-asset schema and failed on three counts —
`steps` frontmatter was not a list, the `service_name` param was not a
JSON-Schema object, and the body's `## Step: ...` headings matched no declared
step id. It was present on disk but absent from the index (`entryCount: 2`, not
3), so the legacy `gold_ref: workflow:configure-inkwell-service` had no
resolvable 0.9 spelling and task `inkwell--workflow-configure-scaling` shipped
with no `gold_ref`.

**After** (execution-validation pass): this copy — and only this copy;
`fixtures/stashes/inkwell/` is owned by the legacy driver and is left untouched
— was migrated to the 0.9.1 workflow schema:

- frontmatter gained `type: workflow` and `updated:`;
- `params.service_name` became a JSON-Schema object
  (`{ type: string, description: ... }`);
- `steps:` became a list of `{ id }` entries (`lookup-schema`, `apply-config`,
  `verify`) wired with `inputs: [steps.<prev>.output]`;
- body headings became `## <step-id>` matching those ids, with each step's
  former "### Completion Criteria" bullets moved verbatim under `### gate`
  (the 0.9 rubric heading);
- the body's stale `akm show skill:inkwell` (retired 0.7 `type:name` grammar,
  the only such ref left anywhere under `harbor/stashes/`) became
  `akm show skills/inkwell`.

Step instructions and completion criteria are otherwise preserved. Verified
hermetically against akm 0.9.1: `akm index --full` exits 0 with no warnings,
`akm search "" --shape agent` lists `workflows/configure-inkwell-service`, and
`akm show workflows/configure-inkwell-service` exits 0. Task
`inkwell--workflow-configure-scaling` now carries
`gold_ref = "workflows/configure-inkwell-service"`.

## gold-ref-map.json

Maps every distinct legacy `gold_ref` spelling (`type:name`, pre-0.9 grammar)
found across the 46-task corpus to its 0.9 `[bundle//]conceptId[#fragment]`
spelling, resolved by indexing the task's own `stash:` and reading the
matching entry back from `akm search "" --limit 500 --shape agent` (never
guessed — copied verbatim from the index). See that file for the full
mapping. As of the execution-validation pass every entry resolves — there are
no flagged-unresolvable refs left (`unresolvable: []`).
