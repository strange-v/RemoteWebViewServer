import sharp from "sharp";
import { Encoding } from "./protocol.js";

export type RGBA = { data: Buffer; width: number; height: number };

export type Rect = { x: number; y: number; w: number; h: number; data: Buffer };

export type FrameOut = {
  rects: Rect[];
  isFullFrame: boolean;
  fullTiles?: number;
  encoding: Encoding;
};

export type TilesCfg = {
  tile: number;
  jpegQuality: number;
  fullEvery: number;
};

export class FrameProcessor {
  private _cfg: TilesCfg;
  private _cols = 0;
  private _rows = 0;
  private _prev?: Uint32Array;
  private _iter = 0;

  private readonly _fullTilesForFullFrame = 4;
  private readonly _fullByAreaThreshold = 0.5;

  constructor(cfg: TilesCfg) {
    this._cfg = cfg;
  }

  public async processFrameAsync(rgba: RGBA): Promise<FrameOut> {
    if (!this._prev) this._initGrid(rgba.width, rgba.height);

    const forceFull = (this._iter % this._cfg.fullEvery) === 0;
    const chosenEncoding: Encoding = Encoding.JPEG;

    type TileInfo = { x: number; y: number; w: number; h: number; idx: number; h32: number; changed: boolean };
    const tiles: TileInfo[] = [];
    let changedArea = 0;

    for (let ty = 0; ty < this._rows; ty++) {
      for (let tx = 0; tx < this._cols; tx++) {
        const x = tx * this._cfg.tile;
        const y = ty * this._cfg.tile;
        const w = Math.min(this._cfg.tile, rgba.width  - x);
        const h = Math.min(this._cfg.tile, rgba.height - y);

        const raw = this._extractRaw(rgba, x, y, w, h);
        const h32 = this._hash32(raw);
        const idx = ty * this._cols + tx;
        const prev = this._prev![idx];
        const changed = forceFull || (prev !== h32);

        tiles.push({ x, y, w, h, idx, h32, changed });
        if (changed) changedArea += w * h;
      }
    }

    const totalArea = rgba.width * rgba.height;
    const changedPct = totalArea > 0 ? (changedArea / totalArea) : 0;
    const doFull = forceFull || (changedPct > this._fullByAreaThreshold);

    let out: FrameOut;
    if (doFull) {
      out = await this._processFullFrame(rgba, tiles, chosenEncoding);
    } else {
      out = await this._processPartialFrame(rgba, tiles, chosenEncoding);
    }

    this._iter++;
    return out;
  }

  private async _processFullFrame(
    rgba: RGBA,
    tilesInfo: { idx: number; h32: number }[],
    encoding: Encoding
  ): Promise<FrameOut> {
    const rectsForFull = this._splitWholeFrame(rgba.width, rgba.height, this._fullTilesForFullFrame);
    const rects: Rect[] = [];

    for (const r of rectsForFull) {
      const raw = this._extractRaw(rgba, r.x, r.y, r.w, r.h);
      const data = await this._encode(raw, r.w, r.h, encoding);
      rects.push({ x: r.x, y: r.y, w: r.w, h: r.h, data });
    }

    for (const t of tilesInfo) this._prev![t.idx] = t.h32;

    return { rects, isFullFrame: true, fullTiles: this._fullTilesForFullFrame, encoding };
  }

  private async _processPartialFrame(
    rgba: RGBA,
    tiles: { x: number; y: number; w: number; h: number; idx: number; h32: number; changed: boolean }[],
    encoding: Encoding
  ): Promise<FrameOut> {
    const out: Rect[] = [];
    for (const t of tiles) {
      if (!t.changed) continue;
      const raw = this._extractRaw(rgba, t.x, t.y, t.w, t.h);
      const data = await this._encode(raw, t.w, t.h, encoding);
      out.push({ x: t.x, y: t.y, w: t.w, h: t.h, data });
      this._prev![t.idx] = t.h32;
    }
    return { rects: out, isFullFrame: false, encoding };
  }

  private _splitWholeFrame(w: number, h: number, n: number): { x: number; y: number; w: number; h: number }[] {
    if (n <= 1) return [{ x: 0, y: 0, w, h }];

    let cols = Math.ceil(Math.sqrt(n));
    let rows = Math.ceil(n / cols);
    while (cols * rows < n) rows++;

    const widths: number[] = [];
    const heights: number[] = [];
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * w) / cols);
      const x1 = Math.floor(((c + 1) * w) / cols);
      widths.push(x1 - x0);
    }
    for (let r = 0; r < rows; r++) {
      const y0 = Math.floor((r * h) / rows);
      const y1 = Math.floor(((r + 1) * h) / rows);
      heights.push(y1 - y0);
    }

    const rects: { x: number; y: number; w: number; h: number }[] = [];
    let produced = 0;
    let yAcc = 0;
    for (let r = 0; r < rows; r++) {
      let xAcc = 0;
      for (let c = 0; c < cols; c++) {
        if (produced >= n) break;
        const rw = widths[c];
        const rh = heights[r];
        rects.push({ x: xAcc, y: yAcc, w: rw, h: rh });
        produced++;
        xAcc += rw;
      }
      yAcc += heights[r];
    }
    return rects;
  }

  private _initGrid(w: number, h: number) {
    this._cols = Math.ceil(w / this._cfg.tile);
    this._rows = Math.ceil(h / this._cfg.tile);
    this._prev = new Uint32Array(this._cols * this._rows);
  }

  private _extractRaw(rgba: RGBA, x: number, y: number, w: number, h: number): Buffer {
    const out = Buffer.allocUnsafe(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      const src = ((y + yy) * rgba.width + x) * 4;
      rgba.data.copy(out, yy * w * 4, src, src + w * 4);
    }
    return out;
  }

  private async _encode(rawRgba: Buffer, w: number, h: number, enc: Encoding): Promise<Buffer> {
    switch (enc) {
      case Encoding.JPEG:   return this._encodeJPEG(rawRgba, w, h);
      case Encoding.RAW565: return this._encodeRAW565(rawRgba);
      default:              return this._encodeJPEG(rawRgba, w, h);
    }
  }

  private async _encodeJPEG(rawRgba: Buffer, w: number, h: number): Promise<Buffer> {
    return sharp(rawRgba, { raw: { width: w, height: h, channels: 4 } })
      .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: "4:2:0" })
      .toBuffer();
  }

  private _encodeRAW565(rawRgba: Buffer): Buffer {
    const pxCount = rawRgba.length >> 2;
    const out = Buffer.allocUnsafe(pxCount * 2);
    for (let i = 0, j = 0; i < pxCount; i++, j += 4) {
      const r = rawRgba[j];
      const g = rawRgba[j + 1];
      const b = rawRgba[j + 2];
      const v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
      out[i * 2] = v & 0xFF;
      out[i * 2 + 1] = (v >> 8) & 0xFF;
    }
    return out;
  }

  private _hash32(buf: Buffer): number {
    let h = 0x811C9DC5 >>> 0;
    for (let i = 0; i < buf.length; i += 16) {
      h ^= buf[i];           h = (h * 0x01000193) >>> 0;
      h ^= buf[i + 4] ?? 0;  h = (h * 0x01000193) >>> 0;
      h ^= buf[i + 8] ?? 0;  h = (h * 0x01000193) >>> 0;
      h ^= buf[i + 12] ?? 0; h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
}
