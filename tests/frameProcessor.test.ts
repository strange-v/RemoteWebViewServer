import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { FrameProcessor, FrameProcessorCfg, RGBA } from "../src/frameProcessor.js";
import { buildFramePackets, FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "../src/protocol.js";

const DEFAULT_CFG: FrameProcessorCfg = {
  tileSize: 32,
  fullframeTileCount: 4,
  fullframeAreaThreshold: 0.5,
  jpegQuality: 85,
  fullFrameEvery: 50,
  maxBytesPerMessage: 14336,
};

function solidFrame(width: number, height: number, rgb: [number, number, number]): RGBA {
  const data = Buffer.alloc(width * height * 4);
  for (let o = 0; o < data.length; o += 4) {
    data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
  }
  return { data, width, height };
}

// Pseudo-random noise: about the worst case for JPEG size.
function noiseFrame(width: number, height: number, seed = 1): RGBA {
  const data = Buffer.alloc(width * height * 4);
  let s = seed >>> 0;
  for (let o = 0; o < data.length; o += 4) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    data[o] = s >>> 24; data[o + 1] = (s >>> 16) & 0xff; data[o + 2] = (s >>> 8) & 0xff; data[o + 3] = 255;
  }
  return { data, width, height };
}

function paint(frame: RGBA, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): RGBA {
  const data = Buffer.from(frame.data);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * frame.width + x) * 4;
      data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
    }
  }
  return { ...frame, data };
}

const area = (rects: { w: number; h: number }[]) => rects.reduce((a, r) => a + r.w * r.h, 0);

describe("FrameProcessor", () => {
  it("sends the whole frame first, then nothing for an identical frame", async () => {
    const fp = new FrameProcessor(DEFAULT_CFG);
    const first = await fp.processFrameAsync(solidFrame(320, 240, [10, 20, 30]));
    expect(first.isFullFrame).toBe(true);
    expect(area(first.rects)).toBe(320 * 240);

    const second = await fp.processFrameAsync(solidFrame(320, 240, [10, 20, 30]));
    expect(second.rects).toHaveLength(0);
  });

  it("detects a change in the green/blue channels only", async () => {
    const fp = new FrameProcessor(DEFAULT_CFG);
    const base = solidFrame(320, 240, [0, 200, 0]);
    await fp.processFrameAsync(base);

    const out = await fp.processFrameAsync(paint(base, 40, 40, 10, 10, [0, 0, 255]));
    expect(out.isFullFrame).toBe(false);
    expect(out.rects).toHaveLength(1);
    expect(out.rects[0]).toMatchObject({ x: 32, y: 32, w: 32, h: 32 });
  });

  it("diffs against the last processed frame, not the first one", async () => {
    const fp = new FrameProcessor(DEFAULT_CFG);
    const base = solidFrame(320, 240, [255, 255, 255]);
    await fp.processFrameAsync(base);
    const changed = paint(base, 0, 0, 8, 8, [0, 0, 0]);
    await fp.processFrameAsync(changed);

    // Same content as the previous frame: nothing to send.
    expect((await fp.processFrameAsync({ ...changed, data: Buffer.from(changed.data) })).rects).toHaveLength(0);
    // Reverting the change must be sent.
    expect((await fp.processFrameAsync(base)).rects).toHaveLength(1);
  });

  it("sends a full frame when requested", async () => {
    const fp = new FrameProcessor(DEFAULT_CFG);
    const base = solidFrame(320, 240, [1, 2, 3]);
    await fp.processFrameAsync(base);
    fp.requestFullFrame();
    const out = await fp.processFrameAsync(base);
    expect(out.isFullFrame).toBe(true);
    expect(area(out.rects)).toBe(320 * 240);
  });

  it("splits oversized rects so every piece fits into one message, instead of painting them red", async () => {
    const fp = new FrameProcessor(DEFAULT_CFG);
    const frame = noiseFrame(480, 480);
    const out = await fp.processFrameAsync(frame);

    const maxTile = DEFAULT_CFG.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
    expect(out.rects.length).toBeGreaterThan(DEFAULT_CFG.fullframeTileCount);
    for (const r of out.rects) expect(r.data.length).toBeLessThanOrEqual(maxTile);

    // Pieces cover the frame exactly once.
    expect(area(out.rects)).toBe(480 * 480);
    const covered = new Uint8Array(480 * 480);
    for (const r of out.rects)
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) covered[y * 480 + x]++;
    expect(covered.every(c => c === 1)).toBe(true);

    // Decoded pieces show the source image, not a red fill.
    const r = out.rects[0];
    const { data } = await sharp(r.data).raw().toBuffer({ resolveWithObject: true });
    const reds = data.reduce((n, _, i) => (i % 3 === 0 && data[i] > 240 && data[i + 1] < 15 && data[i + 2] < 15 ? n + 1 : n), 0);
    expect(reds).toBeLessThan((r.w * r.h) / 2);

    for (const pkt of buildFramePackets(out.rects, out.encoding, 1, out.isFullFrame, DEFAULT_CFG.maxBytesPerMessage))
      expect(pkt.length).toBeLessThanOrEqual(DEFAULT_CFG.maxBytesPerMessage);
  });
});
