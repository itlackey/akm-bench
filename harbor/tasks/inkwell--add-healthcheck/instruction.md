Your working directory is `/app`. It contains `service.yaml`, an existing
inkwell service definition.

Edit `service.yaml` to add a healthcheck to the service. The healthcheck
must specify:

- path: `/health`
- interval: `10` (plain integer seconds, no unit suffix)
- threshold: `3` (plain integer, no unit suffix)

Save the result back to `service.yaml`.
