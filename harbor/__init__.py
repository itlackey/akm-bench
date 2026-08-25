"""akm-bench's Harbor extensions — and a shim that keeps them from breaking Harbor.

This directory holds the custom Harbor agent (``harbor.akm_opencode:AkmOpenCode``),
its seed library and its job configs.

Why this file is not empty
--------------------------
Harbor resolves a custom agent with a plain ``importlib.import_module``: no
``sys.path`` manipulation, no file-path support. So ``harbor.akm_opencode`` only
resolves when this repository's root is on ``sys.path`` — typically
``PYTHONPATH="$(pwd)" harbor run ...``.

That is also the problem. This package is named ``harbor``, and ``PYTHONPATH``
entries are searched **before** site-packages, so this directory **shadows the
installed Harbor distribution**. With a plain empty ``__init__.py`` the very
first thing that happens is::

    >>> import harbor.agents.installed.opencode
    ModuleNotFoundError: No module named 'harbor.agents'
    >>> harbor.__version__
    AttributeError: module 'harbor' has no attribute '__version__'

which breaks not just this agent but the ``harbor`` console script itself.

Two shims fix that, and neither monkey-patches anything:

1. ``extend_path`` appends every *other* ``harbor`` package directory found on
   ``sys.path`` to this package's ``__path__``. Submodule lookup then searches
   this directory first (finding ``akm_opencode``) and the installed
   distribution second (finding ``agents``, ``cli``, ``models``, ...).

2. A module-level ``__getattr__`` forwards attribute access to the installed
   distribution's own ``__init__``. Harbor's top level is not inert — it defines
   ``__version__`` and a lazy-import ``__getattr__`` behind ``harbor.Job``,
   ``harbor.JobConfig`` and friends — and replacing it with an empty module
   would silently strip all of that.

If you would rather not shadow Harbor at all, the alternative is to move this
package under a distinct top-level name and use that in the ``import_path``.
The layout here is the one the P0 job config and runbook document, so it is what
this shim supports.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pkgutil import extend_path
from types import ModuleType

# Make the installed Harbor's submodules reachable through this package.
__path__ = extend_path(__path__, __name__)

#: Private module name for the installed distribution's ``__init__``. Kept out
#: of ``sys.modules["harbor"]`` so it can never recurse back into this shim.
_UPSTREAM_MODULE_NAME = "_harbor_upstream_init"

_HERE = os.path.dirname(os.path.abspath(__file__))


def _find_upstream_init() -> str | None:
    """Return the installed Harbor's ``__init__.py``, or None if unavailable.

    ``__path__`` was just extended, so every entry other than this directory is
    a genuine ``harbor`` package directory found elsewhere on ``sys.path``.
    """
    for entry in __path__:
        try:
            if os.path.abspath(entry) == _HERE:
                continue
            candidate = os.path.join(entry, "__init__.py")
            if os.path.isfile(candidate):
                return candidate
        except (TypeError, ValueError):  # pragma: no cover - exotic path entries
            continue
    return None


def _load_upstream() -> ModuleType | None:
    """Load (once) the installed Harbor's ``__init__`` as a private module."""
    cached = sys.modules.get(_UPSTREAM_MODULE_NAME)
    if cached is not None:
        return cached

    init_path = _find_upstream_init()
    if init_path is None:
        return None

    spec = importlib.util.spec_from_file_location(_UPSTREAM_MODULE_NAME, init_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        return None

    module = importlib.util.module_from_spec(spec)
    # Register before exec so a self-referential import inside it resolves.
    sys.modules[_UPSTREAM_MODULE_NAME] = module
    try:
        spec.loader.exec_module(module)
    except Exception:  # pragma: no cover - a broken install is not ours to mask
        sys.modules.pop(_UPSTREAM_MODULE_NAME, None)
        raise
    return module


def __getattr__(name: str):
    """Forward ``harbor.<name>`` to the installed distribution's top level.

    Covers ``__version__``, ``__all__`` and every entry in Harbor's own lazy
    ``_LAZY_IMPORTS`` table. Harbor's lazy loader calls
    ``importlib.import_module("harbor.job")``, which resolves back through this
    package's extended ``__path__`` — so the objects handed out are the real
    ones, not duplicates.
    """
    upstream = _load_upstream()
    if upstream is not None:
        try:
            return getattr(upstream, name)
        except AttributeError:
            pass
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
