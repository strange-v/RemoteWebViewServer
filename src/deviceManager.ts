import { CDPSession } from "playwright";
import sharp from "sharp";
import env from "env-var";
import { resolveDevice, loadDeviceMap } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { installAntiAnimCSSAsync } from "./antiAnim.js";
import { Encoding } from "./protocol.js";

export type DeviceSession = {
  id: string;
  cdp: CDPSession;
  w: number;
  h: number;
  url: string;
  lastActive: number;
  frameId: number;
  processor: FrameProcessor;
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
  await session.send('Page.navigate', { url: cfg.url });

  await session.send('Page.startScreencast', {
    format: 'png',
    maxWidth: cfg.w,
    maxHeight: cfg.h,
    everyNthFrame: env.get("EVERY_NTH_FRAME").default("5").asIntPositive()
  });

  const processor = new FrameProcessor({
    tile: env.get("TILE").default("32").asIntPositive(),
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
    processor
  };
  devices.set(id, newDevice);

  session.on('Page.screencastFrame', async (evt: any) => {
    try {
      const pngFull = Buffer.from(evt.data, 'base64');
      await session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });

      const { data, info } = await sharp(pngFull).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
      const out = await processor.processFrameAsync({ data, width: info.width, height: info.height });
      if (out.rects.length > 0) {
        newDevice.frameId = (newDevice.frameId + 1) >>> 0;
        await broadcaster.sendFrameChunkedAsync(id, Encoding.JPEG, out, newDevice.frameId);
      }
    } catch {
      // swallow non-fatal processing errors
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
      devices.delete(id);
    }
  }
}
