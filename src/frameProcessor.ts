import sharp from "sharp";

export type RGBA = { data: Buffer; width: number; height: number };

export type Rect = { x: number; y: number; w: number; h: number; data: Buffer };

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

  constructor(cfg: TilesCfg) {
    this._cfg = cfg;
  }

  public async processFrameAsync(rgba: RGBA): Promise<Rect[]> {
    if (!this._prev) this._initGrid(rgba.width, rgba.height);

    const full = (this._iter % this._cfg.fullEvery) === 0;
    const out: Rect[] = [];

    for (let ty = 0; ty < this._rows; ty++) {
      for (let tx = 0; tx < this._cols; tx++) {
        const x = tx * this._cfg.tile;
        const y = ty * this._cfg.tile;
        const w = Math.min(this._cfg.tile, rgba.width  - x);
        const h = Math.min(this._cfg.tile, rgba.height - y);

        const tileRaw = this._extractRaw(rgba, x, y, w, h);
        const h32 = this._hash32(tileRaw);

        if (!this._prev) continue;

        const idx = ty * this._cols + tx;
        if (full || this._prev[idx] !== h32) {
          const jpg = await sharp(tileRaw, { raw: { width: w, height: h, channels: 4 } })
            .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: "4:2:0" })
            .toBuffer();
          out.push({ x, y, w, h, data: jpg });
          this._prev[idx] = h32;
        }
      }
    }

    this._iter++;
    return out;
  }

  // ===== private =====

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

  // FNV-1a 32-bit (достатньо для дифу)
  private _hash32(buf: Buffer): number {
    let h = 0x811C9DC5 >>> 0;
    for (let i = 0; i < buf.length; i += 16) { // стрибаємо, щоб швидше
      h ^= buf[i];     h = (h * 0x01000193) >>> 0;
      h ^= buf[i + 4] ?? 0;  h = (h * 0x01000193) >>> 0;
      h ^= buf[i + 8] ?? 0;  h = (h * 0x01000193) >>> 0;
      h ^= buf[i + 12] ?? 0; h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
}
