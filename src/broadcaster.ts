import type { WebSocket } from "ws";
import { buildFpsTestPacket, buildFramPackets } from "./protocol.js";
import { FrameOut } from "./frameProcessor.js";

type OutFrame = { frameId: number; packets: Buffer[] };

type BroadcasterState = {
  queue: OutFrame[];
  sending: boolean;
};

export class DeviceBroadcaster {
  private _clients = new Map<string, Set<WebSocket>>();
  private _state = new Map<string, BroadcasterState>();

  addClient(id: string, ws: WebSocket): void {
    if (!this._clients.has(id)) this._clients.set(id, new Set());
    this._clients.get(id)!.add(ws);
    if (!this._state.has(id)) this._state.set(id, { queue: [], sending: false });
  }

  removeClient(id: string, ws: WebSocket): void {
    this._clients.get(id)?.delete(ws);
    if ((this._clients.get(id)?.size ?? 0) === 0) {
      this._clients.delete(id);
      this._state.delete(id);
    }
  }

  public sendFrameChunkedAsync(
    id: string,
    data: FrameOut,
    frameId: number,
    maxBytes = 12_000
  ): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0 || data.rects.length === 0) return;

    const packets = buildFramPackets(
      data.rects,
      data.encoding,
      frameId,
      data.isFullFrame,
      maxBytes
    );

    const st = this._ensureState(id);
    st.queue.push({ frameId, packets });
    this._drainAsync(id);
  }

  public startFpsMeasurement(id: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    const packet = buildFpsTestPacket();
    const st = this._ensureState(id);
    st.queue.push({ frameId: 0, packets: [packet] });

    this._drainAsync(id);
  }

  public getPeers(id: string): Set<WebSocket> {
    return this._clients.get(id) ?? new Set();
  }

  private _ensureState(id: string): BroadcasterState {
    let st = this._state.get(id);
    if (!st) {
      st = { queue: [], sending: false };
      this._state.set(id, st);
    }
    return st;
  }

  private async _drainAsync(id: string): Promise<void> {
    const st = this._ensureState(id);
    if (st.sending) return;
    st.sending = true;

    try {
      const peers = this._clients.get(id);
      if (!peers || peers.size === 0) {
        st.queue.length = 0;
        return;
      }

      while (st.queue.length) {
        const f = st.queue.shift()!;

        for (const pkt of f.packets) {
          for (const ws of new Set(peers)) {
            if (ws.readyState !== ws.OPEN) {
              peers.delete(ws);
              continue;
            }
            try {
              ws.send(pkt, { binary: true });
            } catch {
              // ignore per-socket send errors
            }
          }
          if (peers.size === 0) {
            st.queue.length = 0;
            return;
          }
          await Promise.resolve();
        }
      }
    } finally {
      st.sending = false;
    }
  }
}
