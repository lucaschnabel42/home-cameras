// How many cameras go in one row, on the home screen and on the security wall.

/** The gap between two tiles, in CSS pixels. styles.css uses the same values. */
export const HOME_GAP = 12;
export const WALL_GAP = 6;
/** A home tile is never narrower than this, so its picture stays readable. */
const HOME_MIN_TILE = 150;

/** A camera narrower than it is high (a doorbell) takes two rows of the wall. */
export const isTall = (aspect: number) => aspect < 1;

/**
 * Columns for the live tiles of the home screen, in a box `width` wide.
 * One or two cameras on a phone keep the stacked layout of full-width tiles.
 * Up to four cameras get two columns; more get a near-square grid (9 gives
 * 3 x 3, 16 gives 4 x 4) when the width allows it.
 */
export function homeColumns(count: number, width: number): number {
  if (count <= 1) return 1;
  const fit = Math.max(1, Math.floor((width + HOME_GAP) / (HOME_MIN_TILE + HOME_GAP)));
  if (count === 2 && width < 600) return 1;
  if (count <= 4) return Math.min(2, fit);
  return Math.max(1, Math.min(fit, Math.ceil(Math.sqrt(count))));
}

export interface WallLayout {
  cols: number;
  rows: number;
  /** The width of the picture of a 16:9 camera in this layout. */
  tileWidth: number;
}

/**
 * The grid of the security wall: all cameras on one screen with no scroll.
 * Each cell is one row high; a tall camera takes two cells, one above the
 * other. The layout picks the column count that gives the largest 16:9
 * picture in a box of `width` x `height`. On a tie it picks the layout with
 * fewer empty cells.
 */
export function wallLayout(aspects: number[], width: number, height: number, gap = WALL_GAP): WallLayout {
  const n = aspects.length;
  if (n === 0 || width <= 0 || height <= 0) return { cols: 1, rows: 1, tileWidth: 0 };
  const tall = aspects.filter(isTall).length;
  const cells = n + tall;
  let best: WallLayout & { empty: number } = { cols: 1, rows: cells, tileWidth: -1, empty: 0 };
  for (let cols = 1; cols <= n; cols++) {
    // A tall camera needs two rows, so a layout of one row cannot hold it.
    const rows = Math.max(Math.ceil(cells / cols), tall > 0 ? 2 : 1);
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    const tileWidth = Math.min(cellW, (cellH * 16) / 9);
    const empty = cols * rows - cells;
    if (tileWidth > best.tileWidth + 0.5 || (Math.abs(tileWidth - best.tileWidth) <= 0.5 && empty < best.empty)) {
      best = { cols, rows, tileWidth, empty };
    }
  }
  return { cols: best.cols, rows: best.rows, tileWidth: Math.floor(best.tileWidth) };
}
