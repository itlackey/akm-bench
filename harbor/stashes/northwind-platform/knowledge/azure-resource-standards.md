---
description: Mandatory Azure naming, tagging and TLS standards for Northwind Platform Engineering
---
# Azure resource standards

These are enforced by the nightly compliance sweep. A resource that does not
match is deleted without notice, so the standard form is the only correct form.

## Storage accounts

Name: `st<team><purpose><NN>` — lowercase, no separators, `<NN>` a two-digit
sequence number. The payroll team's archive account is `stpayrollarchive01`.

Every storage account is created with all of:

```sh
az storage account create --name stpayrollarchive01 --resource-group rg-payroll \
  --location eastus --sku Standard_LRS --tags cost-center=CC-4417 \
  --min-tls-version TLS1_2
```

- `cost-center=CC-4417` is the Platform Engineering cost centre. Finance
  reconciles against it monthly.
- `--min-tls-version TLS1_2` is **not** the CLI default and must be passed
  explicitly.

## Key Vault

Vault name: `kv-<team>-<env>-01`. The payroll production vault is
`kv-payroll-prod-01`.

Secrets are written from a file, never `--value` on the command line (the
shell history is captured by the audit agent), and always carry the platform
content type:

```sh
az keyvault secret set --vault-name kv-payroll-prod-01 --name db-connection \
  --file /run/secrets/db.txt --content-type application/x-northwind-secret
```

## AKS

Cluster name: `aks-nw-<env>-01`, always in resource group `rg-platform`.
Credentials are fetched with an explicit `--context nw-<env>` so every
engineer's kubeconfig uses the same context names:

```sh
az aks get-credentials --name aks-nw-prod-01 --resource-group rg-platform \
  --context nw-prod
```

Never pass `--admin`. Admin credentials bypass the RBAC audit trail and their
use is a reportable incident.
