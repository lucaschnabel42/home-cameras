import { CaretLeft, MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useDialog } from "../hooks/useDialog";
import { dayTitle } from "../lib/activity";
import { clockTimeSeconds } from "../lib/format";
import {
  cancelAreaSearch,
  frameAtUrl,
  getAreaSearch,
  latestUrl,
  startAreaSearch,
  type CameraInfo,
  type MotionSearchResult,
} from "../lib/frigate";
import { placePhrase } from "../lib/labels";
import type { PlayRequest } from "./ActivityFeed";

// The scan decodes the recordings: 3 hours took 105 s on a busy recorder, so
// a month would take hours. 3 days is the longest offered.
const RANGES = [
  { label: "1 hour", s: 3600 },
  { label: "6 hours", s: 6 * 3600 },
  { label: "24 hours", s: 86_400 },
  { label: "3 days", s: 3 * 86_400 },
] as const;
/** A box smaller than this (share of each side) is a tap, not a box. */
const MIN_SIDE = 0.04;
const POLL_MS = 1500;
/** Failed polls in a row before the screen says the search was lost. */
const MAX_POLL_FAILS = 8;
/** A result plays from a little before the change to well after it. */
const BEFORE_S = 10;
const AFTER_S = 110;

type Box = { x0: number; y0: number; x1: number; y1: number };
type Phase =
  | { kind: "draw" }
  | { kind: "searching"; jobId: string; progress: number; results: MotionSearchResult[] }
  | { kind: "done"; results: MotionSearchResult[] }
  | { kind: "error"; message: string };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * "When did this change?": draw a box on the picture, pick how far back, and
 * Frigate scans the recordings for moments when that spot changed. It finds
 * what the detector cannot name, like a package left or taken, or a door
 * opened. Tap a result to play it.
 */
export function AreaSearch({ camera, onClose, onPlay }: { camera: CameraInfo; onClose: () => void; onPlay: (p: PlayRequest) => void }) {
  const { titleId, back: backButton, root: dialogRoot } = useDialog(onClose);
  const [box, setBox] = useState<Box | null>(null);
  const [range, setRange] = useState<number>(RANGES[1].s); // 6 hours
  const [phase, setPhase] = useState<Phase>({ kind: "draw" });
  const pic = useRef<HTMLDivElement>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const [still] = useState(() => `${latestUrl(camera.name)}&t=${Date.now()}`);

  const at = (e: PointerEvent) => {
    const r = pic.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  const drag = (e: PointerEvent) => {
    if (!from.current) return;
    const p = at(e);
    const f = from.current;
    setBox({ x0: Math.min(f.x, p.x), y0: Math.min(f.y, p.y), x1: Math.max(f.x, p.x), y1: Math.max(f.y, p.y) });
  };
  const usable = !!box && box.x1 - box.x0 >= MIN_SIDE && box.y1 - box.y0 >= MIN_SIDE;

  // Poll the job until it ends; cancel it if the screen closes first.
  const jobId = phase.kind === "searching" ? phase.jobId : null;
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    let fails = 0;
    let finished = false;
    const t = window.setInterval(async () => {
      try {
        const s = await getAreaSearch(camera.name, jobId);
        if (!alive) return;
        fails = 0;
        finished = s.status === "success" || s.status === "failed" || s.status === "cancelled";
        const results = [...(s.results ?? [])].sort((a, b) => b.timestamp - a.timestamp);
        if (s.status === "success") setPhase({ kind: "done", results });
        else if (s.status === "failed" || s.status === "cancelled")
          setPhase({ kind: "error", message: "The search stopped before it finished. Try a shorter time." });
        // Frigate gives progress as 0..1, and results while it scans.
        else setPhase({ kind: "searching", jobId, progress: Math.round((s.progress ?? 0) * 100), results });
      } catch {
        // One failed poll is not a failed search; many in a row mean the
        // recorder lost the job (a restart).
        if (alive && ++fails >= MAX_POLL_FAILS) {
          finished = true;
          setPhase({ kind: "error", message: "The recorder stopped answering. Try the search again." });
        }
      }
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
      // Back button, edge swipe, or a new search: a scan nobody waits for stops.
      if (!finished) void cancelAreaSearch(camera.name, jobId);
    };
  }, [camera.name, jobId]);

  const close = () => onClose();

  async function search() {
    if (!box || !usable) return;
    const now = Date.now() / 1000;
    try {
      const id = await startAreaSearch(camera.name, box, now - range, now);
      setPhase({ kind: "searching", jobId: id, progress: 0, results: [] });
    } catch {
      setPhase({ kind: "error", message: "The recorder did not start the search. Try again." });
    }
  }

  const play = (t: number) =>
    onPlay({
      title: `Change ${placePhrase(camera.title)}`,
      camera: camera.name,
      start: t - BEFORE_S,
      clipUrl: `/vod/${camera.name}/start/${Math.floor(t - BEFORE_S)}/end/${Math.ceil(t + AFTER_S)}/index.m3u8`,
      window: { start: Math.floor(t - BEFORE_S), end: Math.ceil(t + AFTER_S) },
      shareUrl: null,
    });

  const now = new Date();
  return (
    <motion.div className="overlay area" {...dialogRoot} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="topbar">
        <button className="round glass" onClick={close} ref={backButton} aria-label="Back">
          <CaretLeft size={20} aria-hidden="true" />
        </button>
        <span className="pill-title glass" id={titleId}>When did this change?</span>
      </div>
      <div className="area-body">
        <div
          ref={pic}
          className="area-pic"
          style={{ aspectRatio: camera.aspect }}
          onPointerDown={(e) => {
            if (phase.kind === "searching") return;
            e.currentTarget.setPointerCapture(e.pointerId);
            from.current = at(e);
            setBox(null);
            setPhase({ kind: "draw" });
          }}
          onPointerMove={drag}
          onPointerUp={(e) => {
            drag(e);
            from.current = null;
          }}
          onPointerCancel={() => (from.current = null)}
        >
          <img src={still} alt={`${camera.title} now`} draggable={false} />
          {box && (
            <span
              className="area-box"
              style={{ left: `${box.x0 * 100}%`, top: `${box.y0 * 100}%`, width: `${(box.x1 - box.x0) * 100}%`, height: `${(box.y1 - box.y0) * 100}%` }}
            />
          )}
          {!box && <span className="area-hint glass">Draw a box around the spot</span>}
        </div>

        <div className="chips" role="group" aria-label="How far back">
          {RANGES.map((r) => (
            <button key={r.s} className="chip" aria-pressed={range === r.s} disabled={phase.kind === "searching"} onClick={() => setRange(r.s)}>
              {r.label}
            </button>
          ))}
        </div>

        {phase.kind === "searching" ? (
          <div className="area-progress" role="status">
            <span>Searching the recordings, {phase.progress}%</span>
            <i style={{ transform: `scaleX(${phase.progress / 100})` }} />
          </div>
        ) : (
          <button className="save" disabled={!usable} onClick={search}>
            <MagnifyingGlass size={18} aria-hidden="true" />
            {usable ? "Find changes" : "Draw a box first"}
          </button>
        )}

        {phase.kind === "error" && (
          <p className="save-status error" role="status">
            <WarningCircle size={16} aria-hidden="true" /> {phase.message}
          </p>
        )}
        {phase.kind === "done" && phase.results.length === 0 && (
          <p className="save-status" role="status">
            Nothing changed in that box in that time.
          </p>
        )}
        {(phase.kind === "done" || phase.kind === "searching") && phase.results.length > 0 && (
          <div className="area-results">
            <p className="when">
              {phase.results.length} {phase.results.length === 1 ? "change" : "changes"}
              {phase.kind === "searching" ? " so far" : ""}, newest first
            </p>
            {phase.results.map((r) => (
              <button key={r.timestamp} className="clip" onClick={() => play(r.timestamp)}>
                <div className="thumb">
                  <img src={frameAtUrl(camera.name, r.timestamp)} alt="" loading="lazy" />
                </div>
                <div>
                  <b>
                    {dayTitle(r.timestamp, now, true)} · {clockTimeSeconds(r.timestamp)}
                  </b>
                  <span className="tnum">{Math.round(r.change_percentage)}% of the box changed</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
