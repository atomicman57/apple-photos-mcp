#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"
TOKEN=$(/usr/bin/security find-generic-password -s apple-photos-mcp -a tunnel-token -w)
exec cloudflared tunnel --no-autoupdate run --token "$TOKEN"
