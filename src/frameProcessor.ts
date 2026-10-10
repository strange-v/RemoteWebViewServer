import os from "node:os";
import sharp from "sharp";
import { Encoding, FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "./protocol.js";

sharp.concurrency(Math.max(1, os.cpus().length - 1));

// Packed RGB, no alpha: 25% less to decode, compare and encode than RGB.
export type RGB = { data: Buffer; width: number; height: number };
export const BPP = 3; // bytes per pixel

export type Rect = { x: number; y: number; w: number; h: number; data: Buffer };

export type FrameOut = {
  rects: Rect[];
  isFullFrame: boolean;
  encoding: Encoding;
};

export type FrameProcessorCfg = {
  tileSize: number;
  fullframeTileCount: number;
  fullframeAreaThreshold: number;
  jpegQuality: number;
  fullFrameEvery: number;
  maxBytesPerMessage: number;
};

type TileInfo = { x: number; y: number; w: number; h: number; changed: boolean };
type Box = { x: number; y: number; w: number; h: number };

// Split point for oversized rects: a multiple of the JPEG MCU size keeps tiles friendly to HW decoders.
const SPLIT_ALIGN = 16;

export class FrameProcessor {
  private _cfg: FrameProcessorCfg;
  private _cols = 0;
  private _rows = 0;
  // Last processed frame. Every tile that differed from its predecessor was sent,
  // so this is exactly what the client shows. Must not be mutated by the caller.
  private _prevFrame?: RGB;
  private _iter = 0;
  private _fullFrameRequested = false;

  constructor(cfg: FrameProcessorCfg) {
    this._cfg = cfg;
  }

  public requestFullFrame(): void {
    this._iter = 0;
    this._fullFrameRequested = true;
  }

  public async processFrameAsync(frame: RGB): Promise<FrameOut> {
    const prev = this._prevFrame;
    const sizeChanged = !prev || prev.width !== frame.width || prev.height !== frame.height;
    if (sizeChanged) this._initGrid(frame.width, frame.height);

    let forceFull = sizeChanged || (this._iter % this._cfg.fullFrameEvery) === 0;
    if (this._fullFrameRequested) {
      forceFull = true;
      this._fullFrameRequested = false;
    }
    const chosenEncoding: Encoding = Encoding.JPEG;

    const tiles: TileInfo[] = [];
    let changedArea = 0;

    for (let ty = 0; ty < this._rows; ty++) {
      for (let tx = 0; tx < this._cols; tx++) {
        const x = tx * this._cfg.tileSize;
        const y = ty * this._cfg.tileSize;
        const w = Math.min(this._cfg.tileSize, frame.width - x);
        const h = Math.min(this._cfg.tileSize, frame.height - y);

        const changed = forceFull || this._tileDiffers(frame, prev!, x, y, w, h);
        tiles.push({ x, y, w, h, changed });
        if (changed) changedArea += w * h;
      }
    }

    const totalArea = frame.width * frame.height;
    const changedPct = totalArea > 0 ? (changedArea / totalArea) : 0;
    const doFull = forceFull || (changedPct > this._cfg.fullframeAreaThreshold);

    const boxes = doFull
      ? this._splitWholeFrame(frame.width, frame.height, this._cfg.fullframeTileCount)
      : this._mergeChangedTiles(tiles, frame.width, frame.height);

    // Encode in parallel: sharp runs each encode on the libuv thread pool.
    const parts = await Promise.all(boxes.map(b => this._encodeFittingAsync(frame, b, chosenEncoding)));
    const rects = parts.flat();

    this._prevFrame = frame;
    this._iter++;
    return { rects, isFullFrame: doFull, encoding: chosenEncoding };
  }

  private _tileDiffers(cur: RGB, prev: RGB, x: number, y: number, w: number, h: number): boolean {
    const rowBytes = w * BPP;
    for (let yy = 0; yy < h; yy++) {
      const off = ((y + yy) * cur.width + x) * BPP;
      if (cur.data.compare(prev.data, off, off + rowBytes, off, off + rowBytes) !== 0) return true;
    }
    return false;
  }

  // Encodes a box, splitting it in halves until every piece fits into one message.
  private async _encodeFittingAsync(frame: RGB, b: Box, enc: Encoding): Promise<Rect[]> {
    const maxBytesPerTile = this._cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
    const data = await this._encode(this._extractRaw(frame, b.x, b.y, b.w, b.h), b.w, b.h, enc);
    if (data.length <= maxBytesPerTile) return [{ ...b, data }];

    const halves = this._splitBox(b);
    if (!halves) {
      // A tiny box that still doesn't fit: maxBytesPerMessage is unrealistically small.
      return [{ ...b, data: await this._makeRedFrameAsync(b.w, b.h, enc) }];
    }
    const parts = await Promise.all(halves.map(h => this._encodeFittingAsync(frame, h, enc)));
    return parts.flat();
  }

  private _splitBox(b: Box): [Box, Box] | null {
    const alongX = b.w >= b.h;
    const size = alongX ? b.w : b.h;
    if (size < 2) return null;

    let cut = Math.floor(size / 2);
    if (size >= 2 * SPLIT_ALIGN) cut = Math.floor(cut / SPLIT_ALIGN) * SPLIT_ALIGN;

    return alongX
      ? [{ x: b.x, y: b.y, w: cut, h: b.h }, { x: b.x + cut, y: b.y, w: b.w - cut, h: b.h }]
      : [{ x: b.x, y: b.y, w: b.w, h: cut }, { x: b.x, y: b.y + cut, w: b.w, h: b.h - cut }];
  }

  private _splitWholeFrame(w: number, h: number, n: number): { x: number; y: number; w: number; h: number }[] {
    if (n <= 1) return [{ x: 0, y: 0, w, h }];

    // Two parts are horizontal bands; otherwise a grid of rows x cols = n.
    let rows = n === 2 ? 2 : Math.floor(Math.sqrt(n));
    while (rows > 1 && (n % rows !== 0)) rows--;
    const cols = Math.floor(n / rows);

    // Inner edges go to the nearest multiple of SPLIT_ALIGN, so tiles stay friendly to
    // HW JPEG decoders (the ESP32-P4 one needs a width that is a multiple of 16).
    const split = (size: number, parts: number): number[] => {
      const out: number[] = [];
      let prev = 0;
      for (let i = 1; i <= parts; i++) {
        let cur = size;
        if (i < parts) {
          cur = Math.round((i * size) / parts / SPLIT_ALIGN) * SPLIT_ALIGN;
          cur = Math.min(Math.max(cur, prev + 1), size - (parts - i)); // no empty parts
        }
        out.push(cur - prev);
        prev = cur;
      }
      return out;
    };

    const widths = split(w, cols);
    const heights = split(h, rows);

    const rects: { x: number; y: number; w: number; h: number }[] = [];
    let yAcc = 0;
    for (let r = 0; r < rows; r++) {
      let xAcc = 0;
      for (let c = 0; c < cols; c++) {
        rects.push({ x: xAcc, y: yAcc, w: widths[c], h: heights[r] });
        xAcc += widths[c];
      }
      yAcc += heights[r];
    }
    return rects;
  }

  private _getMaxFullTileSize(frameW: number, frameH: number): { maxW: number; maxH: number } {
    const fullRects = this._splitWholeFrame(frameW, frameH, this._cfg.fullframeTileCount);
    let maxW = 0, maxH = 0;
    for (const r of fullRects) {
      if (r.w > maxW) maxW = r.w;
      if (r.h > maxH) maxH = r.h;
    }
    return { maxW, maxH };
  }

  private _calcGridSplits(frameW: number, frameH: number) {
    const cols = this._cols, rows = this._rows, ts = this._cfg.tileSize;
    const widths: number[] = new Array(cols);
    const heights: number[] = new Array(rows);
    const xOffsets: number[] = new Array(cols);
    const yOffsets: number[] = new Array(rows);

    let x = 0;
    for (let c = 0; c < cols; c++) {
      const w = Math.min(ts, frameW - x);
      widths[c] = w;
      xOffsets[c] = x;
      x += w;
    }
    let y = 0;
    for (let r = 0; r < rows; r++) {
      const h = Math.min(ts, frameH - y);
      heights[r] = h;
      yOffsets[r] = y;
      y += h;
    }
    return { widths, heights, xOffsets, yOffsets };
  }

  private _mergeChangedTiles(
    tiles: TileInfo[],
    frameW: number,
    frameH: number
  ): Box[] {
    const cols = this._cols, rows = this._rows;
    const changed: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
    const visited: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));

    for (let i = 0; i < tiles.length; i++) {
      const ty = Math.floor(i / cols);
      const tx = i % cols;
      changed[ty][tx] = tiles[i].changed;
    }

    const { widths, heights, xOffsets, yOffsets } = this._calcGridSplits(frameW, frameH);
    const { maxW, maxH } = this._getMaxFullTileSize(frameW, frameH);

    const rects: { x: number; y: number; w: number; h: number }[] = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!changed[r][c] || visited[r][c]) continue;

        // grow horizontally
        let wTiles = 0, pxW = 0;
        while (c + wTiles < cols && changed[r][c + wTiles] && !visited[r][c + wTiles]) {
          const nextW = pxW + widths[c + wTiles];
          if (nextW > maxW) break;
          pxW = nextW;
          wTiles++;
        }

        // grow vertically
        let hTiles = 1, pxH = heights[r];
        let canGrow = true;
        while (canGrow && (r + hTiles) < rows) {
          const nextH = pxH + heights[r + hTiles];
          if (nextH > maxH) break;
          for (let cc = c; cc < c + wTiles; cc++) {
            if (!changed[r + hTiles][cc] || visited[r + hTiles][cc]) { canGrow = false; break; }
          }
          if (!canGrow) break;
          pxH = nextH;
          hTiles++;
        }

        rects.push({ x: xOffsets[c], y: yOffsets[r], w: pxW, h: pxH });

        for (let rr = r; rr < r + hTiles; rr++) {
          for (let cc = c; cc < c + wTiles; cc++) {
            visited[rr][cc] = true;
          }
        }
      }
    }

    return rects;
  }

  private _initGrid(w: number, h: number) {
    this._cols = Math.ceil(w / this._cfg.tileSize);
    this._rows = Math.ceil(h / this._cfg.tileSize);
  }

  private _extractRaw(frame: RGB, x: number, y: number, w: number, h: number): Buffer {
    const out = Buffer.allocUnsafe(w * h * BPP);
    for (let yy = 0; yy < h; yy++) {
      const src = ((y + yy) * frame.width + x) * BPP;
      frame.data.copy(out, yy * w * BPP, src, src + w * BPP);
    }
    return out;
  }

  private async _encode(rawRgb: Buffer, w: number, h: number, enc: Encoding): Promise<Buffer> {
    switch (enc) {
      case Encoding.JPEG:
        return this._encodeJPEG(rawRgb, w, h);
      case Encoding.RAW565:
        return this._encodeRAW565(rawRgb);
      default:
        return this._encodeJPEG(rawRgb, w, h);
    }
  }

  private async _encodeJPEG(rawRgb: Buffer, w: number, h: number): Promise<Buffer> {
    return sharp(rawRgb, { raw: { width: w, height: h, channels: BPP } })
      .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: "4:2:0" })
      .toBuffer();
  }

  private _encodeRAW565(rawRgb: Buffer): Buffer {
    const pxCount = rawRgb.length / BPP;
    const out = Buffer.allocUnsafe(pxCount * 2);
    for (let i = 0, j = 0; i < pxCount; i++, j += BPP) {
      const r = rawRgb[j];
      const g = rawRgb[j + 1];
      const b = rawRgb[j + 2];
      const v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
      out[i * 2] = v & 0xFF;
      out[i * 2 + 1] = (v >> 8) & 0xFF;
    }
    return out;
  }

  private async _makeRedFrameAsync(w: number, h: number, enc: Encoding): Promise<Buffer> {
    const raw = Buffer.alloc(w * h * BPP);
    for (let o = 0; o < raw.length; o += BPP) raw[o] = 0xFF;
    return this._encode(raw, w, h, enc);
  }
}
