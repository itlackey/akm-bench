#!/usr/bin/env bash
# Strict verifier for a LOCAL-CONVENTION task (docs/task-class-local-convention.md).
#
# The tool here is real and the model knows it well. What it cannot know is the
# Northwind standard, which lives ONLY in
# harbor/stashes/northwind-platform/knowledge/. This verifier therefore accepts
# ONLY the documented local form and explicitly REJECTS the confident public
# default -- see FORBIDDEN. Flag ORDER may vary; nothing else may.
set -uo pipefail

FILE=commands.txt
WORDS=(git switch)
declare -A FLAGS=([-c]=feat/NW-1234-add-csv-export)
SINGLES=()
TRAILING=()
FORBIDDEN=(git[[:space:]]+checkout[[:space:]]+-b -c[[:space:]]+(feature/|add-csv|csv-export|NW-1234[[:space:]]*$))

if [[ ! -f "$FILE" ]]; then echo "$FILE missing"; exit 1; fi

for pattern in ${FORBIDDEN[@]+"${FORBIDDEN[@]}"}; do
  if grep -qE -- "$pattern" "$FILE"; then
    echo "$FILE contains a form the Northwind standard forbids (matched /$pattern/)"
    cat "$FILE"
    exit 1
  fi
done

# Stash examples use backslash continuations; join them so a faithfully copied
# multi-line command is still a single candidate line.
normalized=$(sed -e ':a' -e '/\\$/{N; s/\\\n/ /; ba' -e '}' "$FILE")

nwords=${#WORDS[@]}
nflags=${#FLAGS[@]}
nsingles=${#SINGLES[@]}
ntrailing=${#TRAILING[@]}
expected=$(( nwords + 2 * nflags + nsingles + ntrailing ))

unquote() {
  local v=$1
  [[ $v == \"*\" && ${#v} -ge 2 ]] && v=${v:1:${#v}-2}
  [[ $v == \'*\' && ${#v} -ge 2 ]] && v=${v:1:${#v}-2}
  printf '%s' "$v"
}

matched=0
while IFS= read -r line; do
  read -r -a tok <<<"$line"
  # Exact token count: this is what rejects an undocumented extra flag or a
  # missing required one before any per-token check runs.
  (( ${#tok[@]} == expected )) || continue

  ok=1
  for (( i = 0; i < nwords; i++ )); do
    [[ "${tok[i]}" == "${WORDS[i]}" ]] || { ok=0; break; }
  done
  (( ok )) || continue

  unset seen; declare -A seen=()
  i=$nwords
  while (( i < ${#tok[@]} )); do
    t=${tok[i]}
    if [[ -v "FLAGS[$t]" ]] && [[ ! -v "seen[$t]" ]]; then
      (( i + 1 < ${#tok[@]} )) || { ok=0; break; }
      [[ "${FLAGS[$t]}" == "$(unquote "${tok[i + 1]}")" ]] || { ok=0; break; }
      seen[$t]=1
      i=$(( i + 2 ))
      continue
    fi
    is_single=0
    for s in ${SINGLES[@]+"${SINGLES[@]}"}; do
      if [[ "$t" == "$s" ]] && [[ ! -v "seen[$s]" ]]; then
        seen[$s]=1; is_single=1; break
      fi
    done
    (( is_single )) && { i=$(( i + 1 )); continue; }
    break
  done
  (( ok )) || continue
  (( ${#seen[@]} == nflags + nsingles )) || continue

  # Whatever is left must be the trailing positionals, in order.
  for (( j = 0; j < ntrailing; j++ )); do
    [[ "$(unquote "${tok[i + j]}")" == "${TRAILING[j]}" ]] || { ok=0; break; }
  done
  (( ok )) || continue
  (( i + ntrailing == ${#tok[@]} )) || continue

  matched=1
  break
done <<<"$normalized"

if (( matched == 0 )); then
  echo "no line in $FILE matches the Northwind standard command form"
  echo "expected: ${WORDS[*]} <documented flags, any order> ${TRAILING[*]}"
  echo "$FILE contains:"
  cat "$FILE"
  exit 1
fi

echo "ok"
