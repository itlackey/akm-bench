Your working directory is `/app`. It contains a `docker-compose.yml` file
with a single `postgres` service.

Edit `docker-compose.yml` to add persistent storage for the `postgres`
service using a named volume called `pgdata`. The volume must be mounted at
`/var/lib/postgresql/data` inside the container.

When you are done, `docker-compose.yml` must declare a named volume called
`pgdata`, and the `postgres` service must mount it at
`/var/lib/postgresql/data`.
