import { parseClipName, type ClipTag } from "./clipName";

export interface ReviewItem {
  id: string;
  camera: string;
  start_time: number;
  end_time: number | null;
  severity: "alert" | "detection";
  thumb_path: string;
  /** audio: sounds heard (bark, smoke_detector, ...), when audio detection is on. */
  data: { objects: string[]; audio?: string[] };
}

/** Everything seen or heard in a review item. */
export const reviewLabels = (r: ReviewItem) => [...new Set([...r.data.objects, ...(r.data.audio ?? [])])];

export interface ExportItem {
  id: string;
  camera: string;
  name: string;
  date: number;
  video_path: string;
  thumb_path: string;
  in_progress: boolean;
}

export type EventState = "recording" | "waiting" | "exporting" | "ready";

/** Wall-clock span a clip file covers; the player maps detections into it. */
export interface ClipWindow {
  start: number;
  end: number;
}

/** Padding around an event, the same as the exporter's PAD_SECONDS. */
export const EVENT_PAD_S = 150;

/**
 * An event whose padded export is not cut yet plays straight from the
 * recordings through Frigate's HLS playlist: the same padded window, cut at
 * now while the after-padding is still being recorded. Frigate's
 * /api/review/{id}/clip.mp4 is not used for playback: it streams with no
 * length and no byte ranges, which iPhone Safari refuses. It is fine as a
 * file to share.
 */
const recordingClip = (r: ReviewItem, now: number) => {
  const start = Math.floor(r.start_time - EVENT_PAD_S);
  const end = Math.floor(Math.min((r.end_time ?? now) + EVENT_PAD_S, now));
  return {
    clipUrl: `/vod/${r.camera}/start/${start}/end/${end}/index.m3u8`,
    window: { start, end },
    shareUrl: `/api/review/${r.id}/clip.mp4?padding=${EVENT_PAD_S}`,
  };
};

/** One Frigate review item inside a clip: one event as the person sees it. */
export interface EventMoment {
  id: string;
  start: number;
  end: number | null;
  labels: string[];
  thumbUrl: string;
}

const momentOf = (r: ReviewItem): EventMoment => ({
  id: r.id, start: r.start_time, end: r.end_time, labels: reviewLabels(r), thumbUrl: mediaUrl(r.thumb_path),
});

/**
 * One clip and the events it covers. The feed shows one row for each event
 * (lib/visits.ts), and a tap plays this clip from that event.
 */
export interface EventEntry {
  key: string;
  camera: string;
  start: number;
  end: number | null;
  labels: string[];
  severity: "alert" | "detection";
  state: EventState;
  thumbUrl: string;
  clipUrl: string | null;
  window: ClipWindow | null;
  /** A complete MP4 for the share sheet (an HLS playlist cannot be shared). */
  shareUrl: string | null;
  /** Length of the padded export, or null until it exists. */
  clipSeconds: number | null;
  reviewIds: string[];
  /** The review items in the clip, in start order (the same order as reviewIds). */
  moments: EventMoment[];
}

export interface SavedEntry {
  key: string;
  camera: string;
  title: string;
  minutes: number | null;
  start: number | null;
  end: number | null;
  date: number;
  state: "exporting" | "ready";
  thumbUrl: string;
  clipUrl: string | null;
  window: ClipWindow | null;
  shareUrl: string | null;
}

/** Frigate serves /media/frigate/<x> at /<x>. */
export function mediaUrl(path: string): string {
  return path.startsWith("/media/frigate/") ? path.slice("/media/frigate".length) : path;
}

/**
 * Join Frigate review items to the exports that cover them.
 *
 * An event export covers a review item when it is for the same camera and the
 * item starts inside the export's tagged window. Several items can share one
 * export (the exporter merges overlapping windows). Exports with a saved tag or
 * no tag go to the saved list.
 */
export function buildFeed(reviews: ReviewItem[], exports: ExportItem[], now = Date.now() / 1000) {
  const tagged = exports.map((e) => ({ e, tag: parseClipName(e.name) }));
  const eventExports = tagged.filter(
    (t): t is { e: ExportItem; tag: ClipTag } => t.tag?.kind === "event",
  );

  const groups = new Map<string, EventEntry>();
  for (const r of [...reviews].sort((a, b) => a.start_time - b.start_time)) {
    const hit = eventExports.find(
      ({ tag }) => tag.camera === r.camera && tag.start <= r.start_time && r.start_time <= tag.end,
    );
    const key = hit ? `x:${hit.e.id}` : `r:${r.id}`;
    const g = groups.get(key);
    if (g) {
      g.end = g.end === null || r.end_time === null ? null : Math.max(g.end, r.end_time);
      g.labels = [...new Set([...g.labels, ...reviewLabels(r)])];
      g.reviewIds.push(r.id);
      g.moments.push(momentOf(r));
      if (r.severity === "alert") g.severity = "alert";
      continue;
    }
    let state: EventState;
    let clip: { clipUrl: string | null; window: ClipWindow | null; shareUrl: string | null };
    if (hit && !hit.e.in_progress) {
      state = "ready";
      const url = mediaUrl(hit.e.video_path);
      clip = { clipUrl: url, window: { start: hit.tag.start, end: hit.tag.end }, shareUrl: url };
    } else if (hit) {
      state = "exporting";
      clip = recordingClip(r, now);
    } else if (r.end_time === null) {
      state = "recording";
      clip = { clipUrl: null, window: null, shareUrl: null };
    } else {
      state = "waiting";
      clip = recordingClip(r, now);
    }
    groups.set(key, {
      key, camera: r.camera, start: r.start_time, end: r.end_time, labels: reviewLabels(r),
      severity: r.severity, state, thumbUrl: mediaUrl(r.thumb_path), ...clip,
      clipSeconds: hit ? (hit.tag.duration ?? hit.tag.end - hit.tag.start) : null, reviewIds: [r.id],
      moments: [momentOf(r)],
    });
  }
  const events = [...groups.values()].sort((a, b) => b.start - a.start);

  const saved: SavedEntry[] = tagged
    .filter((t) => t.tag === null || t.tag.kind === "saved")
    .map(({ e, tag }): SavedEntry => {
      const minutes = tag ? Math.round((tag.end - tag.start) / 60) : null;
      return {
        key: e.id,
        camera: e.camera,
        title: minutes !== null ? `Last ${minutes} min` : e.name,
        minutes,
        start: tag?.start ?? null,
        end: tag?.end ?? null,
        date: e.date,
        state: e.in_progress ? "exporting" : "ready",
        thumbUrl: mediaUrl(e.thumb_path),
        clipUrl: e.in_progress ? null : mediaUrl(e.video_path),
        window: tag ? { start: tag.start, end: tag.end } : null,
        shareUrl: e.in_progress ? null : mediaUrl(e.video_path),
      };
    })
    .sort((a, b) => b.date - a.date);

  return { events, saved };
}
