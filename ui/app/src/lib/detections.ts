// Live activity for the security wall: which cameras have a detection now,
// the newest events of all cameras, and the "follow activity" rule that moves
// the spotlight.
import { reviewLabels, type ReviewItem } from "./feed";

/** A Frigate review item that has not ended: something is in view now. */
export interface ActiveDetection {
  id: string;
  camera: string;
  start: number;
  labels: string[];
}

/**
 * An item open for longer than this is not shown as active. Frigate ends a
 * review item when the object leaves; an item that a restart left open would
 * otherwise mark its camera for ever.
 */
export const MAX_ACTIVE_S = 3 * 3600;

/** One active detection for each camera (the newest), newest first. */
export function activeDetections(reviews: ReviewItem[], nowS: number): ActiveDetection[] {
  const byCamera = new Map<string, ActiveDetection>();
  for (const r of reviews) {
    if (r.end_time !== null || nowS - r.start_time > MAX_ACTIVE_S) continue;
    const old = byCamera.get(r.camera);
    if (!old || r.start_time > old.start) byCamera.set(r.camera, { id: r.id, camera: r.camera, start: r.start_time, labels: reviewLabels(r) });
  }
  return [...byCamera.values()].sort((a, b) => b.start - a.start);
}

/** Two lists of review items as one, by id; an item in `fresh` replaces the same item in `old`. */
export function mergeReviews(old: ReviewItem[], fresh: ReviewItem[]): ReviewItem[] {
  const out = new Map(old.map((r) => [r.id, r]));
  for (const r of fresh) out.set(r.id, r);
  return [...out.values()];
}

/** The newest `n` review items of all cameras, newest first. */
export function newestEvents(reviews: ReviewItem[], n: number): ReviewItem[] {
  return [...reviews].sort((a, b) => b.start_time - a.start_time).slice(0, n);
}

/** After the detection on the spotlight camera ends, the spotlight stays this long. */
export const HOLD_MS = 10_000;
/** The spotlight stays at least this long on a camera before a newer detection takes it. */
export const DWELL_MS = 8_000;
/** A camera that the person picks keeps the spotlight this long, whatever happens. */
export const MANUAL_MS = 30_000;

export interface Follow {
  camera: string | null;
  movedAt: number;
  /** The last time the spotlight camera had an active detection. */
  lastActiveAt: number;
  /** Nothing moves the spotlight before this time (a manual pick). */
  holdUntil: number;
}

export const startFollow = (camera: string | null): Follow => ({ camera, movedAt: -Infinity, lastActiveAt: -Infinity, holdUntil: 0 });

/** The person picked a camera: it keeps the spotlight for MANUAL_MS. */
export const pickCamera = (camera: string, nowMs: number): Follow => ({ camera, movedAt: nowMs, lastActiveAt: -Infinity, holdUntil: nowMs + MANUAL_MS });

/**
 * One step of "follow activity". `active` is newest first (activeDetections).
 * The spotlight goes to the camera with the newest active detection. It stays
 * while that detection lasts and for HOLD_MS after it ends. A newer
 * detection on another camera takes the spotlight only after DWELL_MS, so two
 * busy cameras do not make the spotlight jump back and forth.
 */
export function followStep(f: Follow, active: ActiveDetection[], nowMs: number): Follow {
  const current = active.find((a) => a.camera === f.camera);
  const kept = current ? { ...f, lastActiveAt: nowMs } : f;
  if (nowMs < f.holdUntil) return kept;
  const newest = active[0];
  if (!newest || newest.camera === f.camera) return kept;
  const move: Follow = { camera: newest.camera, movedAt: nowMs, lastActiveAt: nowMs, holdUntil: 0 };
  if (current) return newest.start > current.start && nowMs - f.movedAt >= DWELL_MS ? move : kept;
  return nowMs - f.lastActiveAt < HOLD_MS ? kept : move;
}
