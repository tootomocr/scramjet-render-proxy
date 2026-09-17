#!/usr/bin/env bash
# Start wireproxy (if WG_* is configured) then the Node server.
# - WG_PRIVATE_KEY unset  -> direct egress (previous behavior, nothing changes)
# - WG_PRIVATE_KEY set    -> userspace WireGuard via wireproxy, Node dials out
#   through its SOCKS5 port (UPSTREAM_SOCKS). No root / tun device needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BIN="$ROOT/bin/wireproxy"
SOCKS_ADDR="${SOCKS_ADDR:-127.0.0.1:25344}"
SOCKS_HOST="${SOCKS_ADDR%:*}"
SOCKS_PORT="${SOCKS_ADDR##*:}"

cleanup() {
  if [ -n "${WIREPROXY_PID:-}" ]; then
    kill "$WIREPROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ -n "${WG_PRIVATE_KEY:-}" ]; then
  : "${WG_ADDRESS:?WG_ADDRESS is required (e.g. 10.200.200.2/32)}"
  : "${WG_PEER_PUBLIC_KEY:?WG_PEER_PUBLIC_KEY is required}"
  : "${WG_PEER_ENDPOINT:?WG_PEER_ENDPOINT is required (host:port)}"

  if [ ! -x "$BIN" ]; then
    bash "$ROOT/scripts/install-wireproxy.sh"
  fi

  # Generated configs stay out of git (see .gitignore). Never log secrets.
  umask 077
  WG_CONF="$ROOT/.wg0.local.conf"
  WP_CONF="$ROOT/.wireproxy.local.conf"
  {
    echo "[Interface]"
    echo "PrivateKey = ${WG_PRIVATE_KEY}"
    echo "Address = ${WG_ADDRESS}"
    if [ -n "${WG_DNS:-}" ]; then echo "DNS = ${WG_DNS}"; fi
    echo ""
    echo "[Peer]"
    echo "PublicKey = ${WG_PEER_PUBLIC_KEY}"
    echo "Endpoint = ${WG_PEER_ENDPOINT}"
    echo "AllowedIPs = ${WG_ALLOWED_IPS:-0.0.0.0/0}"
    echo "PersistentKeepalive = ${WG_KEEPALIVE:-25}"
    if [ -n "${WG_PRESHARED_KEY:-}" ]; then echo "PresharedKey = ${WG_PRESHARED_KEY}"; fi
  } > "$WG_CONF"
  {
    echo "WGConfig = ${WG_CONF}"
    echo ""
    echo "[Socks5]"
    echo "BindAddress = ${SOCKS_ADDR}"
    if [ -n "${SOCKS_USERNAME:-}" ]; then
      echo "Username = ${SOCKS_USERNAME}"
      echo "Password = ${SOCKS_PASSWORD:-}"
    fi
  } > "$WP_CONF"

  echo "starting wireproxy (SOCKS5 on ${SOCKS_ADDR})..."
  "$BIN" -c "$WP_CONF" >> "$ROOT/wireproxy.log" 2>&1 &
  WIREPROXY_PID=$!

  # Wait until the SOCKS port accepts connections (max ~15s).
  for _ in $(seq 1 75); do
    if (echo > "/dev/tcp/${SOCKS_HOST}/${SOCKS_PORT}") 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  if ! (echo > "/dev/tcp/${SOCKS_HOST}/${SOCKS_PORT}") 2>/dev/null; then
    echo "wireproxy did not open ${SOCKS_ADDR}; see wireproxy.log" >&2
    exit 1
  fi

  if [ -n "${SOCKS_USERNAME:-}" ]; then
    export UPSTREAM_SOCKS="socks5://${SOCKS_USERNAME}:${SOCKS_PASSWORD:-}@${SOCKS_ADDR}"
  else
    export UPSTREAM_SOCKS="socks5://${SOCKS_ADDR}"
  fi
  echo "egress: WireGuard via ${SOCKS_ADDR}"
else
  echo "WG_PRIVATE_KEY not set; egress: direct"
fi

exec node src/index.js
