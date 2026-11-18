// Maps wall-clock times to positions in an exported clip.
//
// Frigate cuts an export from its recording segments through the VOD
// playlist, so clip time 0 is the window start and a gap in the recordings
// (a Frigate restart, a dropped stream) is simply missing from the file. Times
// therefore map through the real segments, not by subtraction. Positions are
// good to about a keyframe interval (1 to 2 s on the Wyze streams).

export interface Segment {
  start_time: number;
  end_time: number;
  /** Frigate's motion count for the 10 s segment. */
  motion: number;
  objects: number;
}

export interface ClipMap {
  pieces: { wallStart: number; wallEnd: number; clipStart: number }[];
  duration: number;
}

export interface Moment {
  /** The Frigate review id, when the moment came from a review item. */
  id?: string;
  start: number;
  end: number;
  labels: string[];
}

export interface ReviewTimes {
  id?: string;
  start_time: number;
  end_time: number | null;
  data: { objects: string[]; audio?: string[] };
}

/** Seconds of lead before the first detection when a clip starts. */
export const LEAD_S = 5;
/** Seconds of lead before an event the person chose in the feed. */
export const EVENT_LEAD_S = 2;

export function buildClipMap(segments: Segment[], windowStart: number, windowEnd: number): ClipMap {
  const spans = segments
    .map((s) => [Math.max(s.start_time, windowStart), Math.min(s.end_time, windowEnd)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) {
    return { pieces: [{ wallStart: windowStart, wallEnd: windowEnd, clipStart: 0 }], duration: windowEnd - windowStart };
  }
  let clip = 0;
  const pieces = spans.map(([s, e]) => {
    const p = { wallStart: s, wallEnd: e, clipStart: clip };
    clip += e - s;
    return p;
  });
  return { pieces, duration: clip };
}

/** Clip seconds for a wall time. A time inside a gap maps to where recording resumes. */
export function wallToClip(map: ClipMap, t: number): number {
  for (const p of map.pieces) {
    if (t < p.wallStart) return p.clipStart;
    if (t <= p.wallEnd) return p.clipStart + (t - p.wallStart);
  }
  return map.duration;
}

/** Wall time for a clip position. */
export function clipToWall(map: ClipMap, c: number): number {
  for (const p of map.pieces) {
    const len = p.wallEnd - p.wallStart;
    if (c <= p.clipStart + len) return p.wallStart + Math.max(0, c - p.clipStart);
  }
  return map.pieces[map.pieces.length - 1].wallEnd;
}

/** Review items inside the clip, as clip-time ranges, earliest first. */
export function momentsFor(map: ClipMap, reviews: ReviewTimes[]): Moment[] {
  const wStart = map.pieces[0].wallStart;
  const wEnd = map.pieces[map.pieces.length - 1].wallEnd;
  return reviews
    .filter((r) => r.start_time < wEnd && (r.end_time ?? wEnd) > wStart)
    .map((r) => ({
      ...(r.id === undefined ? {} : { id: r.id }),
      start: wallToClip(map, r.start_time),
      end: wallToClip(map, r.end_time ?? wEnd),
      labels: [...r.data.objects, ...(r.data.audio ?? [])],
    }))
    .sort((a, b) => a.start - b.start);
}

/** Where playback starts: LEAD_S before the first moment, or 0. */
export function startTime(moments: Moment[], lead = LEAD_S): number {
  return moments.length ? Math.max(0, moments[0].start - lead) : 0;
}

/**
 * Where playback starts, in clip seconds. With startAt (the wall time of the
 * event the person chose), EVENT_LEAD_S before that event, mapped through the
 * real segments and clamped to the clip. With no timeline, the window gives
 * the position by subtraction (a recording gap then shifts it). With no
 * startAt, LEAD_S before the first moment.
 */
export function playStart({
  map,
  moments,
  startAt,
  window,
}: {
  map: ClipMap | null;
  moments: Moment[];
  startAt?: number | null;
  window: { start: number; end: number } | null;
}): number {
  if (startAt === undefined || startAt === null) return startTime(moments);
  if (map) return Math.min(map.duration, Math.max(0, wallToClip(map, startAt) - EVENT_LEAD_S));
  if (!window) return 0;
  return Math.min(window.end - window.start, Math.max(0, startAt - window.start - EVENT_LEAD_S));
}

/**
 * The title for the playhead at clip second t: the moment that started last
 * (a moment counts from EVENT_LEAD_S before its start, where a chosen event
 * begins to play). Between moments the title stays until a new moment starts,
 * so the pill does not flicker. Before the first moment, the fallback.
 */
export function titleAt(moments: Moment[], t: number, titleOf: (m: Moment) => string, fallback: string, lead = EVENT_LEAD_S): string {
  let hit: Moment | null = null;
  for (const m of moments) if (m.start - lead - 0.5 <= t && (!hit || m.start >= hit.start)) hit = m;
  return hit ? titleOf(hit) : fallback;
}

/**
 * Motion over the clip in `bins` equal slices, 0 to 1. Each slice takes the
 * highest motion count of the segments it touches, scaled to the clip's peak.
 */
export function motionBins(map: ClipMap, segments: Segment[], bins: number): number[] {
  const out = new Array<number>(bins).fill(0);
  if (map.duration <= 0) return out;
  const width = map.duration / bins;
  const wStart = map.pieces[0].wallStart;
  const wEnd = map.pieces[map.pieces.length - 1].wallEnd;
  for (const s of segments) {
    const a = Math.max(s.start_time, wStart);
    const b = Math.min(s.end_time, wEnd);
    if (b <= a || s.motion <= 0) continue;
    const c0 = wallToClip(map, a);
    const c1 = wallToClip(map, b);
    const first = Math.min(bins - 1, Math.floor(c0 / width));
    const last = Math.min(bins - 1, Math.max(first, Math.ceil(c1 / width) - 1));
    for (let i = first; i <= last; i++) out[i] = Math.max(out[i], s.motion);
  }
  const peak = Math.max(...out);
  return peak > 0 ? out.map((v) => v / peak) : out;
}
