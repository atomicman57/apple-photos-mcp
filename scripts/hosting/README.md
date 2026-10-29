# Hosting apple-photos-mcp over Streamable HTTP (LaunchAgent)

These scripts run the server as a long-lived, **strictly read-only** HTTP
service on `127.0.0.1:8788`, protected by a bearer token kept in the macOS
login keychain. Exposing it beyond localhost (e.g. a tunnel) is out of scope.

```bash
pnpm run build
scripts/hosting/install-launchagent.sh      # idempotent; re-run after rebuilds
scripts/hosting/smoke-http.sh               # 401 checks + initialize + tools/list
scripts/hosting/uninstall-launchagent.sh [--delete-token]
```

## What the installer does

1. Creates the bearer token if it's missing: `openssl rand -hex 32`, stored as a
   generic password, service `apple-photos-mcp`, account `bearer-token`. It's
   never printed. To read it yourself: `security find-generic-password -s
   apple-photos-mcp -a bearer-token -w`.
2. Runs `pnpm run setup` only if `./venv` is missing. An existing venv is left
   alone.
3. Writes `~/Library/LaunchAgents/com.blessingphilips.apple-photos-mcp.plist`
   (`RunAtLoad` + `KeepAlive`). It uses the absolute node path (nvm v24.19.0 if
   present, else `command -v node`, or `NODE_BIN=…`) and `build/index.js`.
4. `launchctl bootout` + `bootstrap gui/$UID`, then waits for `/healthz`.

Logs: `~/Library/Logs/apple-photos-mcp/{stdout,stderr}.log`.

## Full Disk Access (required, one-time)

Under launchd, macOS checks permissions against the **node binary itself**, not
your terminal. Grant Full Disk Access to the exact node path from the installer
output (e.g. `~/.nvm/versions/node/v24.19.0/bin/node`). In the Full Disk Access
list, press **+** and then ⌘⇧G to type the path. Then restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.blessingphilips.apple-photos-mcp
```

Without the grant, the sidecar blocks in `open()` on the library and every tool
times out. `[warmup] failed: Operation timed out` in `stderr.log` is the symptom.
nvm's node is Developer-ID signed, so the grant survives reinstalls of that
version. If you switch node versions, grant the new binary too.

## Environment (set in the plist)

| Variable | Value | Meaning |
|---|---|---|
| `APPLE_PHOTOS_MCP_TRANSPORT` | `http` | Streamable HTTP instead of stdio (`--http` argv also works). |
| `APPLE_PHOTOS_MCP_HTTP_PORT` | `8788` | Listen port. The host is always `127.0.0.1`. |
| `APPLE_PHOTOS_MCP_READ_ONLY` | `1` | Write tools are **not registered** at all, and `ENABLE_WRITES` is forced off. |
| `APPLE_PHOTOS_MCP_ENABLE_WRITES` | `0` | Belt and braces: the write gate stays closed. |
| `APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS` | `0` | Never idle-kill the Python sidecar, so the parsed PhotosDB stays resident. |
| `APPLE_PHOTOS_MCP_TIMEOUT` | `300000` | Per-call budget (ms). Big enough for a cold parse of a large library. |

Optional: `APPLE_PHOTOS_MCP_BEARER_TOKEN` overrides the keychain (never logged).
`APPLE_PHOTOS_MCP_HTTP_SESSION_TTL_MS` (default 24 h) closes idle MCP sessions.
A client whose session was closed gets a 404 and re-initializes.

## HTTP surface

- `GET /healthz` is unauthenticated and returns `ok`. It never touches Photos.
- `POST|GET|DELETE /mcp` (or `/`) is MCP Streamable HTTP with stateful sessions
  (`mcp-session-id`). It requires `Authorization: Bearer <token>`, compared in
  constant time. Without a valid token the answer is `401` with
  `WWW-Authenticate: Bearer`.
- All sessions share one `PhotosManager` and one persistent sidecar. The
  library is parsed once at startup (warmup), not on the first client call.
