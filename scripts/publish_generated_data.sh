#!/usr/bin/env bash
set -euo pipefail

if (( $# < 2 )); then
  echo "usage: $0 <commit message> <path> [path ...]" >&2
  exit 2
fi

message="$1"
shift

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'

staged_any=false
for path in "$@"; do
  if [[ -e "$path" ]] || git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    git add -A -- "$path"
    staged_any=true
  fi
done

if [[ "$staged_any" != true ]] || git diff --cached --quiet; then
  echo 'No generated-data changes to publish.'
  exit 0
fi

git commit -m "$message"

# Several independent weather updaters can finish within the same few seconds.
# Rebase onto the newest main and retry instead of failing on a harmless race.
max_attempts=6
for ((attempt=1; attempt<=max_attempts; attempt++)); do
  echo "Publish attempt ${attempt}/${max_attempts}"
  git fetch origin main

  if ! git rebase origin/main; then
    git rebase --abort || true
    echo 'Rebase conflict while publishing generated data.' >&2
    exit 1
  fi

  if git push origin HEAD:main; then
    echo 'Generated data published successfully.'
    exit 0
  fi

  if (( attempt < max_attempts )); then
    delay=$((attempt * 2 + RANDOM % 4))
    echo "main moved again; retrying in ${delay}s..."
    sleep "$delay"
  fi
done

echo "Could not publish generated data after ${max_attempts} attempts." >&2
exit 1
