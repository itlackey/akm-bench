---
description: opencode.json configuration reference
---
# opencode Config

`opencode.json` declares model, provider, tools, and instructions. `model` is a `"provider/model-id"` string. `tools` enables individual tool plugins. Use `instructions: ["./AGENTS.md"]` to prepend project guidance to every run.

Provider examples:

```json
{
  "model": "anthropic/claude-3-5-sonnet",
  "provider": {
    "anthropic": {
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

To disable a provider, set it to `false`, for example `"openai": false`.
