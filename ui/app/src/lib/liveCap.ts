// Which tiles of a grid play live video. Each live tile holds one socket and
// one video decoder, so a grid of 16 cameras cannot play all of them at once
// on a phone. The other tiles show the latest still (StillTile).

/** Live tiles at one time on a touch screen (a phone or a tablet). */
export const LIVE_CAP_TOUCH = 4;
/** Live tiles at one time with a mouse (a desktop or a laptop). */
export const LIVE_CAP_DESKTOP = 9;

export interface LiveCandidate {
  name: string;
  /** False for an offline camera and for a stream that plays only on demand. */
  canPlay: boolean;
}

/**
 * The names of the tiles that play live, at most `cap`. The order of
 * priority: the spotlight tile, then the cameras with an active detection
 * (newest first, as `active` gives them), then the tiles in grid order.
 */
export function pickLive(tiles: LiveCandidate[], cap: number, opts: { spotlight?: string | null; active?: string[] } = {}): Set<string> {
  const playable = new Set(tiles.filter((t) => t.canPlay).map((t) => t.name));
  const out = new Set<string>();
  const add = (name: string | null | undefined) => {
    if (name && out.size < cap && playable.has(name)) out.add(name);
  };
  add(opts.spotlight);
  for (const name of opts.active ?? []) add(name);
  for (const t of tiles) add(t.name);
  return out;
}
