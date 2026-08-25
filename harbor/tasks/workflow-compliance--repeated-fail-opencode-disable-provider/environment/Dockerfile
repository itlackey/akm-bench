FROM ubuntu:24.04

WORKDIR /app

COPY workspace/ /app/

# NOTE: the legacy fixture's workspace/opencode.json and workspace/prep-note.txt
# already contained the exact values this task's verifier requires -- i.e. the
# starting workspace already satisfied tests/verify.sh with zero agent action
# (confirmed by running verify.sh against the pristine legacy workspace: exit 0),
# so the task carried no signal. But simply dropping both files (as the first
# conversion pass did) makes the task IMPOSSIBLE instead: verify.sh hard-requires
# the literal "shredder/qwen/qwen3.6-35b-a3b", and that string appears nowhere an
# agent can reach -- not in instruction.md, not in the workspace, and not in the
# `noisy` stash (grep -r shredder harbor/stashes/noisy -> no hits). Only the
# oracle solve.sh knew it, so every real trial in both arms would score 0.
#
# This conversion therefore ships a SEEDED opencode.json that is deliberately
# NOT a passing state (pristine workspace -> reward 0) but from which every
# value verify.sh checks is derivable:
#   - "model": the file declares provider `shredder` with a single entry under
#     `models` ("qwen/qwen3.6-35b-a3b"), and the stash's opencode skill states
#     that `model` is a provider-qualified "<provider>/<model>" string;
#   - "openai": false -- the stash skill states a provider is disabled by
#     setting it to `false`, and the instruction asks for the disable value;
#   - "apiKey": "{env:OPENAI_API_KEY}" -- the seed carries the shell-style
#     "$OPENAI_API_KEY" spelling, and the stash skill states env placeholders
#     must be kept in the `{env:NAME}` form. The env var NAME is visible in the
#     seed; only the FORM has to be looked up.
# prep-note.txt is still not shipped: the instruction quotes all three required
# lines verbatim (as the legacy README did), so the agent creates that file.
#
# This is the one task in the conversion whose environment content was authored
# rather than ported. See docs/corpus-conversion.md "Seeded-workspace exception".
