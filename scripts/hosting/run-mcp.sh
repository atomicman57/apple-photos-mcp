#!/bin/bash
set -euo pipefail
export HOME="${HOME:-/Users/blessingphilips}"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$HOME/mcp/apple-photos-mcp"
export APPLE_PHOTOS_MCP_TRANSPORT=http
export APPLE_PHOTOS_MCP_HTTP_PORT=8788
export APPLE_PHOTOS_MCP_READ_ONLY=1
export APPLE_PHOTOS_MCP_ENABLE_WRITES=0
export APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS=0
export APPLE_PHOTOS_MCP_TIMEOUT=300000
exec "$HOME/.nvm/versions/node/v24.19.0/bin/node" build/index.js
