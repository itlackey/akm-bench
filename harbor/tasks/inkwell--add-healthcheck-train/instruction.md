Your working directory is `/app`. It contains `service.yaml`, an existing
inkwell service definition.

Edit `service.yaml` to add a healthcheck to the service. The healthcheck
must specify:

- path: `/readyz`
- interval: 15 seconds
- threshold: 2 consecutive checks

Save the result back to `service.yaml`.
