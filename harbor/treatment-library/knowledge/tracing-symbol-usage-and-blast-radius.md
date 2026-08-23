---
name: tracing-symbol-usage-and-blast-radius
description: Find every definition and call site of a function, class, or symbol before changing or removing it — including re-exports, dynamic access, and string-based routing that plain text search misses.
tags: [trace, symbol, references, definition, usages, grep, refactor, blast-radius, rename]
searchHints:
  - "how do I find all of the places a function is used"
  - "where is this function used in the rest of the codebase"
  - "find all usages of a function"
  - "find every place a symbol is called"
  - "where is this function defined and used"
  - "trace all references before renaming"
  - "is it safe to remove this function"
  - "what would break if I change this function's signature"
when_to_use: "Before renaming, changing the signature of, or removing a function, class, constant, or config key — find every place it's actually used first."
---

# Tracing symbol usage and blast radius

Before renaming, changing the signature of, or removing a symbol, find
every definition and usage site first — a fast way to see what a change
would actually affect before touching it.

## Procedure

1. **Find the DEFINITION site(s).** Search for the declaration pattern for
   the detected language — `def NAME(`, `function NAME(`, `class NAME`,
   `const NAME =`, `fn NAME(`, etc. Use `rg -w "NAME"` as a fallback
   whole-word search if the pattern is ambiguous or the language isn't
   obvious (see find-and-grep-recipes for the underlying search commands).
2. **Find every USAGE site.** `rg -w "NAME"` across the repo, excluding the
   definition site(s) found in step 1, to get every call site, import, and
   reference.
3. **Group results**: definitions, direct calls/usages, and mentions in
   tests separately from mentions in comments/docs — a symbol used only in
   comments/docs is a different signal than one with real call sites, and
   tests are often the first thing that breaks from a signature change.
4. **Note any usage via a less-literal path that plain text search would
   miss:**
   - Re-exports (`export { NAME }` under a different name, `from .module
     import NAME as OTHER_NAME`).
   - Dynamic access — `getattr(obj, "NAME")`, `obj["NAME"]`, reflection —
     these reference the name as a runtime STRING, not a language-level
     identifier a plain-text search for the bare word will necessarily
     connect to the definition.
   - String-based routing or config that references the name as a plain
     string (a route table, a plugin registry, a serialized config key)
     rather than a direct call.
5. **Report a count of usages and a short list of the files most
   affected** — this is the blast-radius estimate for the change. A symbol
   with one definition and three call sites, all in tests, is a very
   different risk than one with the same shape but call sites spread
   across a dozen production modules.

## Why plain `rg` alone can undercount

A rename or removal that looks safe from a literal-text search can still
break a caller that reaches the symbol through a re-export, a
`getattr`/reflection path, or a string-keyed lookup — none of which contain
the exact identifier text a naive search expects. When the symbol is
exported from a module's public surface (an `__init__.py`'s imports, a
`package.json` `"exports"` field, a `lib.rs`), specifically check whether
anything outside the repo (a published package's consumers, a plugin
loaded by name) could also depend on it — that blast radius is invisible
to any search scoped to this repo alone.
