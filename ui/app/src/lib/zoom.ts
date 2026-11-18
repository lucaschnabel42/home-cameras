// Pinch-zoom and pan of a video inside its frame. The view is a CSS transform
// `translate(x, y) scale(s)` with transform-origin at the top left, so a point
// p of the picture shows at x + s * p. All values are in CSS pixels of the
// frame.

export interface View {
  s: number;
  x: number;
  y: number;
}
export interface Box {
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}

export const IDENTITY: View = { s: 1, x: 0, y: 0 };

/** Scale in [1, max], and no empty space past any edge of the picture. */
export function clampView(v: View, box: Box, max: number): View {
  const s = Math.min(max, Math.max(1, v.s));
  if (s === 1) return IDENTITY;
  const clamp = (val: number, size: number) => Math.min(0, Math.max(size - s * size, val));
  return { s, x: clamp(v.x, box.w), y: clamp(v.y, box.h) };
}

/**
 * Two fingers: the scale follows the distance between them, and the picture
 * point that was under their midpoint at the start stays under it.
 */
export function pinch(start: View, startMid: Point, startDist: number, mid: Point, dist: number, box: Box, max: number): View {
  const s = Math.min(max, Math.max(1, start.s * (dist / Math.max(1, startDist))));
  const px = (startMid.x - start.x) / start.s;
  const py = (startMid.y - start.y) / start.s;
  return clampView({ s, x: mid.x - s * px, y: mid.y - s * py }, box, max);
}

/** One finger moves a zoomed picture; at 1x there is nothing to move. */
export function pan(start: View, dx: number, dy: number, box: Box, max: number): View {
  if (start.s <= 1) return IDENTITY;
  return clampView({ s: start.s, x: start.x + dx, y: start.y + dy }, box, max);
}
