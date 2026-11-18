// The feed as the reader sees it: events folded into visits, recording gaps
// as rows of their own, and days as headers.
import type { EventEntry } from "./feed";
import { clockTime } from "./format";
import { isUrgent } from "./labels";

/** Events on one camera closer than this are one visit. */
export const SESSION_GAP_S = 20 * 60;
/** A recording gap this long or longer is a row in the feed. */
export const BLIND_MIN_S = 10 * 60;
/** Frigate reports gaps in whole minutes, so "until now" is within this. */
export const ONGOING_SLACK_S = 180;

export interface Session {
  key: string;
  camera: string;
  start: number;
  /** null while the newest event is still going. */
  end: number | null;
  labels: string[];
  /** Newest first. */
  entries: EventEntry[];
}

/** A stretch with no recording on one camera. */
export interface BlindSpot {
  camera: string;
  start: number;
  end: number;
  /** The gap runs up to now: the camera is still dark. */
  ongoing: boolean;
  /** The gap began before the window asked about, so its real start is earlier. */
  openStart: boolean;
}

export type Row =
  | { kind: "session"; start: number; session: Session }
  | { kind: "gap"; start: number; gap: BlindSpot };

/**
 * Fold events into visits: on one camera, an event that starts within gapS of
 * the end of the visit before joins it. A smoke alarm or breaking glass is
 * always a visit of its own, so it is never hidden in a group.
 */
export function groupSessions(events: EventEntry[], gapS = SESSION_GAP_S): Session[] {
  const asc = [...events].sort((a, b) => a.start - b.start);
  const open = new Map<string, Session>(); // camera -> the visit still open
  const out: Session[] = [];
  for (const e of asc) {
    const cur = open.get(e.camera);
    const urgent = isUrgent(e.labels);
    const curEnd = cur ? (cur.end ?? Infinity) : -Infinity;
    if (cur && !urgent && !isUrgent(cur.labels) && e.start - curEnd <= gapS) {
      cur.entries.unshift(e);
      cur.end = cur.end === null || e.end === null ? null : Math.max(cur.end, e.end);
      cur.labels = [...new Set([...cur.labels, ...e.labels])];
      continue;
    }
    const s: Session = { key: `s:${e.key}`, camera: e.camera, start: e.start, end: e.end, labels: [...e.labels], entries: [e] };
    out.push(s);
    open.set(e.camera, s);
  }
  return out.sort((a, b) => b.start - a.start);
}

/**
 * Frigate's gaps for one camera, asked for over [afterS, nowS], as feed rows:
 * only the long ones, newest first.
 */
export function blindSpots(camera: string, gaps: { start_time: number; end_time: number }[], afterS: number, nowS: number): BlindSpot[] {
  return gaps
    .filter((g) => g.end_time - g.start_time >= BLIND_MIN_S)
    .map((g) => ({
      camera,
      start: g.start_time,
      end: g.end_time,
      ongoing: g.end_time >= nowS - ONGOING_SLACK_S,
      openStart: g.start_time <= afterS + ONGOING_SLACK_S,
    }))
    .sort((a, b) => b.start - a.start);
}

/**
 * The time a gap row sorts at, which also sets its day header. A gap still
 * open sorts at now: it is happening today, not when it began. A closed gap
 * that began before the window shows only "Until <time>", so it sorts at its
 * end, and the header gives the day of that time.
 */
export function gapRowStart(g: BlindSpot, nowS: number): number {
  if (g.ongoing) return nowS;
  return g.openStart ? g.end : g.start;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** "Today", "Yesterday", or "Wednesday, Oct 14" ("Wed, Oct 14" when short). */
export function dayTitle(unixS: number, now: Date, short = false): string {
  const d = new Date(unixS * 1000);
  if (dayKey(d) === dayKey(now)) return "Today";
  // A calendar day, not 24 h: around a DST change a day is 23 or 25 hours.
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: short ? "short" : "long", month: "short", day: "numeric" });
}

/**
 * A clock time for a row under the day header of headerS: "12:10 am" on the
 * header's day, else "today at 12:10 am" or "Sun, Nov 15 at 12:10 am". A
 * visit that crosses midnight sits under its start day, so its later rows
 * need the day.
 */
export function clockUnder(unixS: number, headerS: number, now: Date): string {
  const t = clockTime(unixS);
  if (dayKey(new Date(unixS * 1000)) === dayKey(new Date(headerS * 1000))) return t;
  const day = dayTitle(unixS, now, true);
  return `${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day} at ${t}`;
}

/** Rows under their calendar day, newest day and newest row first. */
export function sections(rows: Row[], now: Date): { title: string; rows: Row[] }[] {
  const byDay = new Map<string, { title: string; rows: Row[] }>();
  for (const r of [...rows].sort((a, b) => b.start - a.start)) {
    const k = dayKey(new Date(r.start * 1000));
    let s = byDay.get(k);
    if (!s) byDay.set(k, (s = { title: dayTitle(r.start, now), rows: [] }));
    s.rows.push(r);
  }
  return [...byDay.values()];
}

/**
 * The length a ready row shows: the event length, "40 s". When the event runs
 * past the end of its clip, the row must not promise more than the clip
 * plays, so it gives the clip length first: "First 1 h 22 min of 3 h 28 min".
 * The exporter cuts a long event at MAX_EVENT_S, and no later clip covers the
 * rest (exporter/export_clips.py).
 */
export function readyLength(e: EventEntry, nowS: number): string {
  const end = e.end ?? nowS;
  const full = span(end - e.start);
  if (!e.window || end <= e.window.end) return full;
  const clip = e.clipSeconds ?? e.window.end - e.window.start;
  return `First ${span(clip)} of ${full}`;
}

/**
 * "40 s", "3 min", "2 h 5 min", "13 h 41 min". A detection of one frame has a
 * length of 0.0 to 0.4 s in Frigate; that reads "under 1 s", never "0 s".
 */
export function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 1) return "under 1 s";
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
