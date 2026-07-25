import WebSocket from 'ws';
class CdpConnection {
    constructor(ws) {
        this.seq = 1;
        this.pending = new Map();
        this.sessions = new Map();
        this.ws = ws;
        ws.on('close', () => {
            for (const [, p] of this.pending)
                p.reject(new Error('CDP closed'));
            this.pending.clear();
        });
        ws.on('error', (err) => {
            for (const [, p] of this.pending)
                p.reject(err);
            this.pending.clear();
        });
        ws.on('message', (data) => this._onMessage(data));
    }
    static async connect(wsUrl) {
        const ws = new WebSocket(wsUrl);
        await new Promise((res, rej) => {
            ws.once('open', () => res());
            ws.once('error', rej);
        });
        return new CdpConnection(ws);
    }
    send(method, params) {
        const id = this.seq++;
        const payload = JSON.stringify({ id, method, params });
        this.ws.send(payload);
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
    session(sessionId) {
        let s = this.sessions.get(sessionId);
        if (!s) {
            s = new CdpSession(this, sessionId);
            this.sessions.set(sessionId, s);
        }
        return s;
    }
    _onMessage(data) {
        const msg = JSON.parse(String(data));
        // Route session-scoped events
        if (msg.sessionId && msg.method) {
            const s = this.sessions.get(msg.sessionId);
            s?.emit(msg.method, msg.params);
            return;
        }
        // Resolve command responses
        if (msg.id) {
            const p = this.pending.get(msg.id);
            if (!p)
                return;
            this.pending.delete(msg.id);
            if (msg.error)
                p.reject(new Error(msg.error.message || 'CDP error'));
            else
                p.resolve(msg.result);
        }
    }
}
export class CdpSession {
    constructor(root, sessionId) {
        this.root = root;
        this.sessionId = sessionId;
        this.handlers = new Map();
    }
    send(method, params) {
        const id = this.root.seq++;
        const payload = JSON.stringify({ id, method, params, sessionId: this.sessionId });
        this.root.ws.send(payload);
        return new Promise((resolve, reject) => this.root.pending.set(id, { resolve, reject }));
    }
    on(method, cb) {
        if (!this.handlers.has(method))
            this.handlers.set(method, new Set());
        this.handlers.get(method).add(cb);
    }
    emit(method, params) {
        this.handlers.get(method)?.forEach(fn => fn(params));
    }
}
let root = null;
let sharedContextId = '';
let readyPromise = null;
export async function initCdpRootAsync(wsUrl) {
    if (readyPromise)
        return readyPromise;
    readyPromise = (async () => {
        root = await CdpConnection.connect(wsUrl);
        try {
            const info = await root.send('SystemInfo.getInfo');
            console.log('[cdp] GPU vendor/renderer:', info?.gpu?.auxAttributes);
        }
        catch { /* ignore */ }
    })();
    return readyPromise;
}
export function waitForCdpReadyAsync() {
    if (readyPromise)
        return readyPromise;
    return Promise.reject(new Error('CDP not initialized'));
}
export function getRoot() { return root; }
export function getSharedContextId() { return sharedContextId; }
