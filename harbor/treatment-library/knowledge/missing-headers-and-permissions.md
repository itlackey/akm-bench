---
name: missing-headers-and-permissions
description: Fix missing system header / -dev package errors and permission-denied failures — EACCES, EPERM, sudo pitfalls, and file-ownership problems that block builds or installs.
tags: [permissions, eacces, eperm, sudo, headers, dev-package, chmod, chown]
searchHints:
  - "why am I getting permission denied"
  - "what do I do about a missing header file"
  - "permission denied EACCES"
  - "operation not permitted EPERM"
  - "missing header file fatal error"
  - "sudo pip install breaks permissions"
  - "cannot write to directory permission denied"
  - "python.h no such file or directory"
---

# Missing headers and permission errors

Two distinct but frequently co-occurring failure classes: the compiler
can't find a header it needs, or the OS refuses an operation because of
file ownership/permissions.

## Missing system headers ("fatal error: X.h: No such file or directory")

- This means the RUNTIME library may be installed, but the DEVELOPMENT
  package (headers + linkable artifacts) is not. Most Linux distros split
  these:
  - Debian/Ubuntu (`apt`): `libfoo-dev`, e.g. `libssl-dev`, `python3-dev`,
    `libpq-dev`.
  - RHEL/Fedora/CentOS (`dnf`/`yum`): `foo-devel`, e.g. `openssl-devel`,
    `python3-devel`, `libpq-devel`.
  - Alpine (`apk`): often `foo-dev`, e.g. `musl-dev`, `linux-headers`.
- `Python.h: No such file or directory` specifically means the
  `python3-dev`/`python3-devel` package (matching your active Python's
  major.minor version) is missing — needed to build any Python C
  extension from source.
- If the header exists on disk but the compiler still can't find it, it's
  an include-path problem, not a missing-package problem: check `-I` flags,
  `CPATH`/`C_INCLUDE_PATH`/`CPLUS_INCLUDE_PATH` env vars, and confirm the
  header's actual location matches what the build system expects
  (`find / -name "the_header.h" 2>/dev/null` to locate it).
- macOS: Xcode Command Line Tools provide the base compiler + many headers
  (`xcode-select --install`); some libraries also need Homebrew's `-dev`
  equivalent package, and Homebrew paths often need explicit `-I`/`-L`
  flags since they're not always on the default search path (especially on
  Apple Silicon, where Homebrew installs under `/opt/homebrew` rather than
  `/usr/local`).

## Permission denied (EACCES) / Operation not permitted (EPERM)

- `EACCES` (permission denied): the OS understood the request but the
  current user lacks permission — check `ls -l` on the target
  file/directory for owner, group, and mode bits; compare against the user
  actually running the command (`whoami`, `id`).
- `EPERM` (operation not permitted): a stricter failure — even root, or an
  operation that permission bits alone don't explain (immutable file
  attribute, a read-only filesystem/mount, a security module like
  SELinux/AppArmor denying it, a Docker container running with dropped
  capabilities). `ls -l` alone won't explain an EPERM the way it explains
  EACCES — check `lsattr` for immutable flags, `mount` for read-only
  mounts, and `dmesg`/`journalctl` for AppArmor/SELinux denials.

## Common permission traps

- **Global installs without a permission-appropriate tool**: running
  `sudo pip install X` or `sudo npm install -g X` installs as root into
  system directories — this frequently leaves files owned by root that
  your normal user can no longer modify or even read cleanly later, and
  mixes package versions between users. Prefer a virtualenv (Python) or a
  user-level global install path (`npm config set prefix
  ~/.npm-global`, or a Node version manager) over `sudo` for language
  package managers.
- **Docker bind-mount ownership mismatches**: a file created INSIDE a
  container (often as root, or as an arbitrary container UID) shows up
  OUTSIDE with an owner UID that doesn't match your host user, making it
  unreadable/unwritable from the host without `sudo` or a `chown`. Match
  the container's user to the host UID (`--user $(id -u):$(id -g)`, or a
  Dockerfile `USER` matching the expected host UID) to avoid this
  entirely, rather than chowning after the fact every time.
- **`chmod`/`chown` as a first response**: widening permissions
  (`chmod 777`, blanket `chown` to your user) can "fix" the symptom while
  breaking whatever depended on the original ownership/permissions (a
  service running as a different user, a security boundary that was
  intentional). Prefer running the specific command AS the correct
  user/group (`sudo -u serviceuser ...`, joining the right group) over
  changing the file's permissions to fit the wrong user.
- **A read-only filesystem mount** producing EACCES/EPERM on writes that
  "should" work: `mount | grep <path>` to check for `ro` in the mount
  options — common in containers, some CI checkouts, and network mounts.

## Diagnostic order

1. `ls -l` the target path — owner, group, mode bits.
2. `id` / `whoami` — who are you actually running as.
3. If those look consistent with the operation being allowed but it still
   fails: check for a read-only mount, an immutable attribute
   (`lsattr`), or a security module denial (`dmesg | tail`,
   `journalctl -xe`, `aureport --avc` on SELinux systems).
4. Fix at the narrowest scope that solves it (correct user/group for the
   operation) rather than the broadest (world-writable permissions).
