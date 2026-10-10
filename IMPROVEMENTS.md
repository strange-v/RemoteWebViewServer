# RemoteWebView Server — open improvements

As of 2026-10-10

Only what is not done yet and still relevant. Completed work (stability, image correctness, backpressure, recovery from browser failures, the new self-test) is in the history of the `improvements` branch.

## Security

The server drives a browser that is logged in to Home Assistant, and its WebSocket port is open to the LAN without authentication.

| Problem | Where | What to do |
| --- | --- | --- |
| Anyone on the LAN can connect with any `id`, see the dashboard and control it. | `index.ts` (`connection` handler) | Optional `AUTH_TOKEN` (env) / `auth_token` (HA add-on). The client passes `?token=…`; a missing or wrong token closes the socket with 1008 before a tab is created. Compare with `crypto.timingSafeEqual`. Without a token configured, behave as now and log a warning. |
| OpenURL opens any scheme, including `file://`: container files such as `/data/options.json` can be read off the screen. | `inputRouter.ts` (`handleOpenURLPacketAsync`) | Allow only `http:`/`https:` and the `self-test` keyword; reject the rest with a warning. Add `ALLOWED_URL_SCHEMES` for exceptions. Apply the same check to the URL a device is recreated on after a tab crash. |
| `expose_debug_proxy` exposes CDP without authentication: full control of the browser, including HA cookies. | README, add-on option docs | Document a clear warning. |

Client side: an `auth_token` ESPHome option and a `token` parameter in the connection URL. The release is compatible both ways: an old server ignores `token`, a new server without a token works as before. Only clients configured with a `file://` or `data:` URL break. Limitation: over `ws://` the token travels in plain text.

## Pacing frames to the device

Backpressure kicks in late. First the device's decode queue fills (12 messages), then the lwIP TCP window and the server's OS send buffer, which `bufferedAmount` can't see. For full-screen frames that is 0.5 s or more of stale frames: the screen lags behind while scrolling or switching tabs. That's why a single `min_frame_interval` is always a trade-off between smooth animations and lag on full-screen changes, and why the self-test measures scrolling at several intervals.

A smaller client queue alone doesn't fix it. With `decode_queue_depth: 4` on an ESP32-S3 (480×480, ~46 ms per full frame), the self-test's scrolling burst at `min_frame_interval: 20` still left the screen 1.1–1.7 s behind: the server sent 68 full frames in 2 s while the device drew ~36, and the ~650 KB in between sat mostly in TCP buffers, far beyond the 4-message queue. At 60 ms it was 0.12–0.2 s behind, at 15 fps instead of 18.

**Frame ack — done on the server, the client still has to send it.** The server handles `FrameAck [type=8][ver][frame_id u32]` (cumulative: everything up to `frame_id`) and, once a client acks, keeps at most 2 frames in flight to it, with a 1 s timeout for lost acks and a reset on reconnect. Clients that don't ack work as before. With an emulated ESP (80 ms per full frame), scrolling at 40 ms went from 1.9 s behind to 0.27 s at the same frame rate.

Client side: after finishing the message with `FLAG_LAST_OF_FRAME` (drawn or not), send `FrameAck` with its `frame_id`, using the existing bounded `ws_send_bin_` so the decode task can't block for long. A failed send is fine: the next ack covers it, and the server's timeout covers the rest.

## Self-test

| Problem | What to do |
| --- | --- |
| `FrameStats` has no frame count, no max time and no rx/queue/decode/draw breakdown from the client. So "Device" in the self-test is an average and the network part is derived as a remainder. | Extend the packet backward-compatibly (fields after the existing 10 bytes). Do it together with P4 in the client's `docs/IMPROVEMENTS.md`. |
