import http from 'http';
import { WebSocketServer } from "ws"
import env from "env-var";
import { makeConfigFromParams, setConfigFor, logDeviceConfig, DeviceConfig } from "./config.js";
import { broadcaster, ensureDeviceAsync, cleanupIdleAsync, DeviceSession } from './deviceManager.js';
import { InputRouter } from "./inputRouter.js";
import { bootstrapAsync } from './browser.js';
import { MsgType } from './protocol.js';

const WS_PORT = env.get("WS_PORT").default("8081").asIntPositive();
const HEALTH_PORT = env.get("HEALTH_PORT").default("18080").asIntPositive();

const wss = new WebSocketServer({ port: WS_PORT, perMessageDeflate: false });
const inputRouter = new InputRouter();

await bootstrapAsync();

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
  setConfigFor(id, cfg);
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
    devReady.then(dev => handleMessage(dev, buf), () => { });
  });

  ws.on("close", () => {
    devReady.then(dev => { dev.lastActive = Date.now(); }, () => { });
    broadcaster.removeClient(id, ws);
  });
});

http.createServer(async (req, res) => {
  try {
    res.writeHead(200); res.end('ok');
  } catch (e) {
    res.writeHead(500); res.end('err');
  }
}).listen(HEALTH_PORT);

setInterval(() => cleanupIdleAsync(), 60_000);

console.log(`[server] WebSocket listening on :${WS_PORT}`);
