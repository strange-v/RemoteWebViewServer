export const FRAM_MAGIC = "FRAM";
export const FPST_MAGIC = "FPST";
export const FRAM_VERSION = 1 as const;
export const FLAG_LAST_OF_FRAME = 1 << 0;
export const FLAG_IS_FULL_FRAME = 1 << 1;

export enum Encoding {
  UNKNOWN = 0,
  PNG,
  JPEG,
  RAW565,
  RAW565_RLE,
  RAW565_LZ4
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
  data: Buffer
}

export interface Frame {
  frameId: number
  rects: Rect[]
}

export enum TouchKind {
  Down = 0,
  Move = 1,
  Up = 2,
  Tap = 3
}

export interface TouchPacket {
  kind: TouchKind
  x: number
  y: number
}

// Header: "FRAM"[4] | ver u8 | frame_id u32 | enc u8 | count u16 | flags u16
export const FRAM_HEADER_BYTES = Buffer.byteLength(FRAM_MAGIC) + 1 + 4 + 1 + 2 + 2; // = 14

// Rect header: x u16 | y u16 | w u16 | h u16 | data_len u32
export const FRAM_RECT_HEADER_BYTES = 2 + 2 + 2 + 2 + 4; // = 12

export function parseTouchPacket(buf: Buffer): TouchPacket | null {
  if (!Buffer.isBuffer(buf) || buf.length < 9) return null;
  if (buf.readUInt32BE(0) !== 0x544F5543) return null; // 'TOUC'

  const kind = buf.readUInt8(4);
  const x = buf.readUInt16LE(5);
  const y = buf.readUInt16LE(7);
  if (kind > 3) return null;

  return { kind, x, y };
}

export function parseFpsPacket(buf: Buffer): number | null {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return null;
  if (buf.readUInt32BE(0) !== 0x46505354) return null; // 'FPST'

  return buf.readUInt16LE(4);
}

export function buildFramPacket(rects: Rect[], enc: Encoding, frameId: number, flags = 0): Buffer {
  const count = rects.length;
  const parts: Buffer[] = [];
  const header = Buffer.alloc(FRAM_HEADER_BYTES);
  header.write(FRAM_MAGIC, 0);
  header.writeUInt8(FRAM_VERSION, 4);
  header.writeUInt32LE(frameId >>> 0, 5);
  header.writeUInt8(enc, 9);
  header.writeUInt16LE(count, 10);
  header.writeUInt16LE(flags, 12);
  parts.push(header);

  for (const rect of rects) {
    const rh = Buffer.alloc(FRAM_RECT_HEADER_BYTES);
    rh.writeUInt16LE(rect.x, 0);
    rh.writeUInt16LE(rect.y, 2);
    rh.writeUInt16LE(rect.w, 4);
    rh.writeUInt16LE(rect.h, 6);
    rh.writeUInt32LE(rect.data.length, 8);
    parts.push(rh, rect.data);
  }
  return Buffer.concat(parts);
}

export function buildFramPackets(rects: Rect[], enc: Encoding, frameId: number, isFullFrame: boolean, maxBytes: number): Buffer[] {
  const chunks: Rect[][] = [];
  let cur: Rect[] = [];
  let curBytes = FRAM_HEADER_BYTES;

  for (const rect of rects) {
    const rBytes = FRAM_RECT_HEADER_BYTES + rect.data.length;
    if (cur.length && curBytes + rBytes > maxBytes) {
      chunks.push(cur);
      cur = [];
      curBytes = FRAM_HEADER_BYTES;
    }
    cur.push(rect);
    curBytes += rBytes;
  }
  if (cur.length) chunks.push(cur);

  const packets: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    let flags = (i === chunks.length - 1) ? FLAG_LAST_OF_FRAME : 0;
    if (isFullFrame)
      flags |= FLAG_IS_FULL_FRAME;

    packets.push(buildFramPacket(chunks[i], enc, frameId, flags));
  }
  return packets;
}

export function buildFpsTestPacket(): Buffer {
  const data = Buffer.alloc(Buffer.byteLength(FPST_MAGIC) + 1);
  data.write(FPST_MAGIC, 0);
  data.writeUInt8(FRAM_VERSION, 4);
  return data;
}