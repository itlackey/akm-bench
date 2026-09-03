---
description: Northwind Terraform backend and lockfile initialisation standards
---
# Terraform standards

Backend configuration is never inline. Each environment has a partial backend
config committed under `backend/`, and `init` selects one:

```sh
terraform init -backend-config=backend/prod.hcl -lockfile=readonly
```

`-lockfile=readonly` is mandatory in every environment. Without it a plain
`init` silently rewrites `.terraform.lock.hcl` with whatever provider versions
resolve that day, which is how the 2026-04 provider drift incident happened.
