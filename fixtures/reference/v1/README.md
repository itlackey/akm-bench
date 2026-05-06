## Reference Suite v1

This directory defines the versioned `akm-bench` reference suite for v1.

v1 is a curated 26-task suite selected from the existing deterministic corpus in
`fixtures/corpus/tasks/`. The suite is referenced by task ID from run configs in
`config/`; tasks are not duplicated into this tree.

### Canonical task set

| Task ID | Domain | Category | Verifier |
| --- | --- | --- | --- |
| `az-cli/assign-managed-identity` | `az-cli` | Azure CLI command generation | `script` |
| `az-cli/create-resource-group` | `az-cli` | Azure CLI command generation | `script` |
| `az-cli/keyvault-secret-set` | `az-cli` | Azure CLI command generation | `script` |
| `az-cli/query-by-tag` | `az-cli` | Azure CLI command generation | `script` |
| `az-cli/storage-account-create` | `az-cli` | Azure CLI command generation | `script` |
| `docker-homelab/bridge-network` | `docker-homelab` | Docker Compose config editing | `pytest` |
| `docker-homelab/compose-version-upgrade` | `docker-homelab` | Docker Compose config editing | `pytest` |
| `docker-homelab/env-from-file` | `docker-homelab` | Docker Compose config editing | `pytest` |
| `docker-homelab/named-volume` | `docker-homelab` | Docker Compose config editing | `pytest` |
| `docker-homelab/redis-healthcheck` | `docker-homelab` | Docker Compose config editing | `pytest` |
| `docker-homelab/restart-policy` | `docker-homelab` | Docker Compose config editing | `pytest` |
| `drillbit/backup-policy` | `drillbit` | Drillbit operational command generation | `script` |
| `drillbit/canary-enable` | `drillbit` | Drillbit operational command generation | `script` |
| `drillbit/provision-edge` | `drillbit` | Drillbit operational command generation | `script` |
| `drillbit/rotate-secret` | `drillbit` | Drillbit operational command generation | `script` |
| `drillbit/scale-replicas` | `drillbit` | Drillbit operational command generation | `script` |
| `inkwell/add-healthcheck` | `inkwell` | Inkwell service config editing | `pytest` |
| `inkwell/configure-scaling` | `inkwell` | Inkwell service config editing | `pytest` |
| `inkwell/cpu-scaling` | `inkwell` | Inkwell service config editing | `pytest` |
| `inkwell/full-config` | `inkwell` | Inkwell service config editing | `pytest` |
| `inkwell/new-service` | `inkwell` | Inkwell service config editing | `pytest` |
| `inkwell/set-rate-limit` | `inkwell` | Inkwell service config editing | `pytest` |
| `opencode/agents-md-akm-snippet` | `opencode` | OpenCode agent instruction editing | `script` |
| `opencode/provider-akm-feedback` | `opencode` | OpenCode config editing | `script` |
| `opencode/select-correct-skill` | `opencode` | OpenCode agent instruction editing | `pytest` |
| `opencode/tool-allowlist` | `opencode` | OpenCode config editing | `script` |

This selection spans five domains and uses only deterministic `script` and `pytest` evaluators.

### Selection constraints

- The suite reuses existing corpus task IDs directly; no task fixtures are duplicated under `fixtures/reference/v1/`.
- Only deterministic evaluators are included. Tasks using non-deterministic grading are excluded.
- The set deliberately stays within the current `opencode`-runner v1 scope and does not add second-runner coverage.
- Membership mixes command-generation and file-editing tasks across at least three domains so reference runs are less sensitive to one narrow task family.

### Canonical run settings

- Default config: `config/reference-suite-v1.json`
- Tasks: the 26 task IDs listed above
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
