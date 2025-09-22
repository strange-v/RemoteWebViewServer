#!/usr/bin/env bash
set -euo pipefail

OPTIONS_FILE="/data/options.json"

get_opt() {
  local key="$1" default="$2"
  if [ -f "$OPTIONS_FILE" ]; then
    jq -r --arg k "$key" --arg d "$default" '.[$k] // $d' "$OPTIONS_FILE"
  else
    echo "$default"
  fi
}

export SCREEN_W="$(get_opt screen_w 480)"
export SCREEN_H="$(get_opt screen_h 480)"
export TILE_SIZE="$(get_opt tile_size 32)"
export FULL_FRAME_TILE_COUNT="$(get_opt full_frame_tile_count 4)"
export FULL_FRAME_AREA_THRESHOLD="$(get_opt full_frame_area_threshold 0.5)"
export FULL_FRAME_EVERY="$(get_opt full_frame_every 50)"
export EVERY_NTH_FRAME="$(get_opt every_nth_frame 1)"
export MIN_FRAME_INTERVAL_MS="$(get_opt min_frame_interval_ms 80)"
export JPEG_QUALITY="$(get_opt jpeg_quality 85)"
export MAX_BYTES_PER_MESSAGE="$(get_opt max_bytes_per_message 14336)"
export WS_PORT="$(get_opt ws_port 8081)"
export DEBUG_PORT="$(get_opt debug_port 9221)"
export HEALTH_PORT="$(get_opt health_port 18080)"

USER_DATA_DIR_OPT="$(get_opt user_data_dir "/pw-data")"
if [ "$USER_DATA_DIR_OPT" = "/pw-data" ]; then
  mkdir -p /data/pw-data
  # if not already a symlink, make /pw-data -> /data/pw-data
  if [ ! -L /pw-data ]; then
    rm -rf /pw-data 2>/dev/null || true
    ln -s /data/pw-data /pw-data
  fi
  export USER_DATA_DIR="/pw-data"
else
  mkdir -p "$USER_DATA_DIR_OPT"
  export USER_DATA_DIR="$USER_DATA_DIR_OPT"
fi

EXPOSE_DEBUG_PROXY="$(get_opt expose_debug_proxy false)"
if [ "$EXPOSE_DEBUG_PROXY" = "true" ]; then
  DEBUG_PROXY_PORT="$(get_opt debug_proxy_port 9222)"
  echo "[remote-webview] Starting debug proxy on :${DEBUG_PROXY_PORT} -> 127.0.0.1:${DEBUG_PORT}"
  socat -d -d "TCP-LISTEN:${DEBUG_PROXY_PORT},fork,reuseaddr,keepalive" "TCP:127.0.0.1:${DEBUG_PORT}" &
fi

command -v node >/dev/null
test -f dist/index.js

exec node dist/index.js
