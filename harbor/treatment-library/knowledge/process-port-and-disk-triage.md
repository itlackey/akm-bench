---
name: process-port-and-disk-triage
description: Triage port-already-in-use, disk-full, and runaway-process problems on Linux — lsof/ss to find what holds a port, ps to find what's eating CPU or memory, df/du to find what's eating disk.
tags: [linux, port, process, disk-full, lsof, ss, netstat, ps, df, du]
searchHints:
  - "how can I tell which process is using port 8080"
  - "what do I do when the disk is full"
  - "port already in use find what's using it"
  - "address already in use error starting server"
  - "disk full no space left on device"
  - "find process using the most memory"
  - "process using 100% cpu find and kill it"
  - "which process has this file open"
---

# Process, port, and disk triage

Three of the most common "something on this machine is wrong" categories,
and the fastest command for each.

## Port already in use / EADDRINUSE / "address already in use"

- Find what's holding a port: `lsof -i :PORT` (shows PID, command, user).
- Alternative (no lsof, or need TCP/UDP + state detail):
  `ss -ltnp | grep :PORT` (`-l` listening, `-t` TCP, `-n` numeric, `-p`
  show process — `-p` may need root).
- Older systems / macOS fallback: `netstat -anp | grep PORT` (flags vary
  by platform; macOS `netstat` doesn't support `-p` the same way — prefer
  `lsof -i :PORT` on macOS).
- Once you have the PID, decide before killing anything:
  - If it's a stale/crashed instance of the SAME service you're trying to
    start (a dev server, a test harness, your own process from a previous
    run that didn't exit cleanly): safe to `kill PID` (SIGTERM first;
    `kill -9 PID` only if it doesn't stop) and retry.
  - If it's an unrelated, legitimately running service that happens to
    have taken the port you wanted: do NOT kill it — either configure your
    process to use a different port, or ask before touching a service you
    don't own.
  - If a supervisor (systemd, a process manager, `restart: always` in
    Docker) is respawning it immediately after each kill, stop the
    SUPERVISOR, not the child process, or explain that constraint instead
    of retrying kill in a loop.
- Report the final state: which process now holds the port (if any), and
  what action was taken and why.

## Disk full — "no space left on device"

- `df -h` shows filesystem-level usage — start here to confirm which
  MOUNT is actually full (it may not be `/`; `/tmp`, `/var`, or a separate
  data volume are common culprits).
- `du -sh /path/to/dir/*` shows size per subdirectory one level down —
  descend into the largest one and repeat (`du -sh */*`) to narrow down
  the actual large consumer.
- `du -sh /var/log/* 2>/dev/null | sort -rh | head` — a fast way to find
  the largest log files specifically, a very common disk-full cause.
- A full disk can ALSO be an inode exhaustion problem, not a byte-size
  problem — `df -h` shows bytes; `df -i` shows inode usage. Millions of
  tiny files (a runaway cache, an unbounded temp-file generator) can
  exhaust inodes while `df -h` still shows free bytes.
- A file that's been deleted but is still held open by a running process
  does NOT free its disk space until the process exits or closes the file
  handle — `lsof +L1` (or `lsof | grep deleted`) finds deleted-but-still-open
  files holding space; killing/restarting the holding process reclaims it.
- Docker/container hosts specifically: `docker system df` shows space used
  by images/containers/volumes/build cache; `docker system prune` (careful:
  destructive) reclaims it.

## Runaway process — high CPU or memory

- `ps aux --sort=-%cpu | head` — top CPU consumers system-wide.
- `ps aux --sort=-%mem | head` — top memory consumers.
- `top` / `htop` for a live, continuously updating view — `htop` is
  generally easier to read if available (colorized, sortable interactively,
  shows per-core CPU).
- Once you've identified the PID: `ps -p PID -o pid,ppid,cmd,etime,%cpu,%mem`
  for detail on exactly that process (parent PID, how long it's been
  running, full command line).
- Before killing: check whether it's actually the CAUSE of a problem or
  just a normal heavy workload (a legitimate build, a legitimate batch
  job) — killing a long-running legitimate job because it "looks" heavy in
  a snapshot is a common self-inflicted incident.
- Graceful stop first (`kill PID`, sends SIGTERM, lets the process clean
  up) before forceful (`kill -9 PID`, SIGKILL, no cleanup) — reserve `-9`
  for a process that ignores SIGTERM.

## Finding what has a specific file open

- `lsof /path/to/file` — every process with that file open.
- `fuser /path/to/file` — a lighter-weight alternative, prints just the
  PIDs.
- Needed when a file/device can't be unmounted, deleted, or modified
  ("resource busy" / "text file busy") — identify and stop the holding
  process rather than repeatedly retrying the operation.

## General triage order for "something's wrong with this box"

1. `df -h` and `df -i` — is it actually a disk problem?
2. `ps aux --sort=-%cpu` / `--sort=-%mem` — is one process consuming an
   outsized share of a resource?
3. `ss -ltnp` — is the expected service actually listening on the expected
   port, and is anything unexpected also listening?
4. Only after the above: dig into application-level logs for the specific
   symptom — infra-level triage first rules out entire categories of cause
   in seconds.
