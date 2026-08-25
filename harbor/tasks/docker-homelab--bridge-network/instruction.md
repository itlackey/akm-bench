Your working directory is `/app`. It contains a `docker-compose.yml` file
that defines an `api` service and a `worker` service.

Edit `docker-compose.yml` to create a custom bridge network named `internal`
and attach both the `api` and `worker` services to it. Services on the same
network can reach each other by container name.

When you are done, `docker-compose.yml` must declare a network named
`internal`, and both the `api` and `worker` services must be members of it.
