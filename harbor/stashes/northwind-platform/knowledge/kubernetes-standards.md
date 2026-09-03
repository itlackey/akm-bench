---
description: Northwind Kubernetes namespace naming and production scaling floors
---
# Kubernetes standards

## Namespaces

Every namespace is prefixed `nw-` followed by the owning team: the payroll
team's namespace is `nw-payroll`. The prefix is what the cluster's network
policy selectors match on, so an unprefixed namespace gets no egress at all.

## Scaling

Production services never run below **6 replicas**. Six is the floor that
keeps a service available through a single-node drain plus a rolling update on
our three-AZ clusters; below it, a drain can take the service to zero.

Scale with the resource argument last, so the command is copy-pasteable across
namespaces:

```sh
kubectl scale --replicas 6 -n nw-payroll deployment/invoicer
```
