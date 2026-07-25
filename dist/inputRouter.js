import { TouchKind, parseFrameStatsPacket, parseOpenURLPacket, parseTouchPacket } from "./protocol.js";
import { mapPointForRotation } from "./util.js";
export class InputRouter {
    constructor(moveThrottleMs = 12) {
        this._lastMoveAt = 0;
        this._moveThrottleMs = moveThrottleMs;
    }
    async handleTouchPacketAsync(dev, buf) {
        const pkt = parseTouchPacket(buf);
        if (!pkt)
            return;
        if (pkt.kind === TouchKind.Move) {
            const now = Date.now();
            if (now - this._lastMoveAt < this._moveThrottleMs)
                return;
            this._lastMoveAt = now;
        }
        await this._dispatchTouchAsync(dev, pkt.kind, pkt.x, pkt.y);
    }
    async handleFrameStatsPacketAsync(dev, buf) {
        const value = parseFrameStatsPacket(buf);
        dev.selfTestRunner?.setFrameRenderTimeAsync(value ?? 0, dev.cdp);
    }
    async handleOpenURLPacketAsync(dev, buf) {
        const pkt = parseOpenURLPacket(buf);
        if (!pkt)
            return;
        if (pkt.url === "self-test") {
            await dev.selfTestRunner.startAsync(dev.deviceId, dev.cdp);
        }
        else {
            dev.selfTestRunner.stop();
            if (dev.url !== pkt.url)
                await dev.cdp.send('Page.navigate', { url: pkt.url });
        }
    }
    async _dispatchTouchAsync(dev, kind, x, y) {
        try {
            const id = 1; // single-finger id
            const rotated = mapPointForRotation(x, y, dev.cfg.width, dev.cfg.height, dev.cfg.rotation);
            const points = [{ x: rotated.x, y: rotated.y, radiusX: 1, radiusY: 1, force: 1, id }];
            switch (kind) {
                case TouchKind.Down:
                    await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
                    break;
                case TouchKind.Move:
                    await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
                    break;
                case TouchKind.Up:
                    await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                    break;
                case TouchKind.Tap:
                    await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
                    await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                    break;
            }
        }
        catch (e) {
            console.warn(`Failed to dispatch touch event: ${e.message}`);
        }
    }
}
