import { CDPSession } from "playwright-core";
import sharp from "sharp";
import env from "env-var";
import { resolveDevice, loadDeviceMap } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { installAntiAnimCSSAsync } from "./antiAnim.js";
import { hash32 } from "./util.js";
import { FpsTestRunner } from "./fpsTest.js";

export type DeviceSession = {
  id: string;
  cdp: CDPSession;
  w: number;
  h: number;
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
const devicesConfigMap = loadDeviceMap();
export const broadcaster = new DeviceBroadcaster();

export async function ensureDeviceAsync(id: string): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    device.lastActive = Date.now();
    device.processor.requestFullFrame();
    if (device.url === "fps-test")
      await device.fpsTestRunner?.startAsync(id, device.cdp, broadcaster);
    return device;
  }

  const cfg = resolveDevice(devicesConfigMap, id);
  if (!cfg) throw new Error(`Unknown device id: ${id}`);

  const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    width: cfg.w,
    height: cfg.h
  });

  const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  });
  const session = (root as any).session(sessionId);

  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: true
  });
  await installAntiAnimCSSAsync(session);

  let fpsTestRunner: FpsTestRunner | undefined;
  if (cfg.url === "fps-test") {
    fpsTestRunner = new FpsTestRunner();
    await fpsTestRunner.startAsync(id, session, broadcaster);
  } else {
    await session.send('Page.navigate', { url: cfg.url });
  }

  await session.send('Page.startScreencast', {
    format: 'png',
    maxWidth: cfg.w,
    maxHeight: cfg.h,
    everyNthFrame: env.get("EVERY_NTH_FRAME").default("1").asIntPositive()
  });

  const processor = new FrameProcessor({
    tileSize: env.get("TILE_SIZE").default("32").asIntPositive(),
    fullframeTileCount: env.get("FULLFRAME_TILE_COUNT").default("4").asIntPositive(),
    fullframeAreaThreshold: env.get("FULLFRAME_AREA_THRESHOLD").default("0.5").asFloatPositive(),
    jpegQuality: env.get("JPEG_QUALITY").default("85").asIntPositive(),
    fullEvery: env.get("FULLFRAME_EVERY").default("50").asIntPositive(),
  });

  const newDevice: DeviceSession = {
    id: targetId,
    cdp: session,
    w: cfg.w,
    h: cfg.h,
    url: cfg.url,
    lastActive: Date.now(),
    frameId: 0,
    prevFrameHash: 0,
    processor,
    fpsTestRunner,
    pendingB64: undefined,
    throttleTimer: undefined,
    lastProcessedMs: undefined,
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

  const maxBytesPerWsMsg = env.get("MAX_BYTES_PER_WS_MSG").default("12288").asIntPositive();
  const minFrameInterval = env.get("MIN_FRAME_INTERVAL_MS").default("100").asIntPositive();

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
        await broadcaster.sendFrameChunkedAsync(id, out, dev.frameId, maxBytesPerWsMsg);
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
      const delay = Math.max(0, minFrameInterval - (Number.isFinite(since) ? since : 0));
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
      try { await root?.send('Target.closeTarget', { targetId: device.id }); } catch { }
      if (device.throttleTimer)
        clearTimeout(device.throttleTimer);
      devices.delete(id);
    }
  }
}
