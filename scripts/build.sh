#!/bin/sh
# The manifest's only [[build]] step. `herdr plugin install` runs it in a fresh
# checkout, and only its exit status counts — so the fallback lives in here and
# herdr never sees the attempt that missed.
#
# First choice is the bundle CI built from this exact commit (.github/workflows/
# dist.yml): a ~40 KB download instead of ~100 MB of devDependencies. It is
# named by commit, not by version, on purpose. A version-named bundle would
# hand an install from `main` a few commits past a release a dist/ that does
# not match its own source, and nothing would fail to say so. By commit, the
# bundle either exists for exactly this code or does not exist at all.
#
# Anything short of a complete bundle — no network, no curl or wget, a 404
# because CI has not finished, a truncated archive — builds from source, which
# is what every install did before.
set -eu
cd "$(dirname "$0")/.."

log() { printf 'pointr build: %s\n' "$*" >&2; }

# owner/repo from the remote herdr cloned, so a fork fetches its own bundles.
github_repo() {
  url=$(git remote get-url origin 2>/dev/null) || return 1
  case "$url" in
    https://github.com/*) repo=${url#https://github.com/} ;;
    git@github.com:*) repo=${url#git@github.com:} ;;
    *) return 1 ;;
  esac
  printf '%s' "${repo%.git}"
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 60 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 60 -O "$2" "$1"
  else
    log "neither curl nor wget found"
    return 1
  fi
}

# Every file the plugin needs at runtime; must match tsup.config.ts's outputs.
REQUIRED="cli.js widget.global.js screenshot.global.js"

prebuilt() {
  repo=$(github_repo) || return 1
  sha=$(git rev-parse HEAD) || return 1
  url="https://github.com/$repo/releases/download/dist/pointr-dist-$sha.tar.gz"
  download "$url" "$work/dist.tar.gz" || {
    log "no prebuilt bundle for $sha"
    return 1
  }
  mkdir "$work/dist" || return 1
  tar -xzf "$work/dist.tar.gz" -C "$work/dist" || return 1
  for file in $REQUIRED; do
    [ -s "$work/dist/$file" ] || {
      log "prebuilt bundle is missing $file"
      return 1
    }
  done
  # Swapped in whole, only once it is known complete.
  rm -rf dist && mv "$work/dist" dist && chmod +x dist/cli.js
}

# Inside the checkout, so the final mv is a rename on one filesystem.
work=$(mktemp -d "$PWD/.build-XXXXXX")
trap 'rm -rf "$work"' EXIT

if prebuilt; then
  log "using the prebuilt bundle"
  exit 0
fi

log "building from source"
npm ci
npm run build
