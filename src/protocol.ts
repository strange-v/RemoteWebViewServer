// Remote WebView binary protocol (v1)
// Layout (LE unless stated otherwise):
// Frame message:
//   [type u8=1][ver u8=1][frame_id u32][enc u8][tile_count u16][flags u16]
//   followed by `tile_count` tiles, each:
//   [x u16][y u16][w u16][h u16][data_len u32][data bytes...]
//
// Touch message:
//   [type u8=2][ver u8=1][subtype u8][pointer_id u8][x u16][y u16]
//
// FrameStats message:
//   [type u8=3][ver u8=1][frame_render_time_ms u16]
//

export const PROTOCOL_VERSION = 1 as const;

export enum MsgType {
  Unknown = 0,
  Frame = 1,
  Touch = 2,
  FrameStats = 3,
  OpenURL = 4,
}

export enum Encoding {
  UNKNOWN   = 0,
  PNG       = 1,
  JPEG      = 2,
  RAW565    = 3,
  RAW565_RLE= 4,
  RAW565_LZ4= 5
}

export enum TouchKind {
  Unknown   = 0,
  Down      = 1,
  Move      = 2,
  Up        = 3,
  Tap       = 4,
}

export const FLAG_LAST_OF_FRAME = 1 << 0;
export const FLAG_IS_FULL_FRAME = 1 << 1;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  data: Buffer;
}

export interface Frame {
  frameId: number;
  enc: Encoding;
  flags: number;
  rects: Rect[];
}

export interface TouchPacket {
  kind: TouchKind;
  pointerId: number;
  x: number;
  y: number;
}

export const FRAME_HEADER_BYTES = 1 + 1 + 4 + 1 + 2 + 2;  // 11
export const TILE_HEADER_BYTES  = 2 + 2 + 2 + 2 + 4;      // 12
export const TOUCH_BYTES        = 1 + 1 + 1 + 1 + 2 + 2;  // 8
export const FRAME_STATS_BYTES  = 1 + 1 + 2;              // 4
export const OPENURL_HEADER_BYTES = 1 + 1 + 2 + 4;

const clampU16 = (v: number) => (v < 0 ? 0 : v > 0xffff ? 0xffff : v|0);

export function buildTouchPacket(kind: TouchKind, x: number, y: number, pointerId = 0): Buffer {
  const buf = Buffer.alloc(TOUCH_BYTES);
  buf.writeUInt8(MsgType.Touch, 0);
  buf.writeUInt8(PROTOCOL_VERSION, 1);
  buf.writeUInt8(kind, 2);
  buf.writeUInt8(pointerId & 0xff, 3);
  buf.writeUInt16LE(clampU16(x), 4);
  buf.writeUInt16LE(clampU16(y), 6);
  return buf;
}

export function parseTouchPacket(buf: Buffer): TouchPacket | null {
  if (!Buffer.isBuffer(buf) || buf.length < TOUCH_BYTES) return null;
  if (buf.readUInt8(0) !== MsgType.Touch) return null;
  if (buf.readUInt8(1) !== PROTOCOL_VERSION) return null;
  
  const kind = buf.readUInt8(2);
  if (kind > TouchKind.Up) return null;
  
  const pointerId = buf.readUInt8(3);
  const x = buf.readUInt16LE(4);
  const y = buf.readUInt16LE(6);
  
  return { kind, pointerId, x, y };
}

export function parseFrameStatsPacket(buf: Buffer): number | null {
  if (!Buffer.isBuffer(buf) || buf.length < FRAME_STATS_BYTES) return null;
  if (buf.readUInt8(0) !== MsgType.FrameStats) return null;
  if (buf.readUInt8(1) !== PROTOCOL_VERSION) return null;

  return buf.readUInt16LE(2);
}

export function parseOpenURLPacket(buf: Buffer): { flags: number; url: string } | null {
  if (!Buffer.isBuffer(buf) || buf.length < OPENURL_HEADER_BYTES) return null;
  if (buf.readUInt8(0) !== MsgType.OpenURL) return null;
  if (buf.readUInt8(1) !== PROTOCOL_VERSION) return null;

  const flags = buf.readUInt16LE(2);
  const len   = buf.readUInt32LE(4);
  
  if (OPENURL_HEADER_BYTES + len > buf.length) return null;
  const url = buf.subarray(OPENURL_HEADER_BYTES, OPENURL_HEADER_BYTES + len).toString("utf8");
  
  return { flags, url };
}

export function buildFrameStatsPacket(): Buffer {
  const data = Buffer.alloc(FRAME_STATS_BYTES);
  
  data.writeUInt8(MsgType.FrameStats, 0);
  data.writeUInt8(PROTOCOL_VERSION, 1);
  data.writeUInt16LE(0, 2);
  
  return data;
}

export function buildFramePacket(rects: Rect[], enc: Encoding, frameId: number, flags = 0): Buffer {
  const count = rects.length;
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt8(MsgType.Frame, 0);
  header.writeUInt8(PROTOCOL_VERSION, 1);
  header.writeUInt32LE(frameId >>> 0, 2);
  header.writeUInt8(enc, 6);
  header.writeUInt16LE(count, 7);
  header.writeUInt16LE(flags, 9);

  const parts: Buffer[] = [header];
  for (const r of rects) {
    const rh = Buffer.alloc(TILE_HEADER_BYTES);
    rh.writeUInt16LE(r.x, 0);
    rh.writeUInt16LE(r.y, 2);
    rh.writeUInt16LE(r.w, 4);
    rh.writeUInt16LE(r.h, 6);
    rh.writeUInt32LE(r.data.length >>> 0, 8);
    parts.push(rh, r.data);
  }
  return Buffer.concat(parts);
}

export function buildFramePackets(rects: Rect[], enc: Encoding, frameId: number, isFullFrame: boolean, maxBytes: number): Buffer[] {
  const chunks: Rect[][] = [];
  let cur: Rect[] = [];
  let curBytes = FRAME_HEADER_BYTES;

  for (const r of rects) {
    const rBytes = TILE_HEADER_BYTES + r.data.length;
    if (cur.length && curBytes + rBytes > maxBytes) {
      chunks.push(cur);
      cur = [];
      curBytes = FRAME_HEADER_BYTES;
    }
    cur.push(r);
    curBytes += rBytes;
  }
  if (cur.length) chunks.push(cur);

  const out: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    let flags = (i === chunks.length - 1) ? FLAG_LAST_OF_FRAME : 0;
    if (isFullFrame) flags |= FLAG_IS_FULL_FRAME;
    out.push(buildFramePacket(chunks[i], enc, frameId, flags));
  }
  return out;
}

export type ParsedFrameHeader = {
  frameId: number;
  enc: Encoding;
  tileCount: number;
  flags: number;
  payloadOffset: number;
};

export function parseFrameHeader(buf: Buffer): ParsedFrameHeader | null {
  if (!Buffer.isBuffer(buf) || buf.length < FRAME_HEADER_BYTES) return null;
  if (buf.readUInt8(0) !== MsgType.Frame) return null;
  if (buf.readUInt8(1) !== PROTOCOL_VERSION) return null;

  const frameId = buf.readUInt32LE(2);
  const enc = buf.readUInt8(6) as Encoding;
  const tileCount = buf.readUInt16LE(7);
  const flags = buf.readUInt16LE(9);

  return { frameId, enc, tileCount, flags, payloadOffset: FRAME_HEADER_BYTES };
}

export function* iterateTiles(buf: Buffer, startOffset = FRAME_HEADER_BYTES, expectedCount?: number):
  Generator<{ x:number; y:number; w:number; h:number; data:Buffer; nextOffset:number }, void, void> {
  let off = startOffset >>> 0;
  let seen = 0;
  while (off + TILE_HEADER_BYTES <= buf.length) {
    const x = buf.readUInt16LE(off + 0);
    const y = buf.readUInt16LE(off + 2);
    const w = buf.readUInt16LE(off + 4);
    const h = buf.readUInt16LE(off + 6);
    const dlen = buf.readUInt32LE(off + 8);
    off += TILE_HEADER_BYTES;
    if (off + dlen > buf.length) break;
    const data = buf.subarray(off, off + dlen);
    off += dlen;
    seen++;
    yield { x, y, w, h, data, nextOffset: off };
    if (expectedCount && seen >= expectedCount) break;
  }
}
