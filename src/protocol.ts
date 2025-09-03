export const FRAM_MAGIC = "FRAM";
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

export function parseTouchPacket(buf: Buffer): TouchPacket | null {
  if (!Buffer.isBuffer(buf) || buf.length < 9) return null;
  if (buf.readUInt32BE(0) !== 0x544F5543) return null; // 'TOUC'

  const kind = buf.readUInt8(4);
  const x = buf.readUInt16LE(5);
  const y = buf.readUInt16LE(7);
  if (kind > 3) return null;

  return { kind, x, y };
}

export function buildFramPacket(rects: Rect[], frameId: number, enc: Encoding, flags = 0): Buffer {
  const count = rects.length;
  // Header: "FRAM"[4] | ver u8 | frame_id u32 | enc u8 | count u16 | flags u16
  const parts: Buffer[] = [];
  const header = Buffer.alloc(4 + 1 + 4 + 1 + 2 + 2);
  header.write(FRAM_MAGIC, 0);
  header.writeUInt8(FRAM_VERSION, 4);
  header.writeUInt32LE(frameId >>> 0, 5);
  header.writeUInt8(enc, 9);
  header.writeUInt16LE(count, 10);
  header.writeUInt16LE(flags, 12);
  parts.push(header);

  for (const rect of rects) {
    // Rect: x u16 | y u16 | w u16 | h u16 | data_len u32 | data...
    const rh = Buffer.alloc(2 + 2 + 2 + 2 + 4);
    rh.writeUInt16LE(rect.x, 0);
    rh.writeUInt16LE(rect.y, 2);
    rh.writeUInt16LE(rect.w, 4);
    rh.writeUInt16LE(rect.h, 6);
    rh.writeUInt32LE(rect.data.length, 8);
    parts.push(rh, rect.data);
  }
  return Buffer.concat(parts);
}
