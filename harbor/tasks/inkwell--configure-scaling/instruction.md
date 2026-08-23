Your working directory is `/app`. It contains `service.yaml`, an existing
inkwell service definition.

Edit `service.yaml` to configure autoscaling on the service:

- `min: 2`
- `max: 20`
- `metric: rps`
- `target: 100`

Save the result back to `service.yaml`.
