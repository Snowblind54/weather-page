#!/usr/bin/env bash
set -euo pipefail
if (( $# < 2 )); then
  echo "usage: $0 <description> <path> [path ...]" >&2
  exit 2
fi
shift
python3 scripts/sync_r2_data.py "$@"
