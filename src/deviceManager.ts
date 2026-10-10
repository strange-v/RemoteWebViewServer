import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual, readInjectScriptConfig } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { hash32 } from "./util.js";
import { SelfTestRunner } from "./selfTest.js";
import { getInjectScriptFromUrl } from "./scriptLoader.js";

export type DeviceSession = {
  id: string;
  deviceId: string;
  cdp: CDPSession;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  prevFrameHash: number;
  processor: FrameProcessor;
  selfTestRunner: SelfTestRunner

  // trailing throttle state
  pendingB64?: string;
  throttleTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;

  // last screencast frame, kept to re-send a full frame on request
  lastB64?: string;
  resendFullFrame: () => void;
};

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();

const _pending = new Map<string, Promise<DeviceSession>>();

// Calls for the same id run one after another, so concurrent connections
// can't both see "no device" and each create a browser tab.
export function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const prev = _pending.get(id);
  const next = (prev ?? Promise.resolve())
    .catch(() => { })
    .then(() => _ensureDeviceAsync(id, cfg));
  _pending.set(id, next);
  next.finally(() => {
    if (_pending.get(id) === next) _pending.delete(id);
  }).catch(() => { });
  return next;
}

async function _ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      device.resendFullFrame();
      return device;
    } else {
      console.log(`[device] Reconfiguring device ${id}`);
      await deleteDeviceAsync(device);
    }
  }

  const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    width: cfg.width,
    height: cfg.height,
  });

  let session: any;
  try {
    const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true
    });
    session = (root as any).session(sessionId);

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
  } catch (e) {
    // Don't leave a half-configured tab behind.
    try { await root.send('Target.closeTarget', { targetId }); } catch { }
    throw e;
  }

  const processor = new FrameProcessor({
    tileSize: cfg.tileSize,
    fullframeTileCount: cfg.fullFrameTileCount,
    fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
    jpegQuality: cfg.jpegQuality,
    fullFrameEvery: cfg.fullFrameEvery,
    maxBytesPerMessage: cfg.maxBytesPerMessage,
  });

  const newDevice: DeviceSession = {
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
    lastB64: undefined,
    resendFullFrame: () => { },
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

  const flushPending = async () => {
    const dev = newDevice;
    dev.throttleTimer = undefined;

    const b64 = dev.pendingB64;
    dev.pendingB64 = undefined;
    if (!b64) return;

    try {
      const pngFull = Buffer.from(b64, 'base64');

      const h32 = hash32(pngFull);
      if (dev.prevFrameHash === h32) {
        dev.lastProcessedMs = Date.now();
        return;
      }
      dev.prevFrameHash = h32;

      let img = sharp(pngFull);
      if (dev.cfg.rotation) img = img.rotate(dev.cfg.rotation);

      const { data, info } = await img
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const out = await processor.processFrameAsync({ data, width: info.width, height: info.height });
      if (out.rects.length > 0) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
      }
    } catch (e) {
      console.warn(`[device] Failed to process frame for ${id}: ${(e as Error).message}`);
    } finally {
      dev.lastProcessedMs = Date.now();
    }
  };

  const scheduleFlush = () => {
    if (newDevice.throttleTimer) return;
    const now = Date.now();
    const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
    const delay = Math.max(0, cfg.minFrameInterval - (Number.isFinite(since) ? since : 0));
    newDevice.throttleTimer = setTimeout(flushPending, delay);
  };

  // Screencast only emits frames when the page changes, so a full-frame request on a
  // static page has to re-process the last frame we received.
  newDevice.resendFullFrame = () => {
    newDevice.processor.requestFullFrame();
    newDevice.prevFrameHash = 0;
    if (!newDevice.pendingB64 && newDevice.lastB64)
      newDevice.pendingB64 = newDevice.lastB64;
    if (newDevice.pendingB64)
      scheduleFlush();
  };

  session.on('Page.screencastFrame', async (evt: any) => {
    // ACK immediately to keep producer running
    session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });

    newDevice.lastB64 = evt.data;
    if (broadcaster.getClientCount(newDevice.deviceId) === 0)
      return;
    newDevice.lastActive = Date.now();
    newDevice.pendingB64 = evt.data;
    scheduleFlush();
  });

  const handleNavigation = (url: string) => {
    if (newDevice.url !== url) {
      newDevice.url = url;
      broadcaster.sendCurrentURL(newDevice.deviceId, url);
      console.log(`[device] URL changed to: ${url}`);
    }
  };

  session.on('Page.frameNavigated', (evt: any) => {
    // Only track the main frame, ignore iframes
    if (!evt.frame.parentId) {
      handleNavigation(evt.frame.url);
    }
  });
  session.on('Page.navigatedWithinDocument', (evt: any) => {
    handleNavigation(evt.url);
  });
  
  return newDevice;
}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  if (_cleanupRunning) return;
  _cleanupRunning = true;

  try {
    const now = Date.now();
    const staleIds = Array.from(devices.values())
      .filter(d => now - d.lastActive > ttlMs)
      .map(d => d.deviceId);

    for (const id of staleIds) {
      const dev = devices.get(id);
      if (!dev) continue;

      console.log(`[device] Cleaning up idle device ${id}`);
      await deleteDeviceAsync(dev).catch(() => { /* swallow */ });
    }
  } finally {
    _cleanupRunning = false;
  }
}

async function deleteDeviceAsync(device: DeviceSession) {
  const root = getRoot();

  if (!devices.delete(device.deviceId))
    return;

  if (device.throttleTimer)
    clearTimeout(device.throttleTimer);

  try { await device.cdp.send("Page.stopScreencast").catch(() => { }); } catch { }
  try { await root?.send("Target.closeTarget", { targetId: device.id }); } catch { }
}
