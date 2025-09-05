# Remote WebView Server

Headless browser that renders target web pages (e.g., Home Assistant dashboards) and streams them as image tiles over WebSocket to lightweight clients (ESP32 displays).

## Features

- Renders pages in a headless Chromium environment and streams diffs as tiles over WebSocket.
- Supports full-frame fallback at a chosen cadence or when scene changes exceed a threshold.
- Configurable JPEG quality, tile sizing, and message sizing to fit transport limits.
- Health endpoint for container orchestration.
- Optional DevTools access (via TCP proxy) for live page inspection.

## Image Tags & Versioning

- latest — newest stable release
- beta — newest pre-release (rolling)
- Semantic versions: X.Y.Z, plus convenience tags X.Y, X on stable releases

You can pin a stable release (`1.4.0`) or track channels (`latest`, `beta`) depending on your deployment strategy.

## Docker Compose Example

```yaml
services:
  rwvserver:
    image: strangev/remote-webview-server:latest  # use :beta for pre-release
    container_name: remote-webview-server
    restart: unless-stopped
    environment:
      DEFAULT_VIEWPORT_W: 480
      DEFAULT_VIEWPORT_H: 480
      TILE_SIZE: 32
      FULLFRAME_TILE_COUNT: 4
      FULLFRAME_AREA_THRESHOLD: 0.5
      FULLFRAME_EVERY: 50
      JPEG_QUALITY: 85
      MAX_BYTES_PER_WS_MSG: 14336
      WS_PORT: 8081
      DEBUG_PORT: 9221                # internal DevTools port
      HEALTH_PORT: 18080
      USER_DATA_DIR: /pw-data
      DEVICE_MAP_JSON: >
        [
          { "id": "living-room",     "url": "http://172.16.0.252:8123/dashboard-mobile/0" },
          { "id": "master-bedroom",  "url": "http://172.16.0.252:8123/dashboard-mobile/1" }
        ]
    ports:
      - "8081:8081"                   # WebSocket stream
      - "9222:9222"                   # external DevTools via socat
    expose:
      - "18080"                       # health endpoint (internal)
      - "9221"                        # internal DevTools port
    volumes:
      - /opt/volumes/esp32-rdp/pw-data:/pw-data
    devices:
      - "/dev/dri:/dev/dri"           # GPU (optional)
    group_add:
      - "993"                         # render group GID (adjust for your host)
      - "44"                          # video group GID  (adjust for your host)
    shm_size: 1gb
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:18080 || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s

  debug-proxy:
    image: alpine/socat
    container_name: remote-webview-server-debug
    restart: unless-stopped
    network_mode: "service:rwvserver"
    depends_on:
      rwvserver:
        condition: service_healthy
    command:
      - "-d"
      - "-d"
      - "TCP-LISTEN:9222,fork,reuseaddr,keepalive" # external DevTools port
      - "TCP:127.0.0.1:9221"
```
