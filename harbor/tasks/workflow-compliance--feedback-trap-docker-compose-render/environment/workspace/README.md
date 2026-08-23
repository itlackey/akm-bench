# Task: render a staged compose config command

Append the exact `docker compose` command (no comments, no shell pipes) to
`commands.txt` that renders services from a staged compose setup with these
constraints:

- read environment variables from `envs/stage.env`,
- include both `compose.yaml` and `compose.stage.yaml`,
- enable profile `stage`,
- print only service names,
- disable variable interpolation.

Do not run the command. Only write what you would run.
