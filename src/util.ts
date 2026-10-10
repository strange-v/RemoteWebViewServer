export type Rotation = 0 | 90 | 180 | 270;

export function getRotatedDimensions(
  width: number,
  height: number,
  rotation: Rotation
): { width: number; height: number } {
  if (rotation === 90 || rotation === 270) {
    return { width: height, height: width };
  }
  return { width, height };
}

export function mapPointForRotation(
  xd: number, yd: number,
  srcW: number, srcH: number, // розмір сторінки у Chrome (до ротації)
  rotation: Rotation
): { x: number; y: number } {
  switch (rotation) {
    case 0:   return { x: xd,            y: yd };
    case 90:  return { x: yd,            y: srcH - 1 - xd };
    case 180: return { x: srcW - 1 - xd, y: srcH - 1 - yd };
    case 270: return { x: srcW - 1 - yd, y: xd };
  }
}

// CSS viewport for a device of width x height physical px shown at the given scale.
export function getScaledViewport(
  width: number,
  height: number,
  scale: number
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(width / scale)),
    height: Math.max(1, Math.round(height / scale)),
  };
}
