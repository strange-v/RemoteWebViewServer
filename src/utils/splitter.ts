export type Tile = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export function splitFrameToCount(width: number, height: number, count: number): Tile[] {
  const tiles: Tile[] = [];

  let tileWidth = Math.ceil(width / Math.sqrt(count));
  let tileHeight = Math.ceil(height / Math.sqrt(count));

  let x = 0;
  let y = 0;
  while (y < height) {
    while (x < width) {
      const tile = {
        x: x,
        y: y,
        w: Math.min(tileWidth, width - x),
        h: Math.min(tileHeight, height - y),
      };
      tiles.push(tile);
      x += tileWidth;
    }
    y += tileHeight;
    x = 0;
  }

  return tiles;
}