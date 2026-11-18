import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { dayTitle } from "../lib/activity";
import { clockTimeSeconds, position } from "../lib/format";
import { isSound } from "../lib/labels";
import { clipToWall, type ClipMap, type Moment } from "../lib/timeline";

/**
 * Clip timeline: motion as a soft strip, each detection as an accent band,
 * and the playhead with the wall-clock time it shows. Tap or drag to seek.
 */
export function Timeline({
  duration,
  current,
  map,
  moments,
  motion,
  onSeek,
}: {
  duration: number;
  current: number;
  map: ClipMap | null;
  moments: Moment[];
  motion: number[];
  onSeek: (t: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const pct = (t: number) => `${duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0}%`;

  const seekTo = (e: PointerEvent) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || duration <= 0) return;
    onSeek(Math.min(duration, Math.max(0, ((e.clientX - r.left) / r.width) * duration)));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") onSeek(Math.min(duration, current + 5));
    else if (e.key === "ArrowLeft") onSeek(Math.max(0, current - 5));
    else return;
    e.preventDefault();
  };

  return (
    <div className="timeline">
      <div
        ref={track}
        className="tl-track"
        role="slider"
        tabIndex={0}
        aria-label="Clip position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        aria-valuetext={position(current)}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekTo(e);
        }}
        onPointerMove={(e) => dragging.current && seekTo(e)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        <div className="tl-motion" aria-hidden="true">
          {motion.map((v, i) => (
            <i key={i} style={{ height: `${Math.round(v * 100)}%` }} />
          ))}
        </div>
        {moments.map((m, i) => (
          <span
            key={i}
            className={m.labels.some(isSound) ? "tl-moment sound" : "tl-moment"}
            aria-hidden="true"
            style={{ left: pct(m.start), width: `max(4px, calc(${pct(m.end)} - ${pct(m.start)}))` }}
          />
        ))}
        <span className="tl-head" aria-hidden="true" style={{ left: pct(current) }} />
      </div>
      <div className="tl-times tnum">
        <span>{position(current)}</span>
        <b>
          {map ? `${dayTitle(clipToWall(map, current), new Date(), true)} · ${clockTimeSeconds(clipToWall(map, current))}` : ""}
        </b>
        <span>{position(duration)}</span>
      </div>
    </div>
  );
}
