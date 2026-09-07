# Fragment contract fixture v1

This first-party fixture tests AKM's fragment addressing and context-return
contract. It is deliberately deterministic and contains no model-scored tasks;
LongMemEval and other third-party benchmark packs remain in `akm-eval`.

The timeline places a unique selected fragment above ordinal 20, brackets it
with deterministic neighbors, conflicts with an obsolete lead value, and puts
unsafe Markdown payloads in the lead. The harness indexes the fixture, mutates
the source without reindexing, and verifies that opaque selectors continue to
resolve against the indexed safe revision.
