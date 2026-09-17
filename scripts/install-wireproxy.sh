#!/usr/bin/env bash
# Download the wireproxy binary (Linux) if not already present.
# No root required: wireproxy is a fully userspace WireGuard client.
# Called from render.yaml buildCommand, and as a fallback from scripts/start.sh.
set -euo pipefail

VERSION="${WIREPROXY_VERSION:-v1.1.3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/bin"
BIN="$BIN_DIR/wireproxy"

if [ -x "$BIN" ]; then
  echo "wireproxy already present: $BIN"
  "$BIN" --version || true
  exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) GOARCH="amd64" ;;
  aarch64|arm64) GOARCH="arm64" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

URL="https://github.com/windtf/wireproxy/releases/download/${VERSION}/wireproxy_linux_${GOARCH}.tar.gz"
echo "downloading wireproxy ${VERSION} (${GOARCH})..."
mkdir -p "$BIN_DIR" /tmp
curl -fsSL -o /tmp/wireproxy.tgz "$URL"
tar -xzf /tmp/wireproxy.tgz -C "$BIN_DIR"
rm -f /tmp/wireproxy.tgz

# The tarball may nest the binary; normalize to bin/wireproxy.
if [ ! -f "$BIN" ]; then
  FOUND="$(find "$BIN_DIR" -name 'wireproxy*' -type f | head -n 1 || true)"
  if [ -n "${FOUND:-}" ]; then
    mv "$FOUND" "$BIN"
  fi
fi

chmod +x "$BIN"
echo "installed: $BIN"
"$BIN" --version || true
