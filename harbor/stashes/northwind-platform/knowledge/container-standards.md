---
description: Northwind container runtime and registry standards for docker
---
# Container standards

## Running a service container

Long-running service containers use the platform restart policy and carry the
cost-centre label. The platform log driver is `local`; the json-file default
is not permitted because it is not rotated on our hosts.

```sh
docker run --name nw-invoicer --restart on-failure:5 \
  --label com.northwind.cost-center=CC-4417 --log-driver local \
  registry.northwind.internal/platform/invoicer:2026.09.1
```

`--restart on-failure:5` is deliberate: `unless-stopped` and `always` mask a
crash-looping service from the alerting pipeline, which watches restart exit
counts.

## Registry and tags

All images are pushed to the internal registry under the `platform/` path:

```
registry.northwind.internal/platform/<image>:<CalVer>
```

Tags are CalVer `<YYYY>.<MM>.<patch>` — for example `2026.09.1`. The `latest`
tag is refused by the registry's admission webhook; a push using it fails.

```sh
docker push registry.northwind.internal/platform/invoicer:2026.09.1
```
