---
name: reading-stack-traces
description: Read a stack trace or exception traceback correctly across Python, JavaScript/Node, Java, and Go, and find the root cause frame instead of the outermost error line — AttributeError, TypeError, KeyError, NullPointerException, undefined is not a function, and other common exception types.
tags: [traceback, stacktrace, exception, error, debugging, stack-trace, root-cause, AttributeError, TypeError, KeyError, IndexError, ValueError, NameError, ModuleNotFoundError, ImportError, NullPointerException, UnhandledPromiseRejection, nil-pointer-dereference]
searchHints:
  - "how do I read a stack trace"
  - "which line of the traceback actually matters"
  - "how to read a stack trace"
  - "understand a python traceback"
  - "javascript error stack trace confusing"
  - "which line in the stack trace actually matters"
  - "exception caused by another exception chained"
  - "read a stack trace to find the root cause"
  - "find the root cause frame in a traceback"
  - "AttributeError NoneType object has no attribute"
  - "TypeError cannot read properties of undefined"
  - "KeyError or IndexError in python"
  - "KeyError missing key in a python dict"
  - "NullPointerException in java"
  - "what does this exception type mean"
when_to_use: "Any time an error, exception, or traceback appears in output and the next step is to find the root cause frame rather than just the outermost error line."
---

# Reading stack traces

A traceback tells you the exact call chain at the moment of failure. Most of
it is noise; a small number of frames matter. Read it systematically instead
of scanning for a familiar-looking line.

## General reading order

1. **Read the exception type and message first.** `TypeError`,
   `NullPointerException`, `undefined is not a function` — the type narrows
   the space of causes before you look at a single frame.
2. **Find the LAST frame that is YOUR code**, not library/framework/stdlib
   code. That is almost always where the actual mistake is, even if the
   crash surfaces deeper inside a library call.
3. **Read frame-by-frame from that point outward** (both directions): what
   was passed in, what was expected, where the mismatch originates.
4. **Do not stop at the first error you see.** If there is a "caused by" /
   "chained" / "during handling of the above exception" section, the
   ORIGINAL exception (usually printed first or nested deepest) is the root
   cause — the outer one is often just a wrapper or a secondary failure
   during cleanup.

## Python

- Traceback prints **outermost call first, innermost (failing) frame
  last** — read bottom to top for the actual failure site.
- `The above exception was the direct cause of...` / `During handling of the
  above exception, another exception occurred` — the FIRST exception is the
  root cause; a second exception thrown inside an `except:` block is a
  secondary failure, don't chase it instead of the original.
- `File "...", line N, in <function>` plus the source line is printed —
  check the actual values at that line (add a print or use a debugger) if
  the mismatch is not obvious from static reading.

## JavaScript / Node

- Stack is innermost (failing) frame first, top of the printed stack.
- `at Object.<anonymous>` / `at processTicksAndRejections` /
  `node:internal/...` frames are runtime internals — skip past them to find
  your own file paths in the stack.
- An `UnhandledPromiseRejection` or a `TypeError: Cannot read properties of
  undefined` almost always means a value you assumed was populated is
  `undefined` or `null` — trace backwards to where that value should have
  been set.
- Minified/bundled stacks (`main.js:1:23456`) need a source map to be
  useful; without one, reproduce in dev/unminified mode first.

## Java / JVM

- Read top to bottom: top frame is where the exception was thrown.
- `Caused by:` sections stack — the DEEPEST `Caused by:` (last one printed)
  is usually the original root cause; everything above it is a wrapper
  exception thrown while handling or propagating the first.
- Line numbers require the class was compiled with debug info; a
  `(Unknown Source)` frame means no line info is available for that class.

## Go

- `panic: <message>` followed by `goroutine N [running]:` and a frame list,
  innermost first.
- A `nil pointer dereference` almost always means an interface or pointer
  was never initialized on some code path — check every return path of the
  constructor/factory function, not just the happy path.
- `runtime error: index out of range [N] with length M` tells you the exact
  index and length — no guessing needed, go straight to the indexing
  expression.

## Cross-language rules of thumb

- The line number in the crash is where the SYMPTOM appeared, not
  necessarily where the BUG is. A null value crash three calls later often
  originates where the null was first allowed to exist.
- Copy the exact error text into a search only after you've read the
  frames — many identical-looking messages have different root causes
  depending on the call site.
- If the trace mentions a library internal you don't recognize, check your
  installed library VERSION — the same call can behave differently across
  versions, and the traceback's file paths tell you exactly which version's
  source is running.
