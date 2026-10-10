import WebSocket from 'ws';

type CdpMsg = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
  sessionId?: string;
};
type Pending = { method: string; resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout };

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

export class CdpConnection {
  private ws: WebSocket;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, CdpSession>();
  private closeHandlers: (() => void)[] = [];

  constructor(ws: WebSocket, private commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    this.ws = ws;
    ws.on('close', () => {
      this._rejectAll(new Error('CDP closed'));
      for (const cb of this.closeHandlers) cb();
    });
    ws.on('error', (err) => this._rejectAll(err));
    ws.on('message', (data) => this._onMessage(data));
  }

  static async connect(wsUrl: string, commandTimeoutMs?: number): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    return new CdpConnection(ws, commandTimeoutMs);
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }

  send<T = any>(method: string, params?: any): Promise<T> {
    return this.sendRaw<T>(method, params);
  }

  // Rejects right away when the connection is closed and after commandTimeoutMs
  // without a response, so a dead browser can't leave callers waiting forever.
  sendRaw<T = any>(method: string, params?: any, sessionId?: string): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error(`CDP closed (${method})`));

    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout (${method})`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  session(sessionId: string): CdpSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new CdpSession(this, sessionId);
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  private _rejectAll(err: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private _onMessage(data: WebSocket.RawData) {
    let msg: CdpMsg;
    try {
      msg = JSON.parse(String(data)) as CdpMsg;
    } catch {
      console.warn('[cdp] Ignoring malformed message');
      return;
    }
    // Route session-scoped events
    if (msg.sessionId && msg.method) {
      const s = this.sessions.get(msg.sessionId);
      s?.emit(msg.method, msg.params);
      return;
    }
    // A closed or crashed target detaches its session; drop it with its handlers.
    if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) {
      this.removeSession(msg.params.sessionId);
      return;
    }
    // Resolve command responses
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
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
    return this.root.sendRaw<T>(method, params, this.sessionId);
  }
  on(method: string, cb: Handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(cb);
  }
  emit(method: string, params: any) {
    this.handlers.get(method)?.forEach(fn => {
      try { fn(params); } catch (e) { console.warn(`[cdp] Handler for ${method} failed: ${(e as Error).message}`); }
    });
  }
}

let root: CdpConnection | null = null;
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
