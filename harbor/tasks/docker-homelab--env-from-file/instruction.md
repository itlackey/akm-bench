Your working directory is `/app`. It contains a `docker-compose.yml` file
with a single `app` service, and an `app.env` file with environment variable
definitions.

Edit `docker-compose.yml` so the `app` service loads its environment
variables from the existing `app.env` file.

When you are done, the `app` service definition in `docker-compose.yml` must
reference `app.env` as a source of environment variables.
