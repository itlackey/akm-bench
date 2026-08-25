# Task: set shredder as default and disable openai provider

Update `config/opencode.json` to satisfy these constraints:

- set `model` to the shredder default model required for this
  disable-provider variant,
- ensure a `provider` object exists,
- set `provider.openai` to the provider-disable value expected by opencode
  config,
- under `provider.shredder.options`, keep the existing local provider
  wiring and set `apiKey` to the canonical env-ref form used by this
  repo's shredder config.

Also add a brief prep note in `prep-note.txt` with this exact line:

- `prep: disable openai provider train`

Then add two provenance lines in `prep-note.txt`:

- `akm-search-query: opencode config`
- `akm-show-ref: skill:opencode`

Keep any existing unrelated keys in `config/opencode.json` unchanged. Do
not run opencode.
