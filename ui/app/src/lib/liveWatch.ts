// The stall watch for one live tile, as a pure step function so that a test
// can drive it with a clock. LiveVideo.tsx calls liveStep once a second with
// a sample of the video element and applies the result.

export const STALL_MS = 3000;
/** Frames stopped this long after playing: force a reconnect (the socket may be open). */
export const FROZEN_MS = 10_000;
/** No frame at all this long: say so instead of "Connecting" forever. */
export const GIVE_UP_MS = 30_000;

export type LiveStatus = "playing" | "connecting" | "reconnecting" | "failed";

/** What the tile reads from the video element on each tick. */
export interface LiveSample {
  now: number;
  hidden: boolean;
  /** video.readyState, or -1 when the element has no video yet. */
  readyState: number;
  currentTime: number;
}

export interface LiveWatch {
  opened: number;
  last: number;
  stalledSince: number;
  everPlayed: boolean;
  lastRestart: number;
  reported: boolean;
  status: LiveStatus;
  showStatus: boolean;
  /** The page was hidden at the last tick. */
  hidden: boolean;
  /** The video element holds a frame that it can draw. */
  hasFrame: boolean;
  /** The time in the still URL (&t=), so that a new value loads a new still. */
  stillAt: number;
}

export interface LiveStepResult {
  watch: LiveWatch;
  /** Write a live_stall line to the server log. */
  reportStall: boolean;
  /** Restart the stream (writes a live_restart line). */
  restart: boolean;
}

export function startWatch(now: number): LiveWatch {
  return {
    opened: now,
    last: -1,
    stalledSince: now,
    everPlayed: false,
    lastRestart: 0,
    reported: false,
    status: "connecting",
    showStatus: false,
    hidden: false,
    hasFrame: false,
    stillAt: now,
  };
}

/**
 * True when the tile shows the still in place of the video. A stall of a
 * stream that played keeps its last frame on screen, under the "Reconnecting"
 * label. The still shows only when the video has nothing to draw: before the
 * first frame, or after a restart or a long background cleared the source.
 */
export function showsStill(w: LiveWatch): boolean {
  return !w.hasFrame;
}

/**
 * The tile shows a different element (a change between the direct stream and
 * the clean stream, liveSource.ts). The stall clock starts again, so that a
 * new element gets its full time to connect before a forced restart.
 * `hasFrame` tells whether the new element holds a frame now. A stall that
 * was already reported is not reported a second time.
 */
export function watchNewElement(w: LiveWatch, now: number, hasFrame: boolean): LiveWatch {
  const next: LiveWatch = { ...w, last: -1, stalledSince: now, hasFrame };
  if (w.hasFrame && !hasFrame) next.stillAt = now;
  return next;
}

export function liveStep(w: LiveWatch, s: LiveSample): LiveStepResult {
  const none = { reportStall: false, restart: false };
  if (s.hidden) return { watch: w.hidden ? w : { ...w, hidden: true }, ...none };
  const now = s.now;
  const hasFrame = s.readyState >= 2;
  const moving = hasFrame && s.currentTime !== w.last;
  const next: LiveWatch = { ...w, last: s.currentTime, hasFrame, hidden: false };
  // Back from the background: the hidden time is not a stall, so the stall
  // clock (and the give-up clock of a stream that never played) starts again.
  if (w.hidden) {
    next.stalledSince = now;
    if (!w.everPlayed) next.opened = now;
  }
  // The video went blank after it played: the still from when the tile opened
  // can be hours old, so load a new one.
  if (w.hasFrame && !hasFrame) next.stillAt = now;
  if (moving) {
    return {
      watch: { ...next, everPlayed: true, stalledSince: 0, reported: false, status: "playing", showStatus: false },
      ...none,
    };
  }
  if (!next.stalledSince) next.stalledSince = now;
  const stalled = now - next.stalledSince;
  let restart = false;
  let reportStall = false;
  if (next.everPlayed && stalled > FROZEN_MS && now - next.lastRestart > FROZEN_MS) {
    next.lastRestart = now;
    restart = true;
  }
  if (stalled > STALL_MS) {
    // One line in the server log for each stall of a stream that played.
    if (next.everPlayed && !next.reported) {
      next.reported = true;
      reportStall = true;
    }
    next.showStatus = true;
    next.status = next.everPlayed ? "reconnecting" : now - next.opened > GIVE_UP_MS ? "failed" : "connecting";
  }
  return { watch: next, reportStall, restart };
}
