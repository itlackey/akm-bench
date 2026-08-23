Your working directory is `/app`.

Append to `commands.txt` the exact `docker compose` command (no comments,
no shell pipes) that renders a merged config from a staged compose setup
with these constraints:

- read environment variables from `envs/stage.env`,
- include both `compose.yaml` and `compose.stage.yaml`,
- enable profile `stage`,
- print only service names,
- disable variable interpolation.

Do not run the command. Only write what you would run.
