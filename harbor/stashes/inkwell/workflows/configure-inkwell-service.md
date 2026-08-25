---
type: workflow
description: Step-by-step workflow for configuring inkwell service YAML — advance one step at a time and look up the inkwell/v2 schema before editing any YAML, never edit the file from memory
updated: 2026-08-23
tags:
  - inkwell
  - configuration
  - workflow
params:
  service_name: { type: string, description: The name of the service being configured }
steps:
  - id: lookup-schema
  - id: apply-config
    inputs: [steps.lookup-schema.output]
  - id: verify
    inputs: [steps.apply-config.output]
---

# Workflow: Configure Inkwell Service

Configure the inkwell service named by the `service_name` run parameter by
first retrieving the authoritative inkwell/v2 schema, then editing the
service YAML to match it exactly, then re-reading the result.

## lookup-schema

Run `akm show skills/inkwell` to retrieve the inkwell/v2 YAML schema. Read the
output carefully — pay attention to the exact field names and value types
(especially integer vs string, and exact metric names like `rps` not
`requests_per_second`).

### gate

- `akm show skills/inkwell` has been run and the output reviewed.
- Exact field names for the required configuration block are known.

## apply-config

Edit `service.yaml` in the workspace to add the required configuration block.
Use only the exact field names and value types shown in the schema attached to
this unit as input — no approximations.

### gate

- `service.yaml` has been edited with the correct block.
- Field names match the schema exactly.
- All values are the correct type (integers are integers, not strings).

## verify

Re-read `service.yaml` to confirm the configuration block is correct and
complete before finishing.

### gate

- The configuration block matches the task requirements exactly.
- No extra or missing fields.
