# Fragment context contract benchmark

This deterministic, first-party benchmark checks the fragment API itself. It
does not call a model and it does not reproduce LongMemEval; third-party memory
quality remains the responsibility of `akm-eval`.

The v1 fixture covers:

- opaque exact selectors and backward-compatible exact-by-default `show`;
- an indexed-safe lead plus an explicitly labelled selected fragment;
- previous/next fragment provenance as the bounded neighbor-navigation surface;
- default, character, and token hard bounds;
- a selected fragment above ordinal 20 in a parent larger than 20,000 bytes;
- stale disk content after indexing, for both exact and lead reads;
- selected/parent refs, source lines, fragment counts, and separate token estimates;
- an obsolete lead fact conflicting with a current selected fact;
- fenced blocks, HTML comments, and link destinations that must never leak.

## Container-only baseline and candidate run

The host needs only Git and Docker. Run the published 0.9.14 baseline, then a
local 0.9.15 checkout:

```sh
bin/akm-fragment-contract run \
  --results-dir ./bench-results/fragments \
  --akm-version 0.9.14 \
  --expect baseline

bin/akm-fragment-contract run \
  --results-dir ./bench-results/fragments \
  --akm-source ../akm \
  --expect candidate \
  --label akm-0.9.15-local

bin/akm-fragment-contract compare \
  --baseline ./bench-results/fragments/akm-0.9.14.json \
  --candidate ./bench-results/fragments/akm-0.9.15-local.json \
  --output ./bench-results/fragments/comparison.json
```

Use `--akm-package /path/to/akm-cli-0.9.15.tgz` instead of `--akm-source`
to exercise the exact package artifact. Source and package builds are cached by
content hash under `.akm-bench-cache`; fixture execution is always isolated.

The 0.9.14 report deliberately records the 0.9.15 context and provenance checks
as `unsupported`, while requiring its established exact-selector behavior to
pass. Candidate mode requires every compatibility and new feature check. The
comparison gate rejects compatibility regressions, missing candidate features,
or a candidate that does not add any passing feature capability.
