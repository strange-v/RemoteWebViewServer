import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { FrameProcessor, FrameProcessorCfg, RGB, BPP } from "../src/frameProcessor.js";
import { buildFramePackets, FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "../src/protocol.js";

const DEFAULT_CFG: FrameProcessorCfg = {
  tileSize: 32,
  fullframeTileCount: 4,
  fullframeAreaThreshold: 0.5,
  jpegQuality: 85,
  fullFrameEvery: 50,
  maxBytesPerMessage: 14336,
};

function solidFrame(width: number, height: number, rgb: [number, number, number]): RGB {
  const data = Buffer.alloc(width * height * BPP);
  for (let o = 0; o < data.length; o += BPP) {
    data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
  }
  return { data, width, height };
}

// Pseudo-random noise: about the worst case for JPEG size.
function noiseFrame(width: number, height: number, seed = 1): RGB {
  const data = Buffer.alloc(width * height * BPP);
  let s = seed >>> 0;
  for (let o = 0; o < data.length; o += BPP) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    data[o] = s >>> 24; data[o + 1] = (s >>> 16) & 0xff; data[o + 2] = (s >>> 8) & 0xff;
  }
  return { data, width, height };
}

function paint(frame: RGB, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): RGB {
  const data = Buffer.from(frame.data);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * frame.width + x) * BPP;
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

  // Full frame of a flat color: every tile fits, so the rects are exactly the full-frame split.
  const fullFrameRects = async (w: number, h: number, tiles: number) => {
    const fp = new FrameProcessor({ ...DEFAULT_CFG, fullframeTileCount: tiles, maxBytesPerMessage: 1 << 20 });
    const out = await fp.processFrameAsync(solidFrame(w, h, [9, 9, 9]));
    return out.rects.map(({ x, y, w, h }) => ({ x, y, w, h }));
  };

  it("aligns inner edges of the full-frame split to 16 px", async () => {
    // 600 / 2 = 300 is not a multiple of 16: the edge moves to 304
    expect(await fullFrameRects(1024, 600, 4)).toEqual([
      { x: 0, y: 0, w: 512, h: 304 }, { x: 512, y: 0, w: 512, h: 304 },
      { x: 0, y: 304, w: 512, h: 296 }, { x: 512, y: 304, w: 512, h: 296 },
    ]);
    // Two parts stay horizontal bands
    expect(await fullFrameRects(1024, 600, 2)).toEqual([
      { x: 0, y: 0, w: 1024, h: 304 }, { x: 0, y: 304, w: 1024, h: 296 },
    ]);
    // Sizes that already divide evenly are unchanged
    expect(await fullFrameRects(480, 480, 4)).toEqual([
      { x: 0, y: 0, w: 240, h: 240 }, { x: 240, y: 0, w: 240, h: 240 },
      { x: 0, y: 240, w: 240, h: 240 }, { x: 240, y: 240, w: 240, h: 240 },
    ]);
    expect(await fullFrameRects(480, 480, 1)).toEqual([{ x: 0, y: 0, w: 480, h: 480 }]);
  });

  it("never produces empty parts on tiny frames", async () => {
    const rects = await fullFrameRects(20, 10, 4);
    expect(rects.every(r => r.w > 0 && r.h > 0)).toBe(true);
    expect(area(rects)).toBe(20 * 10);
  });
});
