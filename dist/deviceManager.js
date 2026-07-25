import sharp from "sharp";
import { deviceConfigsEqual, readInjectScriptConfig } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { hash32 } from "./util.js";
import { SelfTestRunner } from "./selfTest.js";
import { getInjectScriptFromUrl } from "./scriptLoader.js";
const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');
const devices = new Map();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();
export async function ensureDeviceAsync(id, cfg) {
    const root = getRoot();
    if (!root)
        throw new Error("CDP not ready");
    let device = devices.get(id);
    if (device) {
        if (deviceConfigsEqual(device.cfg, cfg)) {
            device.lastActive = Date.now();
            device.processor.requestFullFrame();
            return device;
        }
        else {
            console.log(`[device] Reconfiguring device ${id}`);
            await deleteDeviceAsync(device);
        }
    }
    const { targetId } = await root.send('Target.createTarget', {
        url: 'about:blank',
        width: cfg.width,
        height: cfg.height,
    });
    const { sessionId } = await root.send('Target.attachToTarget', {
        targetId,
        flatten: true
    });
    const session = root.session(sessionId);
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', {
        width: cfg.width,
        height: cfg.height,
        deviceScaleFactor: 1,
        mobile: true
    });
    if (PREFERS_REDUCED_MOTION) {
        await session.send('Emulation.setEmulatedMedia', {
            media: 'screen',
            features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
        });
    }
    const keyboardScript = await getInjectScriptFromUrl(readInjectScriptConfig());
    if (keyboardScript) {
        await session.send('Page.addScriptToEvaluateOnNewDocument', { source: keyboardScript });
    }
    await session.send('Page.startScreencast', {
        format: 'png',
        maxWidth: cfg.width,
        maxHeight: cfg.height,
        everyNthFrame: cfg.everyNthFrame
    });
    const processor = new FrameProcessor({
        tileSize: cfg.tileSize,
        fullframeTileCount: cfg.fullFrameTileCount,
        fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
        jpegQuality: cfg.jpegQuality,
        fullFrameEvery: cfg.fullFrameEvery,
        maxBytesPerMessage: cfg.maxBytesPerMessage,
    });
    const newDevice = {
        id: targetId,
        deviceId: id,
        cdp: session,
        cfg: cfg,
        url: '',
        lastActive: Date.now(),
        frameId: 0,
        prevFrameHash: 0,
        processor,
        selfTestRunner: new SelfTestRunner(broadcaster),
        pendingB64: undefined,
        throttleTimer: undefined,
        lastProcessedMs: undefined,
    };
    devices.set(id, newDevice);
    newDevice.processor.requestFullFrame();
    const flushPending = async () => {
        const dev = newDevice;
        dev.throttleTimer = undefined;
        const b64 = dev.pendingB64;
        dev.pendingB64 = undefined;
        if (!b64)
            return;
        try {
            const pngFull = Buffer.from(b64, 'base64');
            const h32 = hash32(pngFull);
            if (dev.prevFrameHash === h32) {
                dev.lastProcessedMs = Date.now();
                return;
            }
            dev.prevFrameHash = h32;
            let img = sharp(pngFull);
            if (dev.cfg.rotation)
                img = img.rotate(dev.cfg.rotation);
            const { data, info } = await img
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
            const out = await processor.processFrameAsync({ data, width: info.width, height: info.height });
            if (out.rects.length > 0) {
                dev.frameId = (dev.frameId + 1) >>> 0;
                broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
            }
        }
        catch (e) {
            console.warn(`[device] Failed to process frame for ${id}: ${e.message}`);
        }
        finally {
            dev.lastProcessedMs = Date.now();
        }
    };
    session.on('Page.screencastFrame', async (evt) => {
        // ACK immediately to keep producer running
        session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });
        if (broadcaster.getClientCount(newDevice.deviceId) === 0)
            return;
        newDevice.lastActive = Date.now();
        newDevice.pendingB64 = evt.data;
        const now = Date.now();
        const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
        if (!newDevice.throttleTimer) {
            const delay = Math.max(0, cfg.minFrameInterval - (Number.isFinite(since) ? since : 0));
            newDevice.throttleTimer = setTimeout(flushPending, delay);
        }
    });
    const handleNavigation = (url) => {
        if (newDevice.url !== url) {
            newDevice.url = url;
            broadcaster.sendCurrentURL(newDevice.deviceId, url);
            console.log(`[device] URL changed to: ${url}`);
        }
    };
    session.on('Page.frameNavigated', (evt) => {
        // Only track the main frame, ignore iframes
        if (!evt.frame.parentId) {
            handleNavigation(evt.frame.url);
        }
    });
    session.on('Page.navigatedWithinDocument', (evt) => {
        handleNavigation(evt.url);
    });
    return newDevice;
}
export async function cleanupIdleAsync(ttlMs = 5 * 60000) {
    if (_cleanupRunning)
        return;
    _cleanupRunning = true;
    try {
        const now = Date.now();
        const staleIds = Array.from(devices.values())
            .filter(d => now - d.lastActive > ttlMs)
            .map(d => d.deviceId);
        for (const id of staleIds) {
            const dev = devices.get(id);
            if (!dev)
                continue;
            console.log(`[device] Cleaning up idle device ${id}`);
            await deleteDeviceAsync(dev).catch(() => { });
        }
    }
    finally {
        _cleanupRunning = false;
    }
}
async function deleteDeviceAsync(device) {
    const root = getRoot();
    if (!devices.delete(device.deviceId))
        return;
    if (device.throttleTimer)
        clearTimeout(device.throttleTimer);
    try {
        await device.cdp.send("Page.stopScreencast").catch(() => { });
    }
    catch { }
    try {
        await root?.send("Target.closeTarget", { targetId: device.id });
    }
    catch { }
}
