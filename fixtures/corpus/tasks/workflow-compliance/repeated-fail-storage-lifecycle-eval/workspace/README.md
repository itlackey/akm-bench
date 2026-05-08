# Task: set storage account lifecycle policy (eval variant)

Append the exact `az` CLI command (no comments, no shell pipes) to
`commands.txt` that creates a management lifecycle-policy rule on an
existing storage account named `storagelogs` in resource group `ops-rg`.

The rule must:
- delete blobs in the `logs-archive` container after 90 days since modification,
- target the `blockBlob` blob type,
- be named `expire-90d`,
- be installed via the `az storage account management-policy create`
  subcommand with both `--account-name` and `--resource-group` flags.

Do not run the command. Only write what you would run.
