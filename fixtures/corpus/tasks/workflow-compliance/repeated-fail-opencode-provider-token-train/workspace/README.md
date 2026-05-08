# Task: configure opencode for anthropic provider

Update `opencode.json` to satisfy these constraints:

- set `model` to `anthropic/claude-opus-4-7`,
- ensure a `provider` object exists,
- under `provider.anthropic`, add an `env` object,
- map `ANTHROPIC_API_KEY` to `${ANTHROPIC_API_KEY}`.

Keep existing unrelated keys unchanged. Do not run opencode.
