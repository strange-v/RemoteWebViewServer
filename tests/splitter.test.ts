import { describe, it, expect } from 'vitest';
import { splitFrameToCount } from '../src/utils/splitter';

type Tile = { x: number; y: number; w: number; h: number };

function expectWithinFrame(width: number, height: number, tiles: Tile[]) {
  for (const t of tiles) {
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.y).toBeGreaterThanOrEqual(0);
    expect(t.w).toBeGreaterThan(0);
    expect(t.h).toBeGreaterThan(0);
    expect(t.x + t.w).toBeLessThanOrEqual(width);
    expect(t.y + t.h).toBeLessThanOrEqual(height);
  }
}

function unique<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

describe('splitFrameToCount', () => {
  it('count=1 → single tile covering full frame', () => {
    const width = 800;
    const height = 480;
    const tiles = splitFrameToCount(width, height, 1);

    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toEqual({ x: 0, y: 0, w: width, h: height });
  });

  it('handles non-divisible dimensions (last row/column smaller)', () => {
    const width = 803;
    const height = 482;
    const count = 4;

    const tiles = splitFrameToCount(width, height, count);
    expect(tiles).toHaveLength(count); // will FAIL with current bug

    const tileW = Math.ceil(width / count);   // 201
    const tileH = Math.ceil(height / count);  // 121

    // bottom-right tile should start at (tileW*(count-1), tileH*(count-1))
    const brX = tileW * (count - 1); // 603
    const brY = tileH * (count - 1); // 363

    const bottomRight = tiles.find(t => t.x === brX && t.y === brY);
    expect(bottomRight).toBeTruthy();

    // last column/row widths/heights are the remainder
    expect(bottomRight!.w).toBe(width - brX);   // 803 - 603 = 200
    expect(bottomRight!.h).toBe(height - brY);  // 482 - 363 = 119

    expectWithinFrame(width, height, tiles);
  });

  it('stress cases: count=6 and count=8 on 800×480', () => {
    const width = 800;
    const height = 480;

    for (const count of [6, 8]) {
      const tiles = splitFrameToCount(width, height, count);
      expect(tiles).toHaveLength(count * count);

      const xs = unique(tiles.map(t => t.x));
      const ys = unique(tiles.map(t => t.y));
      expect(xs).toHaveLength(count);
      expect(ys).toHaveLength(count);

      expectWithinFrame(width, height, tiles);
    }
  });
});
