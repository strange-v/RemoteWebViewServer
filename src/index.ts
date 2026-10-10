import http from 'http';
import { WebSocketServer } from "ws"
import env from "env-var";
import { makeConfigFromParams, logDeviceConfig, DeviceConfig } from "./config.js";
import { broadcaster, ensureDeviceAsync, releaseDeviceAsync, getDevice, cleanupIdleAsync, DeviceSession } from './deviceManager.js';
import { InputRouter } from "./inputRouter.js";
import { bootstrapAsync } from './browser.js';
import { getRoot } from './cdpRoot.js';
import { MsgType, parseFrameAckPacket } from './protocol.js';

const WS_PORT = env.get("WS_PORT").default("8081").asIntPositive();
const HEALTH_PORT = env.get("HEALTH_PORT").default("18080").asIntPositive();

const wss = new WebSocketServer({ port: WS_PORT, perMessageDeflate: false });
const inputRouter = new InputRouter();

await bootstrapAsync();

// Every device lives in this browser, so without it there is nothing to recover in-process.
// Exit and let Docker / the HA supervisor restart the container with a fresh browser.
getRoot()?.onClose(() => {
  console.error("[server] Lost the CDP connection to the browser, exiting");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[server] Unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

function handleMessage(dev: DeviceSession, buf: Buffer): void {
  switch (buf.readUInt8(0)) {
    case MsgType.Touch:
      inputRouter.handleTouchPacketAsync(dev, buf).catch(e => console.warn(`Failed to handle touch packet: ${(e as Error).message}`));
      break;
    case MsgType.Keepalive:
      dev.lastActive = Date.now();
      break;
    case MsgType.FrameStats:
      inputRouter.handleFrameStatsPacketAsync(dev, buf).catch(() => console.warn(`Failed to handle Self test packet`));
      break;
    case MsgType.OpenURL:
      inputRouter.handleOpenURLPacketAsync(dev, buf).catch(e => console.warn(`Failed to handle OpenURL packet: ${(e as Error).message}`));
      break;
    case MsgType.RequestFullFrame:
      dev.resendFullFrame();
      break;
    case MsgType.FrameAck: {
      const frameId = parseFrameAckPacket(buf);
      if (frameId !== null) dev.handleFrameAck(frameId);
      break;
    }
  }
}

wss.on("connection", (ws, req) => {
  // Without a listener, a socket error would be thrown as an uncaught exception.
  ws.on("error", (e) => console.warn(`[server] WebSocket error: ${e.message}`));

  let id: string;
  let cfg: DeviceConfig;
  try {
    const url = new URL(req.url || "", `ws://localhost:${WS_PORT}`);
    id = url.searchParams.get("id") || "default";
    cfg = makeConfigFromParams(url.searchParams);
  } catch (e) {
    console.warn(`[server] Rejected connection: ${(e as Error).message}`);
    ws.close(1008, "invalid parameters");
    return;
  }
  logDeviceConfig(id, cfg);

  broadcaster.addClient(id, ws);
  const devReady = ensureDeviceAsync(id, cfg);
  devReady.catch(e => {
    console.warn(`[server] Failed to set up device ${id}: ${(e as Error).message}`);
    ws.close(1011, "device setup failed");
  });

  // Registered before the device is ready: the client sends OpenURL right after connecting.
  // Each message chains on the same promise, so the arrival order is preserved.
  ws.on("message", (msg, isBinary) => {
    if (!isBinary) return;

    const buf: Buffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer);
    if (buf.length < 2) return;
    // Look the device up on every message: it may have been recreated (crash, reconfiguration).
    devReady.then(() => {
      const dev = getDevice(id);
      if (dev) handleMessage(dev, buf);
    }, () => { });
  });

  ws.on("close", () => {
    const dev = getDevice(id);
    if (dev) dev.lastActive = Date.now();
    broadcaster.removeClient(id, ws);
    if (broadcaster.getClientCount(id) === 0)
      releaseDeviceAsync(id).catch(e => console.warn(`[server] Failed to release device ${id}: ${(e as Error).message}`));
  });
});

http.createServer((req, res) => {
  // Lets the HA watchdog / Docker healthcheck notice a dead browser.
  const ok = getRoot()?.isOpen ?? false;
  res.writeHead(ok ? 200 : 500);
  res.end(ok ? 'ok' : 'cdp disconnected');
}).listen(HEALTH_PORT);

setInterval(() => cleanupIdleAsync(), 60_000);

console.log(`[server] WebSocket listening on :${WS_PORT}`);
