// Frames sent to a client that acknowledges them (FrameAck) but hasn't acknowledged yet.
//
// Without acks the server only sees data still queued in its own socket; data already in
// the OS send buffer and the device's TCP window is invisible, so during a stream of large
// frames hundreds of KB of stale frames can pile up and the screen lags behind. With acks
// the server keeps at most `size` frames in flight and the device sets the pace.
//
// Acks are cumulative ("everything up to frame N is done"), so one ack also covers frames
// whose last packet the device dropped. Frame ids are u32 and wrap around.
// Frames remembered for a client that hasn't acked yet: enough to cover the backlog sent
// before its first ack, without growing forever for clients that never ack.
const MAX_TRACKED_BEFORE_FIRST_ACK = 64;

export class FrameAckWindow {
  private _inFlight: { frameId: number; sentAtMs: number }[] = [];
  private _supported = false;

  constructor(private readonly _size = 2, private readonly _timeoutMs = 1000) { }

  // True once the client has sent an ack on this connection.
  get supported(): boolean { return this._supported; }
  get inFlight(): number { return this._inFlight.length; }

  // A new connection: the client may not send acks at all.
  reset(): void {
    this._inFlight = [];
    this._supported = false;
  }

  // Tracked from the start of the connection, so frames sent before the first ack still count
  // once it arrives; the limit applies only to clients that ack.
  sent(frameId: number, nowMs: number): void {
    this._inFlight.push({ frameId, sentAtMs: nowMs });
    if (!this._supported && this._inFlight.length > MAX_TRACKED_BEFORE_FIRST_ACK) this._inFlight.shift();
  }

  // Returns true when the ack freed room in the window.
  ack(frameId: number): boolean {
    this._supported = true;
    const before = this._inFlight.length;
    this._inFlight = this._inFlight.filter(f => !isAtOrBefore(f.frameId, frameId));
    return this._inFlight.length < before;
  }

  // Whether to hold back the next frame. A frame unacknowledged for longer than the timeout
  // counts as lost (e.g. an ack lost on reconnect), so a missing ack can't stall the stream.
  isFull(nowMs: number): boolean {
    if (!this._supported || this._inFlight.length < this._size) return false;
    if (nowMs - this._inFlight[0].sentAtMs > this._timeoutMs) {
      this._inFlight = [];
      return false;
    }
    return true;
  }

  // When the oldest in-flight frame times out, if the window is full.
  timeoutAtMs(): number | undefined {
    return this._supported && this._inFlight.length ? this._inFlight[0].sentAtMs + this._timeoutMs : undefined;
  }
}

// a <= b for u32 ids that may wrap around
function isAtOrBefore(a: number, b: number): boolean {
  return ((b - a) >>> 0) < 0x8000_0000;
}
