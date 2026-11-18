// "Since when" for a camera that does not record: one sentence for the home
// tile, the feed row and the camera view.
//
// Sources, in order:
// 1. The start of Frigate's open recording gap, when it is inside the
//    retention (a gap that starts after the start of the question).
// 2. cam-helper's last-live time (helper/cameras.py, GET /helper/cameras),
//    when the gap is older than the retention. Frigate cannot give that
//    start: /api/recordings/unavailable then returns one range that starts
//    where the question starts.
// 3. Neither: "Not recording for over 7 days" (the retention in days).
//
// What this does not do: it does not decide that a camera is offline (that is
// camera_fps in /api/stats), and it does not check the helper's time against
// the camera maker's own app.
import { ONGOING_SLACK_S, blindSpots, span, type BlindSpot } from "./activity";
import { clockTime } from "./format";

type RawGap = { start_time: number; end_time: number };

/** A gap that runs up to now; openStart when it began before the question. */
export interface OpenGap {
  start: number;
  openStart: boolean;
}

/**
 * Frigate's gaps for one camera, asked for over the retention, as the two
 * things the app needs: the feed rows over the feed window (the same rows a
 * question over that window gives), and the gap still open over the whole
 * retention (any length), or null.
 */
export function gapViews(camera: string, raw: RawGap[], nowS: number, feedS: number, retainS: number): { spots: BlindSpot[]; ongoing: OpenGap | null } {
  const feedStart = nowS - feedS;
  const inFeed = raw
    .filter((g) => g.end_time > feedStart)
    .map((g) => ({ start_time: Math.max(g.start_time, feedStart), end_time: g.end_time }));
  const open = raw.filter((g) => g.end_time >= nowS - ONGOING_SLACK_S).sort((a, b) => b.start_time - a.start_time)[0];
  return {
    spots: blindSpots(camera, inFeed, feedStart, nowS),
    ongoing: open ? { start: open.start_time, openStart: open.start_time <= nowS - retainS + ONGOING_SLACK_S } : null,
  };
}

export type DownSince = { kind: "since"; at: number; from: "frigate" | "helper" } | { kind: "older" } | { kind: "unknown" };

/**
 * When the camera stopped recording. gap is Frigate's open gap over the
 * retention (null when Frigate shows none yet, or has not answered).
 * lastLive is the helper's time, or null. A helper time inside the
 * retention, when Frigate says the gap is older, is not used: Frigate's
 * recordings win inside the retention.
 */
export function downSince({ gap, lastLive, retainStartS }: { gap: OpenGap | null; lastLive: number | null; retainStartS: number }): DownSince {
  if (gap && !gap.openStart) return { kind: "since", at: gap.start, from: "frigate" };
  if (lastLive !== null && (!gap || lastLive <= retainStartS + ONGOING_SLACK_S)) return { kind: "since", at: lastLive, from: "helper" };
  if (gap) return { kind: "older" };
  return { kind: "unknown" };
}

/** "7:01 pm" today, else "Oct 15, 7:01 pm". */
function when(unixS: number, now: Date): string {
  const d = new Date(unixS * 1000);
  if (d.toDateString() === now.toDateString()) return clockTime(unixS);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${clockTime(unixS)}`;
}

/** "2 h 59 min" under two days, then whole days: "33 days". */
function howLong(seconds: number): string {
  return seconds < 2 * 86_400 ? span(seconds) : `${Math.floor(seconds / 86_400)} days`;
}

/** "Not recording since Oct 15, 7:01 pm (33 days)", or "Not recording for over 7 days". */
export function downSentence(d: DownSince, retainDays: number, now: Date): string {
  if (d.kind === "since") return `Not recording since ${when(d.at, now)} (${howLong(now.getTime() / 1000 - d.at)})`;
  if (d.kind === "older") return `Not recording for over ${Number(retainDays.toFixed(1))} days`;
  return "Not recording";
}
