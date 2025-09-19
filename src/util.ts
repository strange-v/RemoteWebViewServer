export function hash32(buf: Buffer): number {
  let h = 0x811C9DC5 >>> 0;
  for (let i = 0; i < buf.length; i += 16) {
    h ^= buf[i]; h = (h * 0x01000193) >>> 0;
    h ^= buf[i + 4] ?? 0; h = (h * 0x01000193) >>> 0;
    h ^= buf[i + 8] ?? 0; h = (h * 0x01000193) >>> 0;
    h ^= buf[i + 12] ?? 0; h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}
