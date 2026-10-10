import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "node:net";
import { CdpConnection } from "../src/cdpRoot.js";

// A fake CDP endpoint: `respond` decides what to send back for each command.
async function fakeCdp(respond: (msg: any, ws: WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>(r => wss.once("listening", () => r()));
  wss.on("connection", ws => ws.on("message", data => respond(JSON.parse(String(data)), ws)));
  const port = (wss.address() as AddressInfo).port;
  return { wss, url: `ws://127.0.0.1:${port}` };
}

let servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const s of servers) {
    for (const c of s.clients) c.terminate();
    await new Promise(r => s.close(r));
  }
  servers = [];
});

describe("CdpConnection", () => {
  it("resolves responses and routes session events", async () => {
    const { wss, url } = await fakeCdp((msg, ws) => {
      ws.send(JSON.stringify({ id: msg.id, result: { echo: msg.method, sessionId: msg.sessionId } }));
      if (msg.sessionId) ws.send(JSON.stringify({ sessionId: msg.sessionId, method: "Page.loadEventFired", params: { t: 1 } }));
    });
    servers.push(wss);
    const cdp = await CdpConnection.connect(url);

    expect(await cdp.send("Browser.getVersion")).toEqual({ echo: "Browser.getVersion" });

    const session = cdp.session("S1");
    const events: any[] = [];
    session.on("Page.loadEventFired", p => events.push(p));
    expect(await session.send("Page.enable")).toEqual({ echo: "Page.enable", sessionId: "S1" });
    await new Promise(r => setTimeout(r, 20));
    expect(events).toEqual([{ t: 1 }]);
  });

  it("rejects a command that gets no response within the timeout", async () => {
    const { wss, url } = await fakeCdp(() => { /* never answers */ });
    servers.push(wss);
    const cdp = await CdpConnection.connect(url, 50);
    await expect(cdp.send("Page.navigate")).rejects.toThrow("CDP timeout (Page.navigate)");
  });

  it("rejects pending and new commands once the connection is closed", async () => {
    const { wss, url } = await fakeCdp(() => { });
    servers.push(wss);
    const cdp = await CdpConnection.connect(url);
    let closed = false;
    cdp.onClose(() => { closed = true; });

    const pending = cdp.send("Page.navigate");
    for (const c of wss.clients) c.terminate();
    await expect(pending).rejects.toThrow("CDP closed");
    expect(closed).toBe(true);
    expect(cdp.isOpen).toBe(false);
    await expect(cdp.send("Page.enable")).rejects.toThrow("CDP closed");
  });

  it("survives malformed messages", async () => {
    const { wss, url } = await fakeCdp((msg, ws) => {
      ws.send("not json{");
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
    servers.push(wss);
    const cdp = await CdpConnection.connect(url);
    await expect(cdp.send("Page.enable")).resolves.toEqual({});
  });

  it("drops a session when its target detaches", async () => {
    const { wss, url } = await fakeCdp((msg, ws) => {
      ws.send(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } }));
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
    servers.push(wss);
    const cdp = await CdpConnection.connect(url);
    cdp.session("S1");
    cdp.session("S2");
    await cdp.send("Target.closeTarget");
    expect(cdp.sessionCount).toBe(1);
  });
});
