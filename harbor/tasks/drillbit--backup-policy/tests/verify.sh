#!/usr/bin/env bash
# Strict verifier for a fictional-CLI task.
#
# `drillbit` exists only in harbor/stashes/drillbit/skills/drillbit/SKILL.md.
# The whole discriminating power of this task is that the documented command
# form is NOT guessable, so this verifier accepts ONLY that form. The one
# variation allowed is the ORDER of the documented flags; everything else is
# rejected -- invented subcommands (`drillbit backup configure ...`),
# renamed flags, undocumented extra flags, a flag where the stash documents a
# positional (or vice versa), a wrong value format, or a missing flag.
set -uo pipefail

# --- documented form for THIS task -------------------------------------
FILE=commands.txt
# leading command words, in order:
WORDS=(drillbit backup)
# positional arguments after the command words, in order:
POSITIONAL=()
# documented flags and their required values (order between them may vary):
declare -A FLAGS=([--cluster]=vault-primary [--retention]=90d [--snapshots]=7)
# extended-regexes that must NOT appear anywhere in FILE (stale/invalid forms
# the task requires to be removed):
FORBIDDEN=()
# -----------------------------------------------------------------------

if [[ ! -f "$FILE" ]]; then echo "$FILE missing"; exit 1; fi

for pattern in ${FORBIDDEN[@]+"${FORBIDDEN[@]}"}; do
  if grep -qE -- "$pattern" "$FILE"; then
    echo "$FILE still contains a form the drillbit CLI does not accept (matched /$pattern/)"
    cat "$FILE"
    exit 1
  fi
done

# The stash formats examples with backslash line continuations; join them so
# a faithfully copied multi-line command is still a single candidate line.
normalized=$(sed -e ':a' -e '/\\$/{N; s/\\\n/ /; ba' -e '}' "$FILE")

nwords=${#WORDS[@]}
npos=${#POSITIONAL[@]}
nflags=${#FLAGS[@]}
expected=$(( nwords + npos + 2 * nflags ))

unquote() {
  local v=$1
  [[ $v == \"*\" && ${#v} -ge 2 ]] && v=${v:1:${#v}-2}
  [[ $v == \'*\' && ${#v} -ge 2 ]] && v=${v:1:${#v}-2}
  printf '%s' "$v"
}

matched=0
while IFS= read -r line; do
  read -r -a tok <<<"$line"
  (( ${#tok[@]} == expected )) || continue

  ok=1
  for (( i = 0; i < nwords; i++ )); do
    [[ "${tok[i]}" == "${WORDS[i]}" ]] || { ok=0; break; }
  done
  (( ok )) || continue

  for (( i = 0; i < npos; i++ )); do
    [[ "$(unquote "${tok[nwords + i]}")" == "${POSITIONAL[i]}" ]] || { ok=0; break; }
  done
  (( ok )) || continue

  unset seen; declare -A seen=()
  i=$(( nwords + npos ))
  while (( i < expected )); do
    flag=${tok[i]}
    value=$(unquote "${tok[i + 1]}")
    if [[ -v "FLAGS[$flag]" ]] && [[ "${FLAGS[$flag]}" == "$value" ]] && [[ ! -v "seen[$flag]" ]]; then
      seen[$flag]=1
    else
      ok=0; break
    fi
    i=$(( i + 2 ))
  done
  (( ok )) || continue
  (( ${#seen[@]} == nflags )) || continue

  matched=1
  break
done <<<"$normalized"

if (( matched == 0 )); then
  echo "no line in $FILE matches the documented drillbit command form"
  echo "expected: ${WORDS[*]} ${POSITIONAL[*]} <the documented flags, in any order>"
  echo "$FILE contains:"
  cat "$FILE"
  exit 1
fi

echo "ok"
