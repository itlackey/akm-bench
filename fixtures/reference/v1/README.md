## Reference Suite v1

This directory defines the versioned `akm-bench` reference suite for v1.

v1 is a curated 10-task suite selected from the existing deterministic corpus in
`fixtures/corpus/tasks/`. The suite is referenced by task ID from run configs in
`config/`; tasks are not duplicated into this tree.

### Canonical task set

| Task ID | Domain | Category | Verifier |
| --- | --- | --- | --- |
| `az-cli/create-resource-group` | `az-cli` | Azure CLI command generation | `script` |
| `az-cli/keyvault-secret-set` | `az-cli` | Azure CLI command generation | `script` |
| `docker-homelab/env-from-file` | `docker-homelab` | Docker Compose config editing | `pytest` |
| `docker-homelab/named-volume` | `docker-homelab` | Docker Compose config editing | `pytest` |
| `drillbit/backup-policy` | `drillbit` | Drillbit operational command generation | `script` |
| `drillbit/canary-enable` | `drillbit` | Drillbit operational command generation | `script` |
| `inkwell/add-healthcheck` | `inkwell` | Inkwell service config editing | `pytest` |
| `inkwell/configure-scaling` | `inkwell` | Inkwell service config editing | `pytest` |
| `opencode/select-correct-skill` | `opencode` | OpenCode agent instruction editing | `pytest` |
| `opencode/tool-allowlist` | `opencode` | OpenCode config editing | `script` |

This selection spans five domains and two deterministic verifier types.

### Canonical run settings

- Default config: `config/reference-suite-v1.json`
- Tasks: the 10 task IDs listed above
- Arms: `akm`
- Seeds: `5`
- Budget tokens: `25000`
- Budget wall time: `360000`

### Immutability policy

- `v1` is frozen once published.
- The canonical membership and task ordering for `v1` must not change.
- Existing corpus tasks referenced by `v1` should not be edited in ways that
  change evaluator behavior or success criteria.
- If a task must change semantically, publish a new reference-suite version
  instead of updating `v1`.
- Non-semantic fixes outside this suite's behavior, such as documentation-only
  clarifications, are acceptable.
