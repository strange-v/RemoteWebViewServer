import { WebSocketServer } from "ws"
import { broadcaster, ensureDeviceAsync, cleanupIdleAsync } from './deviceManager';
import { InputRouter } from "./inputRouter";
import { bootstrapAsync } from './browser';

const WS_PORT = +(process.env.WS_PORT || 8081);

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
})

// setInterval(() => cleanupIdleAsync(), 60_000);

console.log(`[server] WebSocket listening on :${WS_PORT}`);
