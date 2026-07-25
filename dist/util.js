export function hash32(buf) {
    let h = 0x811C9DC5 >>> 0;
    for (let i = 0; i < buf.length; i += 16) {
        h ^= buf[i];
        h = (h * 0x01000193) >>> 0;
        h ^= buf[i + 4] ?? 0;
        h = (h * 0x01000193) >>> 0;
        h ^= buf[i + 8] ?? 0;
        h = (h * 0x01000193) >>> 0;
        h ^= buf[i + 12] ?? 0;
        h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
}
export function getRotatedDimensions(width, height, rotation) {
    if (rotation === 90 || rotation === 270) {
        return { width: height, height: width };
    }
    return { width, height };
}
export function mapPointForRotation(xd, yd, srcW, srcH, // розмір сторінки у Chrome (до ротації)
rotation) {
    switch (rotation) {
        case 0: return { x: xd, y: yd };
        case 90: return { x: yd, y: srcH - 1 - xd };
        case 180: return { x: srcW - 1 - xd, y: srcH - 1 - yd };
        case 270: return { x: srcW - 1 - yd, y: xd };
    }
}
