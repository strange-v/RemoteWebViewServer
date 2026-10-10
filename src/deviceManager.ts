import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual, readInjectScriptConfig } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { SelfTestRunner } from "./selfTest.js";
import { getInjectScriptFromUrl } from "./scriptLoader.js";
import { PipelineStats, newPipelineStats } from "./pipelineStats.js";
import { FrameAckWindow } from "./frameAckWindow.js";
import { getScaledViewport } from "./util.js";

export type DeviceSession = {
  id: string;
  deviceId: string;
  cdp: CDPSession;
  sessionId: string;
  // screencast runs only while clients are connected
  screencasting: boolean;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  processor: FrameProcessor;
  selfTestRunner: SelfTestRunner

  // trailing throttle state
  pendingB64?: string;
  pendingAtMs?: number; // when the pending frame arrived from the browser
  throttleTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
  // a frame is being processed; frames are processed one at a time
  processing: boolean;
  // last processed screencast frame, to skip identical ones
  processedB64?: string;

  // last screencast frame, kept to re-send a full frame on request
  lastB64?: string;
  resendFullFrame: () => void;

  // frames sent but not acknowledged yet, for clients that send FrameAck
  acks: FrameAckWindow;
  handleFrameAck: (frameId: number) => void;

  stats: PipelineStats;
  // frames came smaller than the device and had to be upscaled; logged once
  scaleWarned?: boolean;
  // replaces cfg.minFrameInterval while set (the self-test sends one frame at a time)
  minFrameIntervalOverride?: number;
  // frameAtMs: when the browser delivered the frame; sentAtMs: when it was handed to the socket
  onFrameSent?: (frameAtMs: number, sentAtMs: number) => void;
};

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');

const CONGESTION_RETRY_MS = 10;
// Frames in flight to a client that acknowledges them: two let sending the next frame
// overlap with the device drawing the previous one.
const ACK_WINDOW_FRAMES = 2;
// A frame unacknowledged for this long counts as lost.
const ACK_TIMEOUT_MS = 1000;

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();

const _pending = new Map<string, Promise<unknown>>();

// Operations on the same device id run one after another, so e.g. concurrent
// connections can't both see "no device" and each create a browser tab.
function _enqueue<T>(id: string, op: () => Promise<T>): Promise<T> {
  const prev = _pending.get(id);
  const next = (prev ?? Promise.resolve())
    .catch(() => { })
    .then(op);
  _pending.set(id, next);
  next.finally(() => {
    if (_pending.get(id) === next) _pending.delete(id);
  }).catch(() => { });
  return next;
}

export function getDevice(id: string): DeviceSession | undefined {
  return devices.get(id);
}

export function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  return _enqueue(id, () => _ensureDeviceAsync(id, cfg));
}

// Stops the screencast once the last client is gone; Chrome then stops encoding frames.
export function releaseDeviceAsync(id: string): Promise<void> {
  return _enqueue(id, () => _stopScreencastIfUnusedAsync(id));
}

async function _stopScreencastIfUnusedAsync(id: string): Promise<void> {
  const device = devices.get(id);
  if (!device || !device.screencasting || broadcaster.getClientCount(id) > 0) return;

  device.screencasting = false;
  if (device.throttleTimer) clearTimeout(device.throttleTimer);
  device.throttleTimer = undefined;
  device.pendingB64 = undefined;
  await device.cdp.send('Page.stopScreencast').catch(() => { });
  console.log(`[device] Screencast stopped for ${id}: no clients`);
}

// Width and height from the IHDR chunk of a PNG, without decoding it.
function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) return undefined; // "IHDR"
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function startScreencastAsync(session: { send(method: any, params?: any): Promise<any> }, cfg: DeviceConfig) {
  return session.send('Page.startScreencast', {
    format: 'png',
    maxWidth: cfg.width,
    maxHeight: cfg.height,
    everyNthFrame: cfg.everyNthFrame
  });
}

async function _ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      // A new connection: frames in flight to the old one will never be acknowledged,
      // and the new client may not send acks at all.
      device.acks.reset();
      if (device.screencasting) {
        device.resendFullFrame();
      } else {
        // The last frame we hold may be stale; the restarted screencast sends a fresh one.
        device.lastB64 = undefined;
        device.processedB64 = undefined;
        device.processor.requestFullFrame();
        await startScreencastAsync(device.cdp, device.cfg);
        device.screencasting = true;
        console.log(`[device] Screencast resumed for ${id}`);
      }
      return device;
    } else {
      console.log(`[device] Reconfiguring device ${id}`);
      await deleteDeviceAsync(device);
    }
  }

  // The page is laid out at cfg.width/height divided by the scale and rendered at
  // deviceScaleFactor = scale, so the screencast frames keep the device's physical size.
  const viewport = getScaledViewport(cfg.width, cfg.height, cfg.scale);

  // Full Chrome accepts a window size only for a new window ("Target position can only be
  // set for new windows"); a separate window per device also keeps their sizes independent.
  const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    width: viewport.width,
    height: viewport.height,
    newWindow: true,
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
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: cfg.scale,
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

    // Needed for Inspector.targetCrashed.
    await session.send('Inspector.enable').catch(() => { });

    await startScreencastAsync(session, cfg);
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
    sessionId: session.sessionId,
    screencasting: true,
    cfg: cfg,
    url: '',
    lastActive: Date.now(),
    frameId: 0,
    processor,
    selfTestRunner: new SelfTestRunner(broadcaster),
    pendingB64: undefined,
    throttleTimer: undefined,
    lastProcessedMs: undefined,
    processing: false,
    processedB64: undefined,
    lastB64: undefined,
    resendFullFrame: () => { },
    acks: new FrameAckWindow(ACK_WINDOW_FRAMES, ACK_TIMEOUT_MS),
    handleFrameAck: () => { },
    stats: newPipelineStats(),
    minFrameIntervalOverride: undefined,
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

  // The device may be deleted or replaced (reconfiguration, tab crash) while a frame is being
  // processed; its frames must then not reach the clients of the new session.
  const isCurrent = () => devices.get(id) === newDevice;

  const flushPending = async () => {
    const dev = newDevice;
    dev.throttleTimer = undefined;

    if (!dev.pendingB64 || !isCurrent()) return;
    if (broadcaster.isCongested(id)) {
      // Keep only the newest frame until the client catches up; the diff is computed
      // against the last frame actually sent, so skipping frames is safe.
      dev.throttleTimer = setTimeout(flushPending, CONGESTION_RETRY_MS);
      return;
    }
    if (dev.acks.isFull(Date.now())) {
      // Same, but paced by the client's acks; handleFrameAck resumes as soon as one arrives.
      // The timer only covers a lost ack.
      const wait = Math.max(0, (dev.acks.timeoutAtMs() ?? Date.now()) - Date.now()) + 1;
      dev.throttleTimer = setTimeout(flushPending, wait);
      return;
    }

    const b64 = dev.pendingB64;
    const frameAtMs = dev.pendingAtMs ?? Date.now();
    dev.pendingB64 = undefined;
    if (b64 === dev.processedB64) return;

    // Frames must be processed one at a time: FrameProcessor diffs against the previous
    // frame, and a later frame must never be sent before an earlier one.
    dev.processing = true;
    // The interval is measured from the start of processing, so minFrameInterval is the
    // frame period rather than an extra pause after each frame.
    dev.lastProcessedMs = Date.now();
    const t0 = performance.now();
    try {
      dev.processedB64 = b64;
      const pngFull = Buffer.from(b64, 'base64');

      let img = sharp(pngFull);
      const size = pngSize(pngFull);
      if (size && (size.width !== cfg.width || size.height !== cfg.height)) {
        // Chrome renders at most at the browser's device scale factor (MAX_DEVICE_SCALE_FACTOR),
        // and a fractional scale can be a pixel off; stretch the frame to the device size.
        if (!dev.scaleWarned && size.width < cfg.width) {
          dev.scaleWarned = true;
          console.warn(`[device] ${id}: frames are ${size.width}x${size.height} instead of ` +
            `${cfg.width}x${cfg.height}, upscaling; set MAX_DEVICE_SCALE_FACTOR >= ${cfg.scale} for sharp output`);
        }
        const { data, info } = await img.removeAlpha().resize(cfg.width, cfg.height, { fit: 'fill' })
          .raw().toBuffer({ resolveWithObject: true });
        img = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
      }
      if (dev.cfg.rotation) img = img.rotate(dev.cfg.rotation);

      const { data, info } = await img
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const out = await processor.processFrameAsync({ data, width: info.width, height: info.height });
      if (out.rects.length > 0 && isCurrent()) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        const procMs = performance.now() - t0;
        const bytes = broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
        if (bytes > 0) dev.acks.sent(dev.frameId, Date.now());

        const s = dev.stats;
        s.framesSent++;
        if (out.isFullFrame) s.fullFrames++;
        s.bytesSent += bytes;
        s.rects += out.rects.length;
        for (const r of out.rects) s.maxRectBytes = Math.max(s.maxRectBytes, r.data.length);
        s.procMsTotal += procMs;
        s.procMsMax = Math.max(s.procMsMax, procMs);
        if (bytes > 0) dev.onFrameSent?.(frameAtMs, Date.now());
      }
    } catch (e) {
      console.warn(`[device] Failed to process frame for ${id}: ${(e as Error).message}`);
    } finally {
      dev.processing = false;
    }
    // Frames that arrived meanwhile were held back; process the newest one.
    if (dev.pendingB64) scheduleFlush();
  };

  const scheduleFlush = () => {
    if (newDevice.throttleTimer || newDevice.processing || !isCurrent()) return;
    const now = Date.now();
    const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
    const interval = newDevice.minFrameIntervalOverride ?? cfg.minFrameInterval;
    const delay = Math.max(0, interval - (Number.isFinite(since) ? since : 0));
    newDevice.throttleTimer = setTimeout(flushPending, delay);
  };

  // Screencast only emits frames when the page changes, so a full-frame request on a
  // static page has to re-process the last frame we received.
  newDevice.handleFrameAck = (frameId: number) => {
    const first = !newDevice.acks.supported;
    const freed = newDevice.acks.ack(frameId);
    if (first) console.log(`[device] ${id} acknowledges frames: pacing frames to the device`);
    // Waiting for this ack: process the newest pending frame right away.
    if (freed && newDevice.pendingB64 && !newDevice.processing && newDevice.throttleTimer) {
      clearTimeout(newDevice.throttleTimer);
      newDevice.throttleTimer = undefined;
      scheduleFlush();
    }
  };

  newDevice.resendFullFrame = () => {
    newDevice.processor.requestFullFrame();
    newDevice.processedB64 = undefined;
    if (!newDevice.pendingB64 && newDevice.lastB64) {
      newDevice.pendingB64 = newDevice.lastB64;
      newDevice.pendingAtMs = Date.now();
    }
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
    newDevice.pendingAtMs = Date.now();
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

  // E.g. out of memory on a heavy dashboard: without this the display stays frozen.
  session.on('Inspector.targetCrashed', () => {
    console.warn(`[device] Tab of device ${id} crashed, recreating it`);
    _enqueue(id, () => _recreateCrashedDeviceAsync(newDevice))
      .catch(e => console.warn(`[device] Failed to recreate device ${id}: ${(e as Error).message}`));
  });

  return newDevice;
}

async function _recreateCrashedDeviceAsync(crashed: DeviceSession): Promise<void> {
  const id = crashed.deviceId;
  if (devices.get(id) !== crashed) return; // already replaced or removed

  const url = crashed.url;
  await deleteDeviceAsync(crashed, true);
  const device = await _ensureDeviceAsync(id, crashed.cfg);
  if (url && url !== 'about:blank')
    await device.cdp.send('Page.navigate', { url });
  await _stopScreencastIfUnusedAsync(id);
}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  if (_cleanupRunning) return;
  _cleanupRunning = true;

  try {
    const now = Date.now();
    const staleIds = Array.from(devices.values())
      .filter(d => now - d.lastActive > ttlMs && broadcaster.getClientCount(d.deviceId) === 0)
      .map(d => d.deviceId);

    for (const id of staleIds) {
      const dev = devices.get(id);
      if (!dev) continue;

      console.log(`[device] Cleaning up idle device ${id}`);
      await _enqueue(id, async () => {
        // A client may have connected while earlier devices were being removed.
        if (devices.get(id) === dev && broadcaster.getClientCount(id) === 0)
          await deleteDeviceAsync(dev);
      }).catch(() => { /* swallow */ });
    }
  } finally {
    _cleanupRunning = false;
  }
}

async function deleteDeviceAsync(device: DeviceSession, crashed = false) {
  const root = getRoot();

  if (!devices.delete(device.deviceId))
    return;

  if (device.throttleTimer)
    clearTimeout(device.throttleTimer);
  device.selfTestRunner.stop();

  // A crashed tab doesn't answer, so don't wait for the command to time out.
  if (!crashed && device.screencasting)
    await device.cdp.send("Page.stopScreencast").catch(() => { });
  await root?.send("Target.closeTarget", { targetId: device.id }).catch(() => { });
  root?.removeSession(device.sessionId);
}
