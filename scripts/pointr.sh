#!/bin/sh
# Single entrypoint for every command herdr runs from herdr-plugin.toml. herdr
# resolves `sh` through PATH, which always works; the bridge binary is then run
# from the plugin root, wherever herdr started us.
set -eu

cd "${HERDR_PLUGIN_ROOT:-$(dirname "$0")/..}"

if [ ! -x dist/pointr ]; then
  echo "pointr: dist/pointr is missing — run 'npm install && npm run build'" >&2
  echo "        (herdr plugin link does not run the manifest's build commands)" >&2
  exit 1
fi

exec dist/pointr "$@"
