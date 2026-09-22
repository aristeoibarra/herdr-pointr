#!/bin/sh
# The manifest's only [[build]] step. `herdr plugin install` runs it in a fresh
# checkout, and only its exit status counts — so the fallback lives in here.
#
# First choice is the binary CI built from this exact commit for this platform
# (.github/workflows/dist.yml): nothing to install, nothing to compile. It is
# named by commit, not by version, on purpose: a version-named binary would
# hand an install from `main` a few commits past a release a bridge that does
# not match its own source, and nothing would fail to say so.
#
# Anything short of a complete binary builds from source, which needs Go and
# npm. Without them the install fails with a message saying so.
set -eu
cd "$(dirname "$0")/.."

log() { printf 'pointr build: %s\n' "$*" >&2; }

# owner/repo from the remote herdr cloned, so a fork fetches its own binaries.
github_repo() {
  url=$(git remote get-url origin 2>/dev/null) || return 1
  case "$url" in
    https://github.com/*) repo=${url#https://github.com/} ;;
    git@github.com:*) repo=${url#git@github.com:} ;;
    *) return 1 ;;
  esac
  printf '%s' "${repo%.git}"
}

platform() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 120 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 120 -O "$2" "$1"
  else
    log "neither curl nor wget found"
    return 1
  fi
}

prebuilt() {
  repo=$(github_repo) || return 1
  target=$(platform) || { log "no prebuilt binary for $(uname -s)/$(uname -m)"; return 1; }
  sha=$(git rev-parse HEAD) || return 1
  url="https://github.com/$repo/releases/download/dist/pointr-$target-$sha.tar.gz"
  download "$url" "$work/pointr.tar.gz" || {
    log "no prebuilt binary for $target at $sha"
    return 1
  }
  tar -xzf "$work/pointr.tar.gz" -C "$work" || return 1
  [ -s "$work/pointr" ] || { log "prebuilt archive has no binary"; return 1; }
  chmod +x "$work/pointr" || return 1
  # Refuse a binary that cannot run here rather than install a broken plugin.
  "$work/pointr" help >/dev/null 2>&1 || { log "prebuilt binary does not run here"; return 1; }
  mkdir -p dist && mv "$work/pointr" dist/pointr
}

# Inside the checkout, so the final mv is a rename on one filesystem.
work=$(mktemp -d "$PWD/.build-XXXXXX")
trap 'rm -rf "$work"' EXIT

if prebuilt; then
  log "using the prebuilt binary"
  exit 0
fi

if ! command -v go >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  log "building from source needs Go and npm, and this machine is missing one"
  exit 1
fi
log "building from source"
npm ci
npm run build
