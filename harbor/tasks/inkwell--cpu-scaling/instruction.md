Your working directory is `/app`. It contains `service.yaml`, an existing
inkwell service definition.

Edit `service.yaml` to configure CPU-based autoscaling on the service:

- `min: 1`
- `max: 8`
- `metric: cpu`
- `target: 65`

Save the result back to `service.yaml`.
