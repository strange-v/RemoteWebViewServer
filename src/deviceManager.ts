import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { installAntiAnimCSSAsync } from "./antiAnim.js";
import { hash32 } from "./util.js";
import { FpsTestRunner } from "./fpsTest.js";

export type DeviceSession = {
  id: string;
  cdp: CDPSession;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  prevFrameHash: number;
  processor: FrameProcessor;
  fpsTestRunner?: FpsTestRunner

  // trailing throttle state
  pendingB64?: string;
  throttleTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
};

const devices = new Map<string, DeviceSession>();
export const broadcaster = new DeviceBroadcaster();

export async function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      device.processor.requestFullFrame();
      // if (device.url === "fps-test")
      //   await device.fpsTestRunner?.startAsync(id, device.cdp, broadcaster);
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

  const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  });
  const session = (root as any).session(sessionId);

  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: cfg.width,
    height: cfg.height,
    deviceScaleFactor: 1,
    mobile: true
  });
  await installAntiAnimCSSAsync(session);

  // let fpsTestRunner: FpsTestRunner | undefined;
  // if (cfg.url === "fps-test") {
  //   fpsTestRunner = new FpsTestRunner();
  //   await fpsTestRunner.startAsync(id, session, broadcaster);
  // } else {
  //   await session.send('Page.navigate', { url: cfg.url });
  // }

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
  });

  const newDevice: DeviceSession = {
    id: targetId,
    cdp: session,
    cfg: cfg,
    url: '',
    lastActive: Date.now(),
    frameId: 0,
    prevFrameHash: 0,
    processor,
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
    if (!b64) return;

    try {
      const pngFull = Buffer.from(b64, 'base64');

      const h32 = hash32(pngFull);
      if (dev.prevFrameHash === h32) {
        dev.lastProcessedMs = Date.now();
        return;
      }
      dev.prevFrameHash = h32;

      const { data, info } = await sharp(pngFull).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
      const out = await processor.processFrameAsync({ data, width: info.width, height: info.height });
      if (out.rects.length > 0) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        await broadcaster.sendFrameChunkedAsync(id, out, dev.frameId, cfg.maxBytesPerMessage);
      }
    } catch (e) {
      console.warn(`[device] Failed to process frame for ${id}: ${(e as Error).message}`);
    } finally {
      dev.lastProcessedMs = Date.now();
    }
  };

  session.on('Page.screencastFrame', async (evt: any) => {
    // ACK immediately to keep producer running
    session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });
    newDevice.lastActive = Date.now();
    newDevice.pendingB64 = evt.data;

    const now = Date.now();
    const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
    if (!newDevice.throttleTimer) {
      const delay = Math.max(0, cfg.minFrameInterval - (Number.isFinite(since) ? since : 0));
      newDevice.throttleTimer = setTimeout(flushPending, delay);
    }
  });

  return newDevice;
}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  const root = getRoot();
  const now = Date.now();
  for (const [id, device] of devices) {
    if (now - device.lastActive > ttlMs) {
      console.log(`[device] Cleaning up idle device ${id}`);
      await deleteDeviceAsync(device);
    }
  }
}

async function deleteDeviceAsync(device: DeviceSession) {
  const root = getRoot();

  try { await root?.send('Target.closeTarget', { targetId: device.id }); } catch { }

  if (device.throttleTimer)
    clearTimeout(device.throttleTimer);

  devices.delete(device.id);
}