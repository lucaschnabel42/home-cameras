// The rows of a visit: one row for each event (a Frigate review item), not one
// for each clip. The exporter merges padded windows, so one clip can hold many
// events; the person thinks in events ("when the dog did X"), so each event gets
// its own title, time, length and thumbnail, and a tap starts the clip there.
//
// What this does not do: it does not split a clip, and it does not list the
// events inside the player.
import { span } from "./activity";
import type { EventEntry, EventMoment } from "./feed";
import type { Summary } from "./helper";
import { kinds, type Kind } from "./labels";

/**
 * A long visit stays short: an event with no summary that starts within this
 * many seconds of the end of the row before it (in the same clip) joins that
 * row ("and 1 more moment"). An event with a summary always has its own row.
 */
export const JOIN_S = 60;

export interface VisitRow {
  key: string;
  /** The clip that covers the row; a tap plays it from `start`. */
  entry: EventEntry;
  /** Review ids in the row, in start order. More than one when events joined. */
  ids: string[];
  start: number;
  /** null while an event in the row is still going. */
  end: number | null;
  labels: string[];
  thumbUrl: string;
  /** The vision model's title and text for the first event in the row that has one. */
  summary: Summary | null;
  /** Events joined into this row after the first. */
  more: number;
}

const laterEnd = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.max(a, b));

/** One row for each event in these clips, newest first, with short events joined (JOIN_S). */
export function visitRows(entries: EventEntry[], summaries: Record<string, Summary>): VisitRow[] {
  const rows: VisitRow[] = [];
  for (const entry of entries) {
    let prev: VisitRow | null = null;
    for (const m of [...entry.moments].sort((a, b) => a.start - b.start)) {
      const own = summaries[m.id] ?? null;
      if (prev && !own && m.start - (prev.end ?? Infinity) <= JOIN_S) {
        prev.ids.push(m.id);
        prev.end = laterEnd(prev.end, m.end);
        prev.labels = [...new Set([...prev.labels, ...m.labels])];
        prev.more += 1;
        continue;
      }
      prev = {
        key: `${entry.key}:${m.id}`, entry, ids: [m.id], start: m.start, end: m.end,
        labels: [...m.labels], thumbUrl: m.thumbUrl, summary: own, more: 0,
      };
      rows.push(prev);
    }
  }
  return rows.sort((a, b) => b.start - a.start);
}

/** The number of events in these clips: the count a visit header gives. */
export const eventCount = (entries: EventEntry[]) => entries.reduce((n, e) => n + e.moments.length, 0);

/**
 * Keep only the events of one kind. A clip keeps the events that match, so a
 * filter for animals does not show a person-only event because it shares a clip.
 * A clip with no match is dropped.
 */
export function filterEntries(events: EventEntry[], filter: "all" | Kind): EventEntry[] {
  if (filter === "all") return events;
  const out: EventEntry[] = [];
  for (const e of events) {
    const kept: EventMoment[] = e.moments.filter((m) => kinds(m.labels).has(filter));
    if (kept.length === 0) continue;
    out.push({
      ...e,
      moments: kept,
      reviewIds: kept.map((m) => m.id),
      labels: [...new Set(kept.flatMap((m) => m.labels))],
      start: kept[0].start,
      end: kept.reduce<number | null>((acc, m) => laterEnd(acc, m.end), kept[0].end),
    });
  }
  return out;
}

/**
 * The length a row shows: "40 s". The row must not promise more than its clip
 * plays (the exporter cuts a long event, exporter/export_clips.py), so a row
 * that runs past the clip end says "First 2 min of 10 min", and a row that
 * starts after the clip end says "5 min, after the clip ends".
 */
export function rowLength(row: { start: number; end: number | null; entry: Pick<EventEntry, "window"> }, nowS: number): string {
  const end = row.end ?? nowS;
  const full = span(end - row.start);
  const w = row.entry.window;
  if (!w || end <= w.end) return full;
  if (row.start >= w.end) return `${full}, after the clip ends`;
  return `First ${span(w.end - row.start)} of ${full}`;
}
