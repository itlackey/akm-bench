---
description: Run coding tasks with the opencode agent CLI
when_to_use: Use when a task requires editing opencode.json model/provider settings, including provider env wiring and disabling providers.
---
# opencode

opencode is a CLI agent harness that drives a model through a tool loop against a workspace. Configure model and provider via `opencode.json`. Use `opencode run` for a single task and `opencode chat` for an interactive session.

## Core config shape

- `model` is a provider-qualified string like `anthropic/claude-3-5-sonnet` or `anthropic/claude-opus-4-7`.
- `provider` is an object keyed by provider name.
- A provider can be disabled by setting it to `false`.
- Provider credentials are wired under `provider.<name>.options.apiKey` using env refs.

## Provider env wiring

When a task asks for anthropic provider configuration, keep the existing unrelated keys and add or update only the required provider block:

```json
{
  "model": "anthropic/claude-3-5-sonnet",
  "provider": {
    "openai": false,
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

If the task asks for `claude-opus-4-7`, use:

```json
{
  "model": "anthropic/claude-opus-4-7",
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

## Task-specific guidance

- Do not remove unrelated top-level keys like `$schema` or `sandbox` unless the task explicitly asks you to.
- If the task says to disable `openai`, set `provider.openai` to `false` exactly.
- If the task says to ensure a provider exists, create the `provider` object if it is missing.
- Keep env var placeholders in the `{env:NAME}` form, not literal secrets.
