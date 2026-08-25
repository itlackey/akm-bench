---
name: dependency-and-lockfile-errors
description: Diagnose dependency resolution failures — npm/yarn peer dependency conflicts, Python version pin conflicts, lockfile out of sync with the manifest, and transitive dependency clashes.
tags: [dependency, lockfile, npm, pip, peer-dependency, version-conflict, package-manager]
searchHints:
  - "why is my npm install failing"
  - "what do I do about a dependency version conflict"
  - "npm install fails peer dependency conflict"
  - "lockfile out of sync with package.json"
  - "pip dependency version conflict"
  - "could not find a version that satisfies the requirement"
  - "yarn install fails resolution error"
  - "transitive dependency version clash"
---

# Dependency and lockfile errors

Almost every "install fails" or "wrong version got installed" problem is one
of: the manifest and lockfile disagree, two dependencies want incompatible
versions of a shared transitive dependency, or a version constraint is
stricter than what's actually available.

## npm / yarn / pnpm — peer dependency conflicts

- `npm ERR! ERESOLVE unable to resolve dependency tree` names the
  conflicting packages and their required version RANGES directly in the
  error — read the full tree it prints, the answer is usually right there.
- A peer dependency conflict means package A requires peer package C at
  version range `^2.0`, while package B (or your own `package.json`)
  requires C at `^3.0` — both cannot be satisfied by one installed copy.
- Fix options, in order of preference:
  1. Upgrade the older-constrained package (A) to a version whose peer
     range accepts the newer C, if available.
  2. Downgrade C (or B) if the newer major isn't actually needed yet.
  3. As a last resort, `npm install --legacy-peer-deps` (or
     `--force`) installs anyway — this SILENCES the conflict, it does not
     resolve it; only use it once you've confirmed the mismatched peer
     range is a false positive (packages are actually compatible in
     practice) or as a deliberate, documented temporary measure.

## Lockfile out of sync with the manifest

- Symptom: `npm ci` fails with "package.json and package-lock.json are not
  in sync" (or the yarn/pnpm equivalent), even though `npm install` alone
  "works". This means someone edited `package.json` by hand, or a merge
  combined the manifest and lockfile inconsistently, without regenerating
  the lockfile.
- Fix: regenerate deliberately — run the package manager's install command
  once locally to update the lockfile, review the resulting diff (do the
  version bumps make sense?), then commit the updated lockfile alongside
  the manifest change. Do not hand-edit a lockfile.
- **`npm ci` / `yarn install --frozen-lockfile` / `pnpm install
  --frozen-lockfile` are the commands CI should use** — they fail loudly on
  drift instead of silently re-resolving, which is exactly the signal you
  want in CI and exactly the check that catches this class of bug before
  merge.
- After a merge/rebase that touched both the manifest and the lockfile,
  regenerate the lockfile rather than trusting git's line-based merge of a
  machine-generated file — lockfile merges frequently produce a
  syntactically valid but semantically wrong result.

## Python — version pin conflicts

- `pip`'s resolver (20.3+) prints the exact conflicting requirement chain
  on failure — e.g. "package-a requires foo<2, but package-b requires
  foo>=2" — read it fully before guessing.
- `pip install pipdeptree` (or `pipdeptree` if already available) shows the
  full dependency tree with conflicts flagged, which is faster than manually
  tracing requirement chains for anything beyond a two-package conflict.
- A `requirements.txt` with hardcoded exact pins (`foo==1.2.3`) is the most
  common source of an otherwise-resolvable conflict — relaxing an
  overly-strict pin (`foo>=1.2.3,<2`) that was never actually required is
  usually safer than force-installing.
- Separate direct/deliberate pins from transitive ones if the file conflates
  them — a tool like `pip-compile` (from `pip-tools`) generates a fully
  pinned lockfile from a small file of direct, loosely-pinned requirements,
  which makes conflicts far easier to reason about than a flat, fully
  pinned `requirements.txt` maintained by hand.

## Transitive dependency clashes (any ecosystem)

- Two of YOUR direct dependencies each depend on a third package at
  incompatible versions. Most modern package managers (npm/yarn/pnpm,
  Cargo, modern pip) can install multiple versions of the SAME transitive
  dependency side-by-side when the language/runtime supports it (Node,
  Rust) — the failure only happens when the ecosystem requires a single
  global version (many Python packages effectively do, since a single
  `site-packages` holds one version per package name) or when the
  conflicting versions are ABI/type-incompatible even if technically
  co-installable.
- `npm ls <package>` / `yarn why <package>` / `cargo tree -i <package>` /
  `pipdeptree -p <package>` all answer "who depends on this, and at what
  version" — use the tool for your ecosystem before manually grepping
  lockfiles.
- If two direct dependencies are simply incompatible at their current
  versions, check each one's changelog/releases for a version where the
  transitive requirement was relaxed or aligned — this is often a matter of
  bumping one of the two, not a real irreconcilable conflict.

## General debugging order for any "dependency install failed"

1. Read the FULL resolver error — every modern package manager names the
   specific conflicting packages/versions; do not skim past this.
2. Confirm whether the lockfile and manifest agree (`npm ci` /
   `--frozen-lockfile` / a Python lockfile check) before assuming it's a
   real version conflict rather than drift.
3. Identify whether the conflict is direct (two of your own listed
   dependencies) or transitive (buried a few levels down) using the
   ecosystem's tree/why tool.
4. Prefer relaxing an overly strict pin or bumping the older package over
   force-installing past the resolver's objection.
