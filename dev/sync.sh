#!/bin/bash
#
# Development install. Copies this working tree into the Omarchy plugins
# directory, then reloads the shell.
#
# Why a copy and not a symlink: omarchy-plugin-validate refuses a symlink
# anywhere inside a plugin folder, because a symlink could point a trusted
# plugin at any file on disk. A copy is also what a real user gets from
# `omarchy plugin add`, so development and production stay identical.
#
# Usage:  dev/sync.sh [--restart]
#
#   --restart   Restart the shell instead of rescanning. Needed after any
#               change to a .js file: the shell's rescan clears the QML
#               component cache but not the JavaScript resource cache.

set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
id=$(jq -r '.id' "$repo/manifest.json")
target="$HOME/.config/omarchy/plugins/$id"

restart=0
[[ ${1:-} == --restart ]] && restart=1

command -v omarchy-plugin-validate >/dev/null || {
  echo "dev/sync.sh: omarchy not found on PATH" >&2
  exit 1
}

omarchy-plugin-validate "$repo" || exit 1

mkdir -p "$target"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'dev/' \
  --exclude 'docs/' \
  --exclude 'tests/' \
  --exclude '.gitignore' \
  "$repo"/ "$target"/

echo "Synced $id to $target"

if (( restart )); then
  omarchy restart shell
  echo "Shell restarted."
else
  omarchy-shell shell rescanPlugins >/dev/null
  echo "Plugins rescanned. Use --restart after editing a .js file."
fi
