import WebSocket from 'ws';

type CdpMsg = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
  sessionId?: string;
};
type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

class CdpConnection {
  private ws: WebSocket;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, CdpSession>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => this._onMessage(data));
  }

  static async connect(wsUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    return new CdpConnection(ws);
  }

  send<T = any>(method: string, params?: any): Promise<T> {
    const id = this.seq++;
    const payload = JSON.stringify({ id, method, params });
    this.ws.send(payload);
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  session(sessionId: string): CdpSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new CdpSession(this, sessionId);
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private _onMessage(data: WebSocket.RawData) {
    const msg = JSON.parse(String(data)) as CdpMsg;
    // Route session-scoped events
    if (msg.sessionId && msg.method) {
      const s = this.sessions.get(msg.sessionId);
      s?.emit(msg.method, msg.params);
      return;
    }
    // Resolve command responses
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result);
    }
  }
}

type Handler = (p: any) => void;
export class CdpSession {
  constructor(private root: CdpConnection, public sessionId: string) { }
  private handlers = new Map<string, Set<Handler>>();

  send<T = any>(method: string, params?: any): Promise<T> {
    const id = (this.root as any).seq++;
    const payload = JSON.stringify({ id, method, params, sessionId: this.sessionId });
    (this.root as any).ws.send(payload);
    return new Promise<T>((resolve, reject) => (this.root as any).pending.set(id, { resolve, reject }));
  }
  on(method: string, cb: Handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(cb);
  }
  emit(method: string, params: any) {
    this.handlers.get(method)?.forEach(fn => fn(params));
  }
}

let root: CdpConnection | null = null;
let sharedContextId = '';
let readyPromise: Promise<void> | null = null;

export async function initCdpRootAsync(wsUrl: string): Promise<void> {
  if (readyPromise) return readyPromise;
  
  readyPromise = (async () => {
    root = await CdpConnection.connect(wsUrl);

    try {
      const info = await root.send<any>('SystemInfo.getInfo');
      console.log('[cdp] GPU vendor/renderer:', info?.gpu?.auxAttributes);
    } catch { /* ignore */ }
  })();
  
  return readyPromise;
}

export function waitForCdpReadyAsync(): Promise<void> {
  if (readyPromise) return readyPromise;
  return Promise.reject(new Error('CDP not initialized'));
}

export function getRoot() { return root; }
export function getSharedContextId() { return sharedContextId; }
