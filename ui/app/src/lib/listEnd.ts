/**
 * The line at the end of the Activity list. It says how far back the list
 * goes, and how far back the recordings go, so that the end of the list does
 * not read as the end of the recordings.
 *
 * Both numbers are computed: the list window is FEED_S, and the recording
 * window is Frigate's record.continuous.days from /api/config.
 */

/** The feed shows two days, the same view the clip exporter works in. */
export const FEED_S = 2 * 86_400;

type RecordCfg = { record?: { continuous?: { days?: number } } };
export type ConfigForDays = RecordCfg & { cameras: Record<string, RecordCfg & { enabled?: boolean }> };

const positive = (d: number | undefined) => (typeof d === "number" && d > 0 ? d : null);

/**
 * Days of continuous recording that Frigate keeps. With several cameras it is
 * the shortest, so that the line is true for every camera. A camera with no
 * value of its own uses the global value. null when the config gives none.
 */
export function recordDays(cfg: ConfigForDays): number | null {
  const global = positive(cfg.record?.continuous?.days);
  const per = Object.values(cfg.cameras)
    .filter((c) => c.enabled !== false)
    .map((c) => positive(c.record?.continuous?.days) ?? global)
    .filter((d): d is number => d !== null);
  return per.length ? Math.min(...per) : global;
}

const days = (n: number) => {
  const v = Number(n.toFixed(1));
  return v === 1 ? "1 day" : `${v} days`;
};

/** "This list shows the last 2 days. Recordings go back 7 days." */
export function listEndLine(feedS: number, recordedDays: number | null): string {
  const feedDays = feedS / 86_400;
  const first = `This list shows the last ${feedDays === 1 ? "day" : days(feedDays)}.`;
  if (recordedDays === null || recordedDays <= feedDays) return first;
  return `${first} Recordings go back ${days(recordedDays)}.`;
}
