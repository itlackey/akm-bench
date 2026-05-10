# Task: configure opencode for anthropic sonnet provider

Important context:

- Follow `AGENTS.md` workflow requirements before editing.
- This eval variant is intentionally underspecified in the prompt. The exact anthropic model pin and env-ref token wiring come from AKM opencode guidance.
- If you skip AKM lookup, verifier failures are likely.

Required workflow (for reproducibility):

1. Run `akm search opencode config`.
2. Run `akm show skill:opencode`.
3. Then edit files.

Update `opencode.json` to satisfy these constraints:

- set `model` to the anthropic default model required for this provider-token eval variant,
- ensure a `provider` object exists,
- under `provider.anthropic`, add an `options` object,
- set `provider.anthropic.options.apiKey` to the canonical env-ref form used by opencode config.

Also add a brief prep note in `prep-note.txt` with this exact line:

- `prep: anthropic provider token eval`

Then add two provenance lines in `prep-note.txt`:

- `akm-search-query: opencode config`
- `akm-show-ref: skill:opencode`

Keep existing unrelated keys unchanged. Do not run opencode.
