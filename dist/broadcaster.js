import { WebSocket } from "ws";
import { buildFrameStatsPacket, buildFramePackets, buildCurrentURLPacket } from "./protocol.js";
export class DeviceBroadcaster {
    constructor() {
        this._clients = new Map();
        this._state = new Map();
    }
    addClient(id, ws) {
        const old = this._clients.get(id);
        if (old && old.size) {
            for (const sock of old) {
                try {
                    sock.close();
                }
                catch { }
            }
            old.clear();
        }
        if (!this._clients.has(id))
            this._clients.set(id, new Set());
        this._clients.get(id).add(ws);
        if (!this._state.has(id))
            this._state.set(id, { queue: [], sending: false });
        console.log(`[broadcaster] Client connected to device ${id}, total clients: ${this._clients.get(id)?.size}`);
        ws.once("close", () => this.removeClient(id, ws));
        ws.once("error", () => this.removeClient(id, ws));
    }
    removeClient(id, ws) {
        this._clients.get(id)?.delete(ws);
        if ((this._clients.get(id)?.size ?? 0) === 0) {
            this._clients.delete(id);
            this._state.delete(id);
        }
        console.log(`[broadcaster] Client disconnected from device ${id}, total clients: ${this._clients.get(id)?.size ?? 0}`);
    }
    getClientCount(id) {
        return this._clients.get(id)?.size ?? 0;
    }
    sendFrameChunked(id, data, frameId, maxBytes = 12000) {
        const peers = this._clients.get(id);
        if (!peers || peers.size === 0 || data.rects.length === 0)
            return;
        const packets = buildFramePackets(data.rects, data.encoding, frameId, data.isFullFrame, maxBytes);
        const st = this._ensureState(id);
        st.queue.push({ frameId, packets });
        this._drainAsync(id).catch(() => { });
    }
    startSelfTestMeasurement(id) {
        const peers = this._clients.get(id);
        if (!peers || peers.size === 0)
            return;
        const packet = buildFrameStatsPacket();
        const st = this._ensureState(id);
        st.queue.push({ packets: [packet] });
        this._drainAsync(id).catch(() => { });
    }
    sendCurrentURL(id, url) {
        const peers = this._clients.get(id);
        if (!peers || peers.size === 0)
            return;
        const packet = buildCurrentURLPacket(url);
        const st = this._ensureState(id);
        st.queue.push({ packets: [packet] });
        this._drainAsync(id).catch(() => { });
    }
    _ensureState(id) {
        let st = this._state.get(id);
        if (!st) {
            st = { queue: [], sending: false };
            this._state.set(id, st);
        }
        return st;
    }
    async _drainAsync(id) {
        const st = this._ensureState(id);
        if (st.sending)
            return;
        st.sending = true;
        try {
            const peers = this._clients.get(id);
            if (!peers || peers.size === 0) {
                st.queue.length = 0;
                return;
            }
            while (st.queue.length) {
                const f = st.queue.shift();
                for (const pkt of f.packets) {
                    for (const ws of new Set(peers)) {
                        if (ws.readyState !== WebSocket.OPEN) {
                            peers.delete(ws);
                            continue;
                        }
                        try {
                            ws.send(pkt, { binary: true });
                        }
                        catch {
                            // drop on send error
                            try {
                                ws.close();
                            }
                            catch { }
                            peers.delete(ws);
                        }
                    }
                    if (peers.size === 0) {
                        st.queue.length = 0;
                        return;
                    }
                    await Promise.resolve();
                }
            }
        }
        finally {
            st.sending = false;
        }
    }
}
