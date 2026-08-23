"""Keep converted-task verifier tests out of a repo-root pytest run.

Each `harbor/tasks/<task>/tests/test_*.py` is a *container* verifier: Harbor
copies it to `/tests` and runs it with cwd=`/app`, where the task workspace
lives. Collected from the repo root it has no `/app`, and — worse — it shares
a module basename with its unconverted twin under
`fixtures/corpus/tasks/<domain>/<task>/tests/`. With no `__init__.py` in
either tree, pytest's rootdir-relative module naming makes the two collide:

    import file mismatch:
    imported module 'test_bridge_network' has this __file__ attribute:
      .../fixtures/corpus/tasks/docker-homelab/bridge-network/tests/test_bridge_network.py
    which is not the same as the test file we want to collect:
      .../harbor/tasks/docker-homelab--bridge-network/tests/test_bridge_network.py

That is a *collection* error, so all 17 of them abort the entire repo-root
run ("Interrupted: 17 errors during collection") before a single real test in
`harbor/tests/` executes. Ignoring them here fixes it at the source without
renaming verifier files (their names are part of the ported fixture) and
without touching any shared pytest config.

This file sits one level ABOVE every task directory, so Harbor never copies it
into a container, and `DatasetConfig._get_local_task_configs`'s one-level
`path.iterdir()` scan skips it (a file is not a valid task dir) — `-p
harbor/tasks` still resolves 46 tasks.
"""

collect_ignore_glob = ["*/tests/test_*.py"]
