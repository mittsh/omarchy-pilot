#!/bin/bash
#
# The whole test suite. Each stage skips itself when its tool is missing, so
# this runs on a developer machine, in CI, and on a machine with no Omarchy.
#
#   tests/all.sh

set -uo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
failures=0

stage() { printf '\n== %s\n' "$1"; }

stage "Unit tests"
if command -v node >/dev/null; then
  for file in "$repo"/tests/*.test.js; do
    node "$file" || failures=$((failures + 1))
  done
else
  echo "  skipped: node not found"
fi

stage "Manifest validation"
if command -v omarchy-plugin-validate >/dev/null; then
  if omarchy-plugin-validate "$repo"; then
    echo "  manifest.json is valid"
  else
    failures=$((failures + 1))
  fi
else
  echo "  skipped: omarchy not installed"
fi

stage "QML lint"
if command -v qmllint >/dev/null && [[ -n ${OMARCHY_PATH:-} ]]; then
  shopt -s nullglob
  qml=("$repo"/*.qml)
  if (( ${#qml[@]} )); then
    qmllint -I "$OMARCHY_PATH/shell" "${qml[@]}" || failures=$((failures + 1))
  else
    echo "  no .qml files yet"
  fi
else
  echo "  skipped: qmllint not installed"
fi

printf '\n'
if (( failures )); then
  echo "FAILED: $failures stage(s)"
  exit 1
fi
echo "All stages passed."
