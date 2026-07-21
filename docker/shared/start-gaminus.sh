#!/bin/bash

# This script is sourced from ~/.bashrc whenever an agent shell opens.
# The application code is immutable at /opt/gaminus; sandbox state and
# logs belong to the agent's canonical data root.
GAMINUS_ROOT="${GAMINUS_ROOT:-/opt/gaminus}"
GAMINUS_DATA_ROOT="${GAMINUS_DATA_ROOT:-$HOME/.gaminus}"
GAMINUS_LOG_FILE="${GAMINUS_LOG_FILE:-$GAMINUS_DATA_ROOT/logs/sandbox.log}"
GAMINUS_PORT="${SERVER_PORT:-3001}"

if ! command -v gaminus >/dev/null 2>&1; then
  printf 'Gaminus sandbox is not installed. Rebuild the local gaminus-sandbox image from prepared repository source.\n' >&2
  return 1 2>/dev/null || exit 1
fi

if [ ! -f "$GAMINUS_ROOT/dist-server/server/cli.js" ]; then
  printf 'Gaminus sandbox source is missing at %s. Rebuild the local image from prepared repository source.\n' "$GAMINUS_ROOT" >&2
  return 1 2>/dev/null || exit 1
fi

mkdir -p "$(dirname "$GAMINUS_LOG_FILE")"
# The canonical log stays under ~/.gaminus. This link keeps the CLI's
# sandbox log command compatible with existing running sandboxes.
ln -sfn "$GAMINUS_LOG_FILE" /tmp/gaminus-ui.log

if ! pgrep -f "$GAMINUS_ROOT/dist-server/server/cli.js" >/dev/null 2>&1; then
  nohup gaminus start --host 0.0.0.0 --port "$GAMINUS_PORT" >> "$GAMINUS_LOG_FILE" 2>&1 &
  disown || true

  printf '\n  Gaminus is starting on port %s.\n\n' "$GAMINUS_PORT"
  printf '  Forward the port from another terminal:\n'
  printf '    sbx ports <sandbox-name> --publish %s:%s\n\n' "$GAMINUS_PORT" "$GAMINUS_PORT"
  printf '  Then open: http://localhost:%s\n\n' "$GAMINUS_PORT"
fi
