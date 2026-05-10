# Task: set shredder as default and disable openai provider

Important context:

- Follow `AGENTS.md` workflow requirements before editing.
- This task is intentionally underspecified in the prompt. The exact provider disable form and shredder provider wiring come from AKM opencode guidance.
- If you skip AKM lookup, verifier failures are likely.

Required workflow (for reproducibility):

1. Run `akm search opencode config`.
2. Run `akm show skill:opencode`.
3. Then edit files.

Update `opencode.json` to satisfy these constraints:

- set `model` to the shredder default model required for this disable-provider variant,
- ensure a `provider` object exists,
- set `provider.openai` to the provider-disable value expected by opencode config,
- under `provider.shredder.options`, keep local provider wiring and set `apiKey` to the canonical env-ref form used by this repo's shredder config.

Also add a brief prep note in `prep-note.txt` with this exact line:

- `prep: disable openai provider train`

Then add two provenance lines in `prep-note.txt`:

- `akm-search-query: opencode config`
- `akm-show-ref: skill:opencode`

Keep existing unrelated keys unchanged. Do not run opencode.
