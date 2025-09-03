import http from 'http';
import { WebSocketServer } from "ws"
import env from "env-var";
import { broadcaster, ensureDeviceAsync, cleanupIdleAsync } from './deviceManager.js';
import { InputRouter } from "./inputRouter.js";
import { bootstrapAsync } from './browser.js';

const WS_PORT = env.get("WS_PORT").default("8081").asIntPositive();
const HEALTH_PORT = env.get("HEALTH_PORT").default("18080").asIntPositive();

const wss = new WebSocketServer({ port: WS_PORT, perMessageDeflate: false });
const inputRouter = new InputRouter(12);

await bootstrapAsync();

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url || "", `ws://localhost:${WS_PORT}`);
  const id = url.searchParams.get("id") || "default";

  broadcaster.addClient(id, ws);
  const dev = await ensureDeviceAsync(id);

  ws.on("message", (msg, isBinary) => {
    if (!isBinary) return;

    const buf: Buffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer);
    if (buf.length >= 9 && buf.subarray(0, 4).toString("ascii") === "TOUC") {
      inputRouter.handleTouchPacketAsync(dev, buf).catch(() => { });
    }
  })

  ws.on("close", () => {
    dev.lastActive = Date.now();
    broadcaster.removeClient(id, ws);
  })
});

http.createServer(async (req, res) => {
  try {
    res.writeHead(200); res.end('ok');
  } catch (e) {
    res.writeHead(500); res.end('err');
  }
}).listen(HEALTH_PORT);

// setInterval(() => cleanupIdleAsync(), 60_000);

console.log(`[server] WebSocket listening on :${WS_PORT}`);
