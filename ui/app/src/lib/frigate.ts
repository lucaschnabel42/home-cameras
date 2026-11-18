// Thin typed client for Frigate's HTTP API, served on the same origin by Caddy
// (production) or the Vite proxy (dev). The app has no login of its own: the
// install decides who can reach it.
import type { ExportItem, ReviewItem } from "./feed";
import type { Segment } from "./timeline";
import { formatClipName } from "./clipName";
import { recordDays, type ConfigForDays } from "./listEnd";
import { saveWindow } from "./saveWindow";
import { noteServerDate, serverNow } from "./serverClock";

/** A request that hangs (Frigate restarting) fails after this, so the app can say so. */
const TIMEOUT_MS = 10_000;

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  noteServerDate(r.headers.get("Date"));
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  return r.json() as Promise<T>;
}

export interface CameraInfo {
  name: string;
  title: string;
  /** width / height of the real picture, from Frigate's detect size. */
  aspect: number;
  /**
   * A go2rtc stream that is not a Frigate camera: no recording, no stills, and
   * the stream runs only while someone watches (the battery doorbell).
   */
  liveOnly: boolean;
  /**
   * The go2rtc stream `<camera>_clean`, or null when go2rtc has no such
   * stream. ffmpeg encodes the camera's video again in this stream, so a
   * damaged frame from the camera does not reach the browser. A live-only
   * stream never has a clean stream.
   */
  cleanStream: string | null;
}

/** The parts of /api/config that the camera list reads. */
export interface ConfigForCameras {
  cameras: Record<string, { enabled?: boolean; detect?: { width?: number; height?: number } }>;
  go2rtc?: { streams?: Record<string, unknown> };
}

/** The name of the clean stream of a camera. */
export const cleanStreamName = (camera: string) => `${camera}_clean`;

/** Portrait 3:4, the shape of a doorbell picture. Live-only streams have no detect size. */
export const LIVE_ONLY_ASPECT = 3 / 4;

/** "front_porch_cam" -> "Front porch". */
export function cameraTitle(name: string): string {
  const words = name.replace(/_cam$/, "").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Enabled cameras in config order.
 *
 * The aspect comes from Frigate's detect size, not from the video element:
 * go2rtc's MSE stream declares 2560x1920 for a 2560x1440 picture, so the
 * element's own aspect would stretch it.
 */
export async function getCameras(): Promise<CameraInfo[]> {
  return camerasFromConfig(await json<ConfigForCameras>("/api/config"));
}

/**
 * The camera list from /api/config: the enabled Frigate cameras, then the
 * go2rtc streams that are not Frigate cameras (live-only). The clean stream
 * of a Frigate camera is not a live-only camera.
 */
export function camerasFromConfig(cfg: ConfigForCameras): CameraInfo[] {
  const streams = cfg.go2rtc?.streams ?? {};
  const recorded = Object.entries(cfg.cameras)
    .filter(([, c]) => c.enabled !== false)
    .map(([name, c]) => ({
      name,
      title: cameraTitle(name),
      aspect: c.detect?.width && c.detect?.height ? c.detect.width / c.detect.height : 16 / 9,
      liveOnly: false,
      cleanStream: cleanStreamName(name) in streams ? cleanStreamName(name) : null,
    }));
  const cleanOfCamera = new Set(Object.keys(cfg.cameras).map(cleanStreamName));
  const liveOnly = Object.keys(streams)
    .filter((name) => !(name in cfg.cameras) && name !== "birdseye" && !cleanOfCamera.has(name))
    .map((name) => ({ name, title: cameraTitle(name), aspect: LIVE_ONLY_ASPECT, liveOnly: true, cleanStream: null }));
  return [...recorded, ...liveOnly];
}

/** Days of continuous recording Frigate keeps (record.continuous.days), or null. */
export async function getRecordDays(): Promise<number | null> {
  return recordDays(await json<ConfigForDays>("/api/config"));
}

/** camera -> online, from camera_fps. */
export async function getOnline(): Promise<Record<string, boolean>> {
  const s = await json<{ cameras: Record<string, { camera_fps: number }> }>("/api/stats");
  return Object.fromEntries(Object.entries(s.cameras).map(([k, v]) => [k, v.camera_fps > 0]));
}

/** Review items since afterS. No "before": Frigate defaults it to its own now, so a slow phone clock hides nothing. */
export function getReviews(afterS: number): Promise<ReviewItem[]> {
  return json(`/api/review?after=${Math.floor(afterS)}`);
}

/** Review items for one camera that overlap [start, end]. */
export function getReviewsIn(camera: string, start: number, end: number): Promise<ReviewItem[]> {
  return json(`/api/review?cameras=${encodeURIComponent(camera)}&after=${Math.floor(start)}&before=${Math.ceil(end)}`);
}

/** Recording segments (10 s each, with motion counts) that overlap [start, end]. */
export function getSegments(camera: string, start: number, end: number): Promise<Segment[]> {
  return json(`/api/${encodeURIComponent(camera)}/recordings?after=${Math.floor(start)}&before=${Math.ceil(end)}`);
}

/** Exports made in the last `days` days (exports never expire, so the full list only grows). */
export function getExports(days = 30): Promise<ExportItem[]> {
  return json(`/api/exports?start_date=${Math.floor(Date.now() / 1000 - days * 86_400)}`);
}

export async function saveLast(camera: string, minutes: number): Promise<{ success: boolean; message: string }> {
  const { start, end } = saveWindow(minutes, serverNow());
  const r = await fetch(`/api/export/${encodeURIComponent(camera)}/start/${start}/end/${end}`, {
    method: "POST",
    credentials: "same-origin",
    // Frigate rejects a browser POST (one with an Origin header) without this
    // header (check_csrf in frigate/api/fastapi_app.py). Any value passes.
    headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": "1" },
    body: JSON.stringify({
      source: "recordings",
      name: formatClipName({ kind: "saved", camera, start, end, labels: [] }),
    }),
  });
  const body = await r.json().catch(() => ({ message: `Frigate returned ${r.status}` }));
  return { success: r.ok && body.success !== false, message: body.message ?? "" };
}

/** Stretches with no recording on one camera, in whole minutes (Frigate's scale=60). */
export function getGaps(camera: string, after: number, before: number): Promise<{ start_time: number; end_time: number }[]> {
  return json(
    `/api/recordings/unavailable?cameras=${encodeURIComponent(camera)}&after=${Math.floor(after)}&before=${Math.ceil(before)}&scale=60`,
  );
}

export interface MotionSearchResult {
  timestamp: number;
  change_percentage: number;
}
export interface MotionSearchStatus {
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  results?: MotionSearchResult[] | null;
  progress?: number | null;
  error_message?: string | null;
}

/**
 * Start Frigate's motion search over a box (0..1 corners) and a time range.
 * The scan reads the recordings, so it can take a while; poll the job.
 */
export async function startAreaSearch(
  camera: string,
  box: { x0: number; y0: number; x1: number; y1: number },
  start: number,
  end: number,
): Promise<string> {
  const r = await fetch(`/api/${encodeURIComponent(camera)}/search/motion`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": "1" },
    body: JSON.stringify({
      start_time: Math.floor(start),
      end_time: Math.ceil(end),
      polygon_points: [
        [box.x0, box.y0],
        [box.x1, box.y0],
        [box.x1, box.y1],
        [box.x0, box.y1],
      ],
      parallel: true,
      max_results: 60,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.job_id) throw new Error(body.message ?? `Frigate returned ${r.status}`);
  return body.job_id as string;
}

export function getAreaSearch(camera: string, jobId: string): Promise<MotionSearchStatus> {
  return json(`/api/${encodeURIComponent(camera)}/search/motion/${encodeURIComponent(jobId)}`);
}

export function cancelAreaSearch(camera: string, jobId: string): Promise<Response> {
  return fetch(`/api/${encodeURIComponent(camera)}/search/motion/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-CSRF-TOKEN": "1" },
  });
}

export const latestUrl = (camera: string, h = 720) => `/api/${camera}/latest.webp?height=${h}`;

export const frameAtUrl = (camera: string, unixS: number, h = 360) =>
  `/api/${camera}/recordings/${Math.floor(unixS)}/snapshot.jpg?height=${h}`;

export const liveWsUrl = (camera: string) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live/mse/api/ws?src=${encodeURIComponent(camera)}`;
