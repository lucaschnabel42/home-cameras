// Fault reports from the live view to the server log. A phone has no console
// that anyone reads, so the app sends a GET whose query string carries the
// report, and the line in Frigate's nginx access log is the record.
//
// Frigate's nginx does not log /api/version or /api/stats (access_log off),
// so a report there leaves no line. /api/review?after=9999999999 asks for
// review items after the year 2286: it returns [] (2 bytes) and nginx logs
// it with its query string. Read the lines with:
// docker exec frigate grep live_ /dev/shm/logs/nginx/current

import type { StreamKind } from "./liveSource";

export type LiveReportEvent = "stall" | "restart" | "error" | "swap" | "clean";

/**
 * The field whose value goes in `live_<event>=`. A stall or a restart has
 * none and is `live_<event>=1`.
 */
const HEAD_FIELD: Record<LiveReportEvent, string | null> = {
  stall: null,
  restart: null,
  error: "code",
  swap: "ms",
  clean: "result",
};

/**
 * The URL for one report. A stall or a restart is `live_<event>=1`. An error
 * is `live_error=<fields.code>`. A change to the clean stream is
 * `live_swap=<fields.ms>`, the time since the mount. A give-up or a fall-back
 * is `live_clean=<fields.result>` ("gave_up" or "fell_back"). Every report
 * names its stream next: `s=direct` or `s=clean`.
 */
export function liveReportUrl(event: LiveReportEvent, stream: StreamKind, fields: Record<string, string | number>): string {
  const key = HEAD_FIELD[event];
  const rest = { ...fields };
  let value: string | number = 1;
  if (key) {
    value = rest[key] ?? 0;
    delete rest[key];
  }
  const tail = Object.entries(rest).map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return `/api/review?after=9999999999&live_${event}=${encodeURIComponent(value)}&s=${stream}${tail.join("")}`;
}

/**
 * True when a video `error` event is a fault worth a report.
 *
 * VideoRTC's ondisconnect() sets video.src = "", and the browser then fires
 * an error (code 4) for the empty source. That is the stream closing, not a
 * fault. The socket state alone does not tell: restart() calls onconnect()
 * at once, so wsState is CONNECTING again before the error event runs. The
 * reliable sign is that the element has no source when the event runs. A
 * decode error (code 3) is reported in every case.
 */
export function shouldReportVideoError(e: { code: number; socketClosed: boolean; hasSource: boolean }): boolean {
  if (e.code === 3) return true;
  return e.hasSource && !e.socketClosed;
}
