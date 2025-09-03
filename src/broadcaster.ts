import type { WebSocket } from "ws";
import { buildFramPacket, Encoding, Rect, FLAG_LAST_OF_FRAME, FLAG_IS_FULL_FRAME } from "./protocol.js";
import { FrameOut } from "./frameProcessor.js";

type OutFrame = { frameId: number; packets: Buffer[] };

export class DeviceBroadcaster {
  private _clients = new Map<string, Set<WebSocket>>();
  private _state = new Map<string, { queue: OutFrame[]; sending: boolean }>();

  addClient(id: string, ws: WebSocket): void {
    if (!this._clients.has(id)) this._clients.set(id, new Set());
    this._clients.get(id)!.add(ws);
    if (!this._state.has(id)) this._state.set(id, { queue: [], sending: false });
  }

  removeClient(id: string, ws: WebSocket): void {
    this._clients.get(id)?.delete(ws);
    if (this._clients.get(id)?.size === 0) {
      this._clients.delete(id);
      this._state.delete(id);
    }
  }

  public sendFrameChunkedAsync(id: string, enc: Encoding, data: FrameOut, frameId: number, maxBytes = 12_000): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0 || data.rects.length === 0) return;

    const packets = this._buildPackets(enc, data.rects, frameId, data.isFullFrame, maxBytes);
    const st = this._ensureState(id);

    // Coalesce only whole frames not yet sending
    if (!st.sending && st.queue.length > 0) {
      st.queue[st.queue.length - 1] = { frameId, packets };
    } else {
      st.queue.push({ frameId, packets });
      // Optional: cap queue length
      if (st.queue.length > 3) st.queue.splice(0, st.queue.length - 3);
    }

    void this._drainAsync(id);
  }

  public getPeers(id: string): Set<WebSocket> {
    return this._clients.get(id) ?? new Set();
  }

  private _ensureState(id: string) {
    let st = this._state.get(id);
    if (!st) {
      st = { queue: [], sending: false };
      this._state.set(id, st);
    }
    return st;
  }

  private _buildPackets(enc: Encoding, tiles: Rect[], frameId: number, isFullFrame: boolean, maxBytes: number): Buffer[] {
    const headerBytes = 4 + 1 + 4 + 1 + 2 + 2;
    const rectOverhead = 2 + 2 + 2 + 2 + 4;

    const chunks: Rect[][] = [];
    let cur: Rect[] = [];
    let curBytes = headerBytes;

    for (const r of tiles) {
      const rBytes = rectOverhead + r.data.length;
      if (cur.length && curBytes + rBytes > maxBytes) {
        chunks.push(cur);
        cur = [];
        curBytes = headerBytes;
      }
      cur.push(r);
      curBytes += rBytes;
    }
    if (cur.length) chunks.push(cur);

    const packets: Buffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      let flags = (i === chunks.length - 1) ? FLAG_LAST_OF_FRAME : 0;
      if (isFullFrame)
        flags |= FLAG_IS_FULL_FRAME;
      
      packets.push(buildFramPacket(chunks[i], frameId, enc, flags));
    }
    return packets;
  }

  private async _drainAsync(id: string): Promise<void> {
    const st = this._ensureState(id);
    if (st.sending) return;
    st.sending = true;

    try {
      const peers = this._clients.get(id);
      if (!peers || peers.size === 0) { st.queue.length = 0; return; }

      while (st.queue.length) {
        const f = st.queue.shift()!;
        // Send all packets of this frame in order, no interleaving
        for (const pkt of f.packets) {
          // Best-effort cleanup of closed sockets
          for (const ws of new Set(peers)) {
            if (ws.readyState !== ws.OPEN) { peers.delete(ws); continue; }
            try { ws.send(pkt, { binary: true }); } catch { /* ignore */ }
          }
          if (peers.size === 0) { st.queue.length = 0; return; }
          // Small yield to avoid blocking event loop under heavy load
          await Promise.resolve();
        }
      }
    } finally {
      st.sending = false;
    }
  }
}
