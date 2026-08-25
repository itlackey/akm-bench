Your working directory is `/app`.

Update `config/opencode.json` to satisfy these constraints:

- set `model` to the anthropic default model required for this
  provider-token train variant,
- ensure a `provider` object exists,
- under `provider.anthropic`, add an `options` object,
- set `provider.anthropic.options.apiKey` to the canonical env-ref form
  used by opencode config.

Also add a brief prep note in `prep-note.txt` with this exact line:

- `prep: anthropic provider token train`

Then add two provenance lines in `prep-note.txt`:

- `akm-search-query: opencode config`
- `akm-show-ref: skill:opencode`

Keep existing unrelated keys unchanged. Do not run opencode.
