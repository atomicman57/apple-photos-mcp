#!/usr/bin/env bash
# Smoke-test the HTTP server: /healthz, 401 without/with a wrong token, then
# initialize + tools/list with the keychain token (never printed; passed to
# curl via a header file descriptor, not argv). Asserts the read-only surface.
set -euo pipefail

BASE="http://127.0.0.1:${APPLE_PHOTOS_MCP_HTTP_PORT:-8788}/mcp"
HEALTH="${BASE%/mcp}/healthz"
fail() { echo "FAIL: $*" >&2; exit 1; }
ACCEPT="Accept: application/json, text/event-stream"
CT="Content-Type: application/json"

[[ "$(curl -fsS "$HEALTH")" == "ok" ]] || fail "/healthz"
echo "ok   GET /healthz"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$CT" -H "$ACCEPT" -d '{}' "$BASE")
[[ "$code" == 401 ]] || fail "no token -> $code (want 401)"
echo "ok   no token -> 401"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$CT" -H "$ACCEPT" \
  -H "Authorization: Bearer not-the-token" -d '{}' "$BASE")
[[ "$code" == 401 ]] || fail "wrong token -> $code (want 401)"
echo "ok   wrong token -> 401"

TOKEN="${APPLE_PHOTOS_MCP_BEARER_TOKEN:-$(security find-generic-password -s apple-photos-mcp -a bearer-token -w 2>/dev/null || true)}"
[[ -n "$TOKEN" ]] || fail "no token in keychain (apple-photos-mcp/bearer-token)"
auth() { curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") -H "$CT" -H "$ACCEPT" "$@"; }
# Streamable HTTP may answer as JSON or SSE; strip SSE framing.
body() { sed -n 's/^data: //p; /^{/p'; }

hdrs="$(mktemp)"; trap 'rm -f "$hdrs"' EXIT
init=$(auth -D "$hdrs" -X POST "$BASE" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | body)
SID=$(awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}' "$hdrs" | tr -d '\r')
[[ -n "$SID" ]] || fail "initialize returned no mcp-session-id: $init"
echo "$init" | grep -q '"serverInfo"' || fail "initialize: $init"
echo "ok   initialize (session ${SID:0:8}…)"

auth -o /dev/null -X POST "$BASE" -H "mcp-session-id: $SID" -H "mcp-protocol-version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
tools=$(auth -X POST "$BASE" -H "mcp-session-id: $SID" -H "mcp-protocol-version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | body)
names=$(printf '%s' "$tools" | grep -o '"name":"[a-z-]*"' | cut -d'"' -f4 | sort -u | tr '\n' ' ')
for want in query get-photo get-thumbnail export; do
  [[ " $names " == *" $want "* ]] || fail "tools/list missing $want: $names"
done
for banned in create-album add-to-album remove-from-album set-photo-metadata set-keywords set-photo-date import-photos; do
  [[ " $names " != *" $banned "* ]] || fail "write tool exposed: $banned"
done
echo "ok   tools/list: $(wc -w <<<"$names" | tr -d ' ') tools, no write tools"

auth -o /dev/null -X DELETE "$BASE" -H "mcp-session-id: $SID" -H "mcp-protocol-version: 2025-06-18"
echo "ok   DELETE session"
echo "PASS"
