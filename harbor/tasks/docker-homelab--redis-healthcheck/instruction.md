Your working directory is `/app`. It contains a `docker-compose.yml` file
with a single `redis` service.

Edit `docker-compose.yml` to add a healthcheck to the `redis` service. The
healthcheck must use the `redis-cli` tool to verify the service is
responsive.

When you are done, the `redis` service definition in `docker-compose.yml`
must include a `healthcheck` that invokes `redis-cli`.
