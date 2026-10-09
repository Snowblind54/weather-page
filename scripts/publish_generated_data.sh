#!/usr/bin/env bash
set -euo pipefail
if (( $# < 2 )); then
  echo "usage: $0 <description> <path> [path ...]" >&2
  exit 2
fi
shift
paused="${R2_PAUSED:-false}"
if [[ "${paused,,}" != "true" ]] && python3 scripts/sync_r2_data.py "$@"; then
  exit 0
fi
echo 'R2 publication unavailable or paused; publishing the GitHub fallback.'
python3 scripts/github_fallback.py publish "$@"
