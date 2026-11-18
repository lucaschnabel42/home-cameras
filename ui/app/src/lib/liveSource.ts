// The choice between the direct stream and the clean stream for one live
// tile, as a pure step function so that a test can drive it with a clock.
// LiveVideo.tsx calls sourceStep once a second, after liveStep, and applies
// the actions.
//
// The direct stream shows a picture in 0.3 s. The clean stream needs 3 to 4 s,
// because go2rtc starts ffmpeg only when a viewer connects. So the tile starts
// on the direct stream and changes to the clean stream when the clean stream
// plays. A change happens at most once in a mount: after a give-up or a
// fall-back the tile stays on the direct stream.
//
// What this module does not do: it does not see the direct stream. A direct
// stream that stalls while the clean stream loads is the job of liveWatch.ts.

/** The clean stream is not ready after this much visible time: stop the wait (rule 4). */
export const CLEAN_WAIT_MS = 20_000;
/** The shown clean stream stalls for more than this visible time: go back to the direct stream (rule 5). */
export const CLEAN_FAIL_MS = 20_000;
/** The clean stream is ready when its time moves on this many ticks in sequence (rule 3). */
export const CLEAN_READY_TICKS = 2;

export type StreamKind = "direct" | "clean";

/**
 * - `none`: the camera has no clean stream.
 * - `waiting`: the clean element loads under the direct element, not visible.
 * - `clean`: the clean element is shown; the direct element is disposed.
 * - `direct`: the tile gave up on the clean stream or fell back from it. It
 *   stays on the direct stream for the rest of the mount.
 */
export type SourcePhase = "none" | "waiting" | "clean" | "direct";

export interface LiveSource {
  phase: SourcePhase;
  /** The time of the last tick with the page visible, or -1 after a hidden tick. */
  lastVisible: number;
  /** Visible time spent in `waiting`. */
  waitedMs: number;
  /** The clean element's currentTime at the last visible tick, or null when it had no frame. */
  cleanLast: number | null;
  /** Visible ticks in sequence on which the clean element's time moved. */
  movingTicks: number;
  /** Visible time of the current stall of the shown clean stream, or null when its frames move. */
  stalledMs: number | null;
}

/** What the tile reads from the clean element on each tick. */
export interface CleanSample {
  /** video.readyState, or -1 when the element has no video yet. */
  readyState: number;
  currentTime: number;
}

export interface SourceSample {
  now: number;
  hidden: boolean;
  /** The clean element, or null when the tile has none. */
  clean: CleanSample | null;
  /** The stall watch of the shown element saw its frames move on this tick. */
  shownMoving: boolean;
}

export interface SourceStepResult {
  source: LiveSource;
  /** Show the clean element and dispose the direct element (writes live_swap). */
  swap: boolean;
  /** Dispose the clean element and stay on the direct stream (writes live_clean=gave_up). */
  giveUp: boolean;
  /** Create a direct element, show it, and dispose the clean element (writes live_clean=fell_back). */
  fallBack: boolean;
}

export function startSource(now: number, hasClean: boolean): LiveSource {
  return {
    phase: hasClean ? "waiting" : "none",
    lastVisible: now,
    waitedMs: 0,
    cleanLast: null,
    movingTicks: 0,
    stalledMs: null,
  };
}

/** The stream that the tile shows. */
export function shownStream(s: LiveSource): StreamKind {
  return s.phase === "clean" ? "clean" : "direct";
}

export function sourceStep(s: LiveSource, x: SourceSample): SourceStepResult {
  const none = { swap: false, giveUp: false, fallBack: false };
  if (s.phase === "none" || s.phase === "direct") return { source: s, ...none };
  // Rule 6: hidden time does not count. The elements close their sockets
  // while the page is hidden, so the count of moving ticks starts again.
  if (x.hidden) return { source: { ...s, lastVisible: -1, cleanLast: null, movingTicks: 0 }, ...none };
  const dt = s.lastVisible < 0 ? 0 : x.now - s.lastVisible;
  const next: LiveSource = { ...s, lastVisible: x.now };

  if (s.phase === "waiting") {
    const c = x.clean;
    const hasFrame = !!c && c.readyState >= 2;
    const moved = hasFrame && s.cleanLast !== null && c.currentTime !== s.cleanLast;
    next.cleanLast = hasFrame ? c.currentTime : null;
    next.movingTicks = moved ? s.movingTicks + 1 : 0;
    // Rule 3.
    if (next.movingTicks >= CLEAN_READY_TICKS) return { source: { ...next, phase: "clean", stalledMs: null }, ...none, swap: true };
    // Rule 4.
    next.waitedMs = s.waitedMs + dt;
    if (next.waitedMs >= CLEAN_WAIT_MS) return { source: { ...next, phase: "direct" }, ...none, giveUp: true };
    return { source: next, ...none };
  }

  // Rule 5. A stall starts at the first tick with no movement, as in liveWatch.ts.
  next.stalledMs = x.shownMoving ? null : s.stalledMs === null ? 0 : s.stalledMs + dt;
  if (next.stalledMs !== null && next.stalledMs > CLEAN_FAIL_MS) return { source: { ...next, phase: "direct" }, ...none, fallBack: true };
  return { source: next, ...none };
}
