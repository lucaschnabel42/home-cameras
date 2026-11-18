// Words and times the UI shows. All times are the viewer's local time.

/** "2:05 pm". */
export function clockTime(unixS: number): string {
  return new Date(unixS * 1000)
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    .replace(/\u202f/g, " ")
    .toLowerCase();
}

/** "Tuesday, October 14". */
export function longDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/**
 * The part of day an event belongs to, relative to now.
 * Night runs 22:00 to 05:00, so 23:30 yesterday and 00:30 today are both
 * "Last night".
 */
export function dayPart(unixS: number, now: Date): string {
  const t = new Date(unixS * 1000);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // A calendar day, not 24 h: around a DST change a day is 23 or 25 hours.
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const h = t.getHours();
  if (t >= today) {
    if (h < 5) return "Last night";
    if (h < 12) return "This morning";
    if (h < 17) return "This afternoon";
    if (h < 22) return "This evening";
    return "Tonight";
  }
  if (t >= yesterday) return h >= 22 ? "Last night" : "Yesterday";
  return "Earlier";
}

/** "at " for today, else "Wed, Oct 14, ", to put before a clock time. */
export function shortDay(unixS: number, now: Date): string {
  const d = new Date(unixS * 1000);
  if (d.toDateString() === now.toDateString()) return "at ";
  return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}, `;
}

/** "30 min", never "0 min". */
export function minutesLabel(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/** "12:21:37 am", for the playhead. */
export function clockTimeSeconds(unixS: number): string {
  return new Date(unixS * 1000)
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })
    .replace(/\u202f/g, " ")
    .toLowerCase();
}

/** Position in a clip: "1:05", or "1:02:05" past an hour. */
export function position(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "CDT": the short name of the local zone at that time. */
const zone = (unixS: number) =>
  new Date(unixS * 1000).toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop() ?? "";

/** "7:54 to 9:06 am", "11:11 am to 1:05 pm", "7:54 am to now". */
export function timeRange(startS: number, endS: number | null): string {
  const a = clockTime(startS);
  if (endS === null) return `${a} to now`;
  const b = clockTime(endS);
  // The repeated hour at the end of DST: "1:30 am CDT to 1:30 am CST".
  if (a === b && endS - startS >= 60) return `${a} ${zone(startS)} to ${b} ${zone(endS)}`;
  const half = (s: string) => s.slice(-2);
  return half(a) === half(b) ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`;
}
