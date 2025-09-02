import type { DeviceSession } from "./deviceManager.js";
import { TouchKind, parseTouchPacket } from "./protocol.js";

export class InputRouter {
  private _lastMoveAt = 0;
  private readonly _moveThrottleMs: number;

  constructor(moveThrottleMs = 12) {
    this._moveThrottleMs = moveThrottleMs;
  }

  public async handleTouchPacketAsync(dev: DeviceSession, buf: Buffer): Promise<void> {
    const pkt = parseTouchPacket(buf);
    if (!pkt) return;

    if (pkt.kind === TouchKind.Move) {
      const now = Date.now();
      if (now - this._lastMoveAt < this._moveThrottleMs) return;
      this._lastMoveAt = now;
    }

    await this._dispatchMouseAsync(dev, pkt.kind, pkt.x, pkt.y);
  }

  private async _dispatchMouseAsync(dev: DeviceSession, kind: TouchKind, x: number, y: number): Promise<void> {
    try {
      switch (kind) {
        case TouchKind.Down:
          await dev.cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x, y, button: "left", buttons: 1, clickCount: 1,
          });
          break;

        case TouchKind.Move:
          await dev.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x, y, button: "left", buttons: 1, clickCount: 1,
          });
          break;

        case TouchKind.Up:
          await dev.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x, y, button: "left", buttons: 0, clickCount: 1,
          });
          break;

        case TouchKind.Tap:
          // Simple press+release; works reliably on HA UI
          await dev.cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x, y, button: "left", buttons: 1, clickCount: 1,
          });
          await dev.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x, y, button: "left", buttons: 0, clickCount: 1,
          });
          break;
      }
    } catch {
      // Swallow input errors to avoid breaking the stream
    }
  }
}
