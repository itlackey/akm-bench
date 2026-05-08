# Task: set anthropic as default and disable openai provider

Update `opencode.json` to satisfy these constraints:

- set `model` to `anthropic/claude-3-5-sonnet`,
- ensure a `provider` object exists,
- set `provider.openai` to `false`,
- under `provider.anthropic.env`, map `ANTHROPIC_API_KEY` to `${ANTHROPIC_API_KEY}`.

Keep existing unrelated keys unchanged. Do not run opencode.
