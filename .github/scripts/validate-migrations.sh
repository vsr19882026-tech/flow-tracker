#!/usr/bin/env bash
# Migration PR gate. Migrations are append-only and sequential:
#   - a PR that touches migrations/ adds exactly ONE new file
#   - the new file is named <NNNN>_<description>.sql, lower_snake description
#   - NNNN is exactly (highest existing number) + 1 — no gaps, no reuse
#   - no existing migration is edited, deleted, or renamed
#
# Usage: validate-migrations.sh <base-ref>   (e.g. origin/main)
set -euo pipefail

BASE_REF="${1:?base ref required (e.g. origin/main)}"
MIGRATIONS_DIR="migrations"

# Changes this PR introduces under migrations/ (three-dot = since merge-base).
mapfile -t changed < <(git diff --name-status "${BASE_REF}...HEAD" -- "$MIGRATIONS_DIR")

if [ ${#changed[@]} -eq 0 ]; then
  echo "No migration changes in this PR — migration gate passes."
  exit 0
fi

echo "Migration changes detected:"
printf '  %s\n' "${changed[@]}"

added=()
for line in "${changed[@]}"; do
  status=$(printf '%s' "$line" | cut -f1)
  file=$(printf '%s' "$line" | cut -f2)
  case "$status" in
    A)
      added+=("$file")
      ;;
    *)
      echo "::error::MIGRATION TAMPERING: existing migration '$file' was modified/deleted/renamed (status $status). Migrations are append-only — never change one that has shipped. Add a new forward migration instead."
      exit 1
      ;;
  esac
done

if [ ${#added[@]} -ne 1 ]; then
  echo "::error::A migration PR must add exactly ONE new file; this PR adds ${#added[@]}."
  exit 1
fi

base_name=$(basename "${added[0]}")
if ! [[ "$base_name" =~ ^([0-9]{4})_[a-z0-9_]+\.sql$ ]]; then
  echo "::error::Bad migration filename '$base_name'. Expected '<NNNN>_<description>.sql' — 4-digit number, lower_snake description."
  exit 1
fi
new_num=$((10#${BASH_REMATCH[1]}))

# Highest existing migration number in the base tree.
highest=0
while IFS= read -r f; do
  bn=$(basename "$f")
  if [[ "$bn" =~ ^([0-9]{4})_ ]]; then
    n=$((10#${BASH_REMATCH[1]}))
    if [ "$n" -gt "$highest" ]; then highest="$n"; fi
  fi
done < <(git ls-tree -r --name-only "$BASE_REF" -- "$MIGRATIONS_DIR" | grep -E '\.sql$' || true)

expected=$((highest + 1))
if [ "$new_num" -ne "$expected" ]; then
  printf -v exp4 '%04d' "$expected"
  printf -v hi4 '%04d' "$highest"
  echo "::error::Migration number gap: new migration is '$(printf '%04d' "$new_num")' but the next sequential number is '$exp4' (highest existing is '$hi4'). Do not skip or reuse numbers."
  exit 1
fi

echo "OK: '$base_name' is a valid sequential forward migration (expected $(printf '%04d' "$expected"))."
