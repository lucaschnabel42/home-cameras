import { Check, DownloadSimple, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { clockTime } from "../lib/format";
import { frameAtUrl, getSegments, type CameraInfo } from "../lib/frigate";
import { SAVE_STEPS, SEGMENT_CLOSE_S, type SaveMinutes } from "../lib/saveWindow";
import { serverNow } from "../lib/serverClock";
import type { Segment } from "../lib/timeline";
import { OrbField } from "./OrbField";

/** The preview and the saved window may differ by at most this much. */
const TICK_MS = 10_000;

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; minutes: number } | { kind: "error"; message: string };

/** Frigate's own wording, said the app's way. */
function saveError(message: string): string {
  if (/no recordings/i.test(message)) return "Nothing was recorded in that window.";
  if (/queue is full/i.test(message)) return "The recorder is busy saving other clips. Try again in a minute.";
  return "The recorder did not take that save. Try again.";
}

/**
 * "Save last N minutes". Drag or tap along 5 to 30 min; the frame above shows
 * what the camera saw N minutes ago, so you see what you keep. The clock moves
 * every 30 s, so the preview stays the window the button saves. A length with
 * no recording behind it is turned off; with nothing recorded at all, the dial
 * gives way to a note.
 */
export function RewindDial({
  camera,
  onSave,
}: {
  camera: CameraInfo;
  onSave: (minutes: SaveMinutes) => Promise<{ success: boolean; message: string }>;
}) {
  const [minutes, setMinutes] = useState<SaveMinutes>(15);
  const [now, setNow] = useState(() => Math.floor(serverNow()));
  // undefined while loading, null if the request failed (then every length is on)
  const [segments, setSegments] = useState<Segment[] | null | undefined>(undefined);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const dragging = useRef(false);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(serverNow())), TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const longest = SAVE_STEPS[SAVE_STEPS.length - 1];
    getSegments(camera.name, now - longest * 60, now)
      .then((s) => alive && setSegments(s))
      .catch(() => alive && setSegments(null)); // unknown: leave every length on
    return () => {
      alive = false;
    };
  }, [camera.name, now]);

  const recorded = (m: number) =>
    !segments ||
    segments.some((s) => s.end_time > now - m * 60 && s.start_time < now - SEGMENT_CLOSE_S);
  const anything = SAVE_STEPS.some(recorded);
  // A camera that stopped recording can leave the chosen length with nothing
  // behind it: move to the shortest length that has a recording.
  useEffect(() => {
    if (!segments || recorded(minutes)) return;
    const first = SAVE_STEPS.find(recorded);
    if (first) setMinutes(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, now]);
  const at = now - minutes * 60;
  const src = frameAtUrl(camera.name, at);

  const choose = (m: SaveMinutes) => {
    if (m === minutes) return;
    setMinutes(m);
    if (status.kind !== "saving") setStatus({ kind: "idle" }); // an old message no longer applies
  };
  const pick = (e: PointerEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const m = Number((el as HTMLElement | null)?.dataset?.minutes);
    if ((SAVE_STEPS as readonly number[]).includes(m) && recorded(m)) choose(m as SaveMinutes);
  };
  const saved = status.kind === "saved" && status.minutes === minutes;

  // Loading: neither the dial nor the note, so an offline camera never shows a
  // full dial that then collapses.
  if (segments === undefined) return null;
  if (!anything) {
    return (
      <div className="sheet glass note">
        <b>Nothing to save</b>
        <span>This camera has recorded nothing in the last 30 minutes.</span>
      </div>
    );
  }

  return (
    <div className="sheet glass">
      <div className="preview" style={{ aspectRatio: camera.aspect }}>
        {failedSrc === src ? (
          <OrbField>
            <span className="orb-label">No recording at {clockTime(at)}</span>
          </OrbField>
        ) : (
          <img src={src} alt={`${camera.title} ${minutes} minutes ago`} onError={() => setFailedSrc(src)} />
        )}
      </div>
      <div className="preview-cap tnum">
        <b>{minutes} min ago</b>
        <span>{clockTime(at)}</span>
      </div>
      <div
        className="dial tnum"
        role="radiogroup"
        aria-label="How much to save"
        onPointerDown={(e) => {
          dragging.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          pick(e);
        }}
        onPointerMove={(e) => dragging.current && pick(e)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        {SAVE_STEPS.map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={m === minutes}
            aria-label={`${m} minutes`}
            data-minutes={m}
            disabled={!recorded(m)}
            onClick={() => choose(m)}
          >
            {m}
          </button>
        ))}
      </div>
      <button
        className="save"
        disabled={saved}
        onClick={async () => {
          if (status.kind === "saving" || saved) return;
          setStatus({ kind: "saving" });
          const r = await onSave(minutes).catch((e: Error) => ({ success: false, message: e.message }));
          setStatus(r.success ? { kind: "saved", minutes } : { kind: "error", message: saveError(r.message) });
        }}
      >
        {saved ? <Check size={18} aria-hidden="true" /> : <DownloadSimple size={18} weight="regular" aria-hidden="true" />}
        {status.kind === "saving" ? "Saving" : saved ? "Saved" : `Save last ${minutes} min`}
      </button>
      <p className={status.kind === "error" ? "save-status error" : "save-status"} role="status">
        {status.kind === "saved" && "It shows under Saved in about a minute."}
        {status.kind === "error" && (
          <>
            <WarningCircle size={16} aria-hidden="true" /> {status.message}
          </>
        )}
      </p>
    </div>
  );
}
