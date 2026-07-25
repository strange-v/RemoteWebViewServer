import os from "node:os";
import sharp from "sharp";
import { Encoding, FRAME_HEADER_BYTES, TILE_HEADER_BYTES } from "./protocol.js";
import { hash32 } from "./util.js";
sharp.concurrency(Math.max(1, os.cpus().length - 1));
export class FrameProcessor {
    constructor(cfg) {
        this._cols = 0;
        this._rows = 0;
        this._iter = 0;
        this._fullFrameRequested = false;
        this._cfg = cfg;
    }
    requestFullFrame() {
        this._iter = 0;
        this._fullFrameRequested = true;
    }
    async processFrameAsync(rgba) {
        if (!this._prev)
            this._initGrid(rgba.width, rgba.height);
        let forceFull = (this._iter % this._cfg.fullFrameEvery) === 0;
        if (this._fullFrameRequested) {
            forceFull = true;
            this._fullFrameRequested = false;
        }
        const chosenEncoding = Encoding.JPEG;
        const tiles = [];
        let changedArea = 0;
        for (let ty = 0; ty < this._rows; ty++) {
            for (let tx = 0; tx < this._cols; tx++) {
                const x = tx * this._cfg.tileSize;
                const y = ty * this._cfg.tileSize;
                const w = Math.min(this._cfg.tileSize, rgba.width - x);
                const h = Math.min(this._cfg.tileSize, rgba.height - y);
                const raw = this._extractRaw(rgba, x, y, w, h);
                const h32 = hash32(raw);
                const idx = ty * this._cols + tx;
                const prev = this._prev[idx];
                const changed = forceFull || (prev !== h32);
                tiles.push({ x, y, w, h, idx, h32, changed });
                if (changed)
                    changedArea += w * h;
            }
        }
        const totalArea = rgba.width * rgba.height;
        const changedPct = totalArea > 0 ? (changedArea / totalArea) : 0;
        const doFull = forceFull || (changedPct > this._cfg.fullframeAreaThreshold);
        let out;
        if (doFull) {
            out = await this._processFullFrame(rgba, tiles, chosenEncoding);
        }
        else {
            out = await this._processPartialFrame(rgba, tiles, chosenEncoding);
        }
        const maxBytesPerTile = this._cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
        for (let i = 0; i < out.rects.length; i++) {
            const r = out.rects[i];
            if (r.data.length > maxBytesPerTile) {
                const redData = await this._makeRedFrameAsync(r.w, r.h, chosenEncoding);
                out.rects[i] = { x: r.x, y: r.y, w: r.w, h: r.h, data: redData };
            }
        }
        this._iter++;
        return out;
    }
    async _processFullFrame(rgba, tilesInfo, encoding) {
        const rectsForFull = this._splitWholeFrame(rgba.width, rgba.height, this._cfg.fullframeTileCount);
        const rects = [];
        for (const r of rectsForFull) {
            const raw = this._extractRaw(rgba, r.x, r.y, r.w, r.h);
            const data = await this._encode(raw, r.w, r.h, encoding);
            rects.push({ x: r.x, y: r.y, w: r.w, h: r.h, data });
        }
        for (const t of tilesInfo)
            this._prev[t.idx] = t.h32;
        return { rects, isFullFrame: true, encoding };
    }
    async _processPartialFrame(rgba, tiles, encoding) {
        const mergedRects = this._mergeChangedTiles(tiles, rgba.width, rgba.height);
        const out = [];
        for (const r of mergedRects) {
            const raw = this._extractRaw(rgba, r.x, r.y, r.w, r.h);
            const data = await this._encode(raw, r.w, r.h, encoding);
            out.push({ ...r, data });
        }
        for (const t of tiles)
            if (t.changed)
                this._prev[t.idx] = t.h32;
        return { rects: out, isFullFrame: false, encoding };
    }
    _splitWholeFrame(w, h, n) {
        if (n <= 1)
            return [{ x: 0, y: 0, w, h }];
        if (n === 2) {
            const h1 = Math.floor(h / 2);
            const h2 = h - h1;
            return [
                { x: 0, y: 0, w, h: h1 },
                { x: 0, y: h1, w, h: h2 },
            ];
        }
        let rows = Math.floor(Math.sqrt(n));
        while (rows > 1 && (n % rows !== 0))
            rows--;
        const cols = Math.floor(n / rows);
        const split = (size, parts) => {
            const out = [];
            let prev = 0;
            for (let i = 1; i <= parts; i++) {
                const cur = Math.floor((i * size) / parts);
                out.push(cur - prev);
                prev = cur;
            }
            return out;
        };
        const widths = split(w, cols);
        const heights = split(h, rows);
        const rects = [];
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
    _getMaxFullTileSize(frameW, frameH) {
        const fullRects = this._splitWholeFrame(frameW, frameH, this._cfg.fullframeTileCount);
        let maxW = 0, maxH = 0;
        for (const r of fullRects) {
            if (r.w > maxW)
                maxW = r.w;
            if (r.h > maxH)
                maxH = r.h;
        }
        return { maxW, maxH };
    }
    _calcGridSplits(frameW, frameH) {
        const cols = this._cols, rows = this._rows, ts = this._cfg.tileSize;
        const widths = new Array(cols);
        const heights = new Array(rows);
        const xOffsets = new Array(cols);
        const yOffsets = new Array(rows);
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
    _mergeChangedTiles(tiles, frameW, frameH) {
        const cols = this._cols, rows = this._rows;
        const changed = Array.from({ length: rows }, () => Array(cols).fill(false));
        const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
        for (let i = 0; i < tiles.length; i++) {
            const ty = Math.floor(i / cols);
            const tx = i % cols;
            changed[ty][tx] = tiles[i].changed;
        }
        const { widths, heights, xOffsets, yOffsets } = this._calcGridSplits(frameW, frameH);
        const { maxW, maxH } = this._getMaxFullTileSize(frameW, frameH);
        const rects = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (!changed[r][c] || visited[r][c])
                    continue;
                // grow horizontally
                let wTiles = 0, pxW = 0;
                while (c + wTiles < cols && changed[r][c + wTiles] && !visited[r][c + wTiles]) {
                    const nextW = pxW + widths[c + wTiles];
                    if (nextW > maxW)
                        break;
                    pxW = nextW;
                    wTiles++;
                }
                // grow vertically
                let hTiles = 1, pxH = heights[r];
                let canGrow = true;
                while (canGrow && (r + hTiles) < rows) {
                    const nextH = pxH + heights[r + hTiles];
                    if (nextH > maxH)
                        break;
                    for (let cc = c; cc < c + wTiles; cc++) {
                        if (!changed[r + hTiles][cc] || visited[r + hTiles][cc]) {
                            canGrow = false;
                            break;
                        }
                    }
                    if (!canGrow)
                        break;
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
    _initGrid(w, h) {
        this._cols = Math.ceil(w / this._cfg.tileSize);
        this._rows = Math.ceil(h / this._cfg.tileSize);
        this._prev = new Uint32Array(this._cols * this._rows);
    }
    _extractRaw(rgba, x, y, w, h) {
        const out = Buffer.allocUnsafe(w * h * 4);
        for (let yy = 0; yy < h; yy++) {
            const src = ((y + yy) * rgba.width + x) * 4;
            rgba.data.copy(out, yy * w * 4, src, src + w * 4);
        }
        return out;
    }
    async _encode(rawRgba, w, h, enc) {
        switch (enc) {
            case Encoding.JPEG:
                return this._encodeJPEG(rawRgba, w, h);
            case Encoding.RAW565:
                return this._encodeRAW565(rawRgba);
            default:
                return this._encodeJPEG(rawRgba, w, h);
        }
    }
    async _encodeJPEG(rawRgba, w, h) {
        return sharp(rawRgba, { raw: { width: w, height: h, channels: 4 } })
            .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: "4:2:0" })
            .toBuffer();
    }
    _encodeRAW565(rawRgba) {
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
    async _makeRedFrameAsync(w, h, enc) {
        const raw = Buffer.allocUnsafe(w * h * 4);
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const RGBA_RED = 0xFF0000FF; // bytes: FF 00 00 FF
        for (let o = 0; o < raw.length; o += 4)
            view.setUint32(o, RGBA_RED, true);
        return this._encode(raw, w, h, enc);
    }
}
