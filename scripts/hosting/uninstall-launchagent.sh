#!/usr/bin/env bash
# Stop and remove the apple-photos-mcp HTTP LaunchAgent.
# The keychain bearer token is kept unless --delete-token is passed.
set -euo pipefail

LABEL="com.blessingphilips.apple-photos-mcp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo "unloaded: $LABEL" || echo "not loaded: $LABEL"
if [[ -f "$PLIST" ]]; then rm -f "$PLIST" && echo "removed:  $PLIST"; fi

if [[ "${1:-}" == "--delete-token" ]]; then
  security delete-generic-password -s apple-photos-mcp -a bearer-token >/dev/null 2>&1 \
    && echo "deleted keychain token (apple-photos-mcp/bearer-token)" \
    || echo "no keychain token to delete"
fi
