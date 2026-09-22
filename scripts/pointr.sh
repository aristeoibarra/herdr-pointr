#!/bin/sh
# Single entrypoint for every command herdr runs from herdr-plugin.toml.
#
# It exists to pin a usable node. A manifest `command = ["node", ...]` resolves
# through the herdr server's PATH, and under a version manager that PATH points
# at a per-shell symlink farm in /run (fnm) or a versioned directory that a
# later upgrade removes (nvm, asdf). Either way the plugin works until the next
# reboot or node upgrade and then fails with "node: not found" from a service
# with no terminal attached. Resolving a stable interpreter here, once, is the
# difference between a plugin that survives an upgrade and one that does not.
set -eu

cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}"

node_bin() {
  # fnm and nvm both keep a stable alias outside the versioned directories.
  for candidate in \
    "${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/node" \
    "${NVM_DIR:-$HOME/.nvm}/alias/default/bin/node"
  do
    [ -x "$candidate" ] && { printf '%s' "$candidate"; return; }
  done
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for candidate in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node; do
    [ -x "$candidate" ] && { printf '%s' "$candidate"; return; }
  done
  echo "pointr: no node interpreter found" >&2
  exit 1
}

if [ ! -f dist/cli.js ]; then
  echo "pointr: dist/cli.js is missing — run 'npm install && npm run build'" >&2
  echo "        (herdr plugin link does not run the manifest's build commands)" >&2
  exit 1
fi

exec "$(node_bin)" dist/cli.js "$@"
