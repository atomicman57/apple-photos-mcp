#!/usr/bin/env bash
# Install (or refresh) the apple-photos-mcp HTTP LaunchAgent. Idempotent.
#
#   - ensures the bearer token exists in the login keychain
#     (service "apple-photos-mcp", account "bearer-token"); never prints it
#   - ensures the project venv exists (pnpm run setup) if missing
#   - writes ~/Library/LaunchAgents/com.blessingphilips.apple-photos-mcp.plist
#   - (re)bootstraps it in gui/$UID and waits for /healthz
#
# Overrides: NODE_BIN=/abs/path/to/node  APPLE_PHOTOS_MCP_HTTP_PORT=8788
#            APPLE_PHOTOS_MCP_TIMEOUT=300000 (ms; cold PhotosDB parse budget)
set -euo pipefail

LABEL="com.blessingphilips.apple-photos-mcp"
KC_SERVICE="apple-photos-mcp"
KC_ACCOUNT="bearer-token"
PORT="${APPLE_PHOTOS_MCP_HTTP_PORT:-8788}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/apple-photos-mcp"
DOMAIN="gui/$(id -u)"

die() { echo "error: $*" >&2; exit 1; }

# --- node: pinned nvm v24.19.0, else whatever `node` resolves to now ---------
if [[ -z "${NODE_BIN:-}" ]]; then
  if [[ -x "$HOME/.nvm/versions/node/v24.19.0/bin/node" ]]; then
    NODE_BIN="$HOME/.nvm/versions/node/v24.19.0/bin/node"
  else
    NODE_BIN="$(command -v node || true)"
  fi
fi
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "node not found (set NODE_BIN)"
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "node >= 20 required (got $("$NODE_BIN" -v) at $NODE_BIN)"
echo "node:   $NODE_BIN ($("$NODE_BIN" -v))"

ENTRY="$REPO_ROOT/build/index.js"
[[ -f "$ENTRY" ]] || die "$ENTRY missing — run 'pnpm run build' first"

# --- python venv: build only if missing (never touch an existing one) --------
if [[ ! -x "$REPO_ROOT/venv/bin/python3" ]]; then
  echo "venv:   missing — running scripts/setup.sh"
  (cd "$REPO_ROOT" && PATH="$(dirname "$NODE_BIN"):$PATH" bash scripts/setup.sh)
else
  echo "venv:   $REPO_ROOT/venv (existing, left as-is)"
fi

# --- bearer token in the login keychain --------------------------------------
if security find-generic-password -s "$KC_SERVICE" -a "$KC_ACCOUNT" >/dev/null 2>&1; then
  echo "token:  keychain item exists ($KC_SERVICE/$KC_ACCOUNT)"
else
  token="$(openssl rand -hex 32)"
  # Fed via `security -i` on stdin so the value never appears in argv / ps.
  printf 'add-generic-password -U -s %s -a %s -l %s -w %s\n' \
    "$KC_SERVICE" "$KC_ACCOUNT" "$KC_SERVICE" "$token" | security -i >/dev/null
  unset token
  security find-generic-password -s "$KC_SERVICE" -a "$KC_ACCOUNT" >/dev/null 2>&1 \
    || die "failed to store the bearer token in the login keychain"
  echo "token:  generated and stored in keychain ($KC_SERVICE/$KC_ACCOUNT)"
fi

# --- plist -------------------------------------------------------------------
xml() { local s="$1"; s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; printf '%s' "$s"; }
mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
ENV_PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"

tmp="$(mktemp)"
cat > "$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE_BIN")</string>
    <string>$(xml "$ENTRY")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$REPO_ROOT")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>APPLE_PHOTOS_MCP_TRANSPORT</key><string>http</string>
    <key>APPLE_PHOTOS_MCP_HTTP_PORT</key><string>$(xml "$PORT")</string>
    <key>APPLE_PHOTOS_MCP_READ_ONLY</key><string>1</string>
    <key>APPLE_PHOTOS_MCP_ENABLE_WRITES</key><string>0</string>
    <key>APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS</key><string>0</string>
    <key>APPLE_PHOTOS_MCP_TIMEOUT</key><string>$(xml "${APPLE_PHOTOS_MCP_TIMEOUT:-300000}")</string>
    <key>PATH</key><string>$(xml "$ENV_PATH")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
  </dict>
  <key>StandardOutPath</key><string>$(xml "$LOG_DIR/stdout.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG_DIR/stderr.log")</string>
</dict>
</plist>
PLIST
plutil -lint "$tmp" >/dev/null || { rm -f "$tmp"; die "generated plist failed plutil -lint"; }
mv "$tmp" "$PLIST"
chmod 644 "$PLIST"
echo "plist:  $PLIST"

# --- (re)load ----------------------------------------------------------------
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "loaded: $DOMAIN/$LABEL"

for _ in $(seq 1 30); do
  if [[ "$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null)" == "ok" ]]; then
    echo "health: http://127.0.0.1:$PORT/healthz ok"
    echo "logs:   $LOG_DIR/"
    echo "note:   launchd runs $NODE_BIN directly — it needs Full Disk Access"
    echo "        (System Settings > Privacy & Security > Full Disk Access), then:"
    echo "        launchctl kickstart -k $DOMAIN/$LABEL"
    exit 0
  fi
  sleep 1
done
die "server did not answer /healthz within 30s — see $LOG_DIR/stderr.log"
