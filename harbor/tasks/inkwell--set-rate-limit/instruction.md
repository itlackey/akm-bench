Your working directory is `/app`. It contains `service.yaml`, an existing
inkwell service definition.

Edit `service.yaml` to add a `limits` block to the service:

- `rps: 500`
- `burst: 1000`

Save the result back to `service.yaml`.
