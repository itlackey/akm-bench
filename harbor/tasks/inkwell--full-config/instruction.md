Your working directory is `/app`. It contains `service.yaml`, an existing
inkwell service definition.

Edit `service.yaml` to add scaling, a healthcheck, and rate limits to the
service:

- `scaling.min: 2`
- `scaling.max: 10`
- `scaling.metric: rps`
- `scaling.target: 150`
- `healthcheck.path: /health`
- `healthcheck.interval: 15`
- `healthcheck.threshold: 3`
- `limits.rps: 200`
- `limits.burst: 400`

Save the result back to `service.yaml`.
