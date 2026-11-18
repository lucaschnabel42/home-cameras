import { ArrowsOut, CaretLeft, MagnifyingGlass, MagnifyingGlassMinus } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useDialog } from "../hooks/useDialog";
import { useZoomPan } from "../hooks/useZoomPan";
import type { CameraInfo } from "../lib/frigate";
import type { SaveMinutes } from "../lib/saveWindow";
import { enterFullscreen } from "../lib/fullscreen";
import { arrowStep, keyBelongsToControl } from "../lib/keys";
import type { PlayRequest } from "./ActivityFeed";
import { AreaSearch } from "./AreaSearch";
import { LiveVideo } from "./LiveVideo";
import { OrbField } from "./OrbField";
import { RewindDial } from "./RewindDial";

const SWIPE_PX = 60;
const CLOSE_PX = 90;

/**
 * One camera full width over the orb field, with the rewind dial. Swipe the
 * picture sideways to change camera, or down to close. The stage is keyed by
 * camera with no shared layout id, so a swipe replaces the old stream instead
 * of leaving it playing underneath.
 */
export function CameraView({
  cameras,
  index,
  online,
  downText,
  onIndex,
  onClose,
  onSave,
  onPlay,
}: {
  cameras: CameraInfo[];
  index: number;
  /** camera -> online; a camera missing from it is unknown (stats failed), not offline. */
  online: Record<string, boolean> | undefined;
  /** The sentence for a camera that does not record (lib/downSince.ts). */
  downText: (camera: string) => string;
  onIndex: (i: number) => void;
  onClose: () => void;
  onSave: (camera: string, minutes: SaveMinutes) => Promise<{ success: boolean; message: string }>;
  onPlay: (p: PlayRequest) => void;
}) {
  const [searching, setSearching] = useState(false);
  const { titleId, back: backButton, root: dialogRoot } = useDialog(onClose);
  // Area search opens over this view: the view behind it is inert, and focus
  // goes back to the search button when it closes.
  const searchButton = useRef<HTMLButtonElement>(null);
  const wasSearching = useRef(false);
  useEffect(() => {
    if (wasSearching.current && !searching) searchButton.current?.focus({ preventScroll: true });
    wasSearching.current = searching;
  }, [searching]);
  const camera = cameras[index];
  // Pinch to zoom the live picture, one finger to pan it; swipes work at 1x.
  const zoom = useZoomPan();
  useEffect(() => zoom.reset(), [camera.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const stage = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  // The arrow keys change the camera, as a swipe does. A control that reads
  // arrow keys itself (the rewind dial) keeps them.
  useEffect(() => {
    if (searching) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || keyBelongsToControl(e.target)) return;
      const next = arrowStep(e.key, index, cameras.length);
      if (next === null || next === index) return;
      e.preventDefault();
      onIndex(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searching, index, cameras.length, onIndex]);
  // A live-only stream has no Frigate stats; go2rtc says whether it connects.
  const isOnline = camera.liveOnly || online?.[camera.name] !== false;
  return (
    <motion.div className="overlay" {...dialogRoot} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <OrbField big />
      <div className="topbar" inert={searching}>
        <button className="round glass" onClick={onClose} ref={backButton} aria-label="Back">
          <CaretLeft size={20} aria-hidden="true" />
        </button>
        <span className="pill-title glass" id={titleId}>{camera.title}</span>
        <span className="grow" />
        {!camera.liveOnly && (
          <button ref={searchButton} className="round glass" onClick={() => setSearching(true)} aria-label="When did this change?">
            <MagnifyingGlass size={20} aria-hidden="true" />
          </button>
        )}
        {isOnline && (
          <button className="round glass" onClick={() => stage.current && enterFullscreen(stage.current)} aria-label="Full screen">
            <ArrowsOut size={20} aria-hidden="true" />
          </button>
        )}
      </div>
      {/* The stage and the dial each need their own key. With one key for
          both, React keeps the old stage after a swipe, and the old stream
          keeps playing under the new one. */}
      <div className="cam-column" inert={searching}>
        <div
          key={`stage-${camera.name}`}
          ref={(el) => {
            stage.current = el;
            zoom.frame.current = el;
          }}
          className={isOnline ? "cam-stage" : "cam-stage solid"}
          style={{ aspectRatio: camera.aspect, ["--a" as string]: camera.aspect }}
          onPointerDown={(e) => {
            zoom.handlers.onPointerDown(e);
            if (!swipe.current) swipe.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerMove={zoom.handlers.onPointerMove}
          onPointerUp={(e) => {
            zoom.handlers.onPointerUp(e);
            const from = swipe.current;
            swipe.current = null;
            if (!from || zoom.busy()) return; // a finger of a pinch lifted first
            // A pinch, or any gesture on a zoomed picture, is zoom and pan, not a swipe.
            const gst = zoom.lastGesture();
            if (gst.multi || gst.zoomed) return;
            const dx = e.clientX - from.x;
            const dy = e.clientY - from.y;
            if (dy > CLOSE_PX && Math.abs(dy) > Math.abs(dx)) return onClose();
            if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return;
            if (dx < 0 && index < cameras.length - 1) onIndex(index + 1);
            if (dx > 0 && index > 0) onIndex(index - 1);
          }}
          onPointerCancel={(e) => {
            zoom.handlers.onPointerCancel(e);
            swipe.current = null;
          }}
        >
          {isOnline ? (
            <div
              ref={(el) => {
                zoom.content.current = el;
              }}
              className="zoom-layer"
            >
              <LiveVideo camera={camera} />
            </div>
          ) : (
            <OrbField>
              <span className="orb-label down">
                Offline
                <small className="tnum">{downText(camera.name)}</small>
              </span>
            </OrbField>
          )}
          {zoom.zoomed && (
            <button className="zoom-reset glass" onClick={zoom.reset} onPointerDown={(e) => e.stopPropagation()} aria-label="Zoom out">
              <MagnifyingGlassMinus size={20} aria-hidden="true" />
            </button>
          )}
        </div>
        {cameras.length > 1 && (
          // A tap on a dot changes the camera, so VoiceOver and Switch Control
          // do not need the swipe. Each dot is a 44 px button named by its camera.
          <div className="page-dots" role="group" aria-label="Cameras">
            {cameras.map((c, i) => (
              <button
                key={c.name}
                className={i === index ? "on" : undefined}
                aria-label={c.title}
                aria-current={i === index ? "true" : undefined}
                onClick={() => i !== index && onIndex(i)}
              />
            ))}
          </div>
        )}
        {camera.liveOnly ? (
          <div className="sheet glass note">
            <b>Live view only</b>
            <span>This camera streams only while you watch, and nothing records it yet.</span>
          </div>
        ) : (
          <RewindDial key={`dial-${camera.name}`} camera={camera} onSave={(m) => onSave(camera.name, m)} />
        )}
      </div>
      <AnimatePresence>
        {searching && <AreaSearch key="area" camera={camera} onClose={() => setSearching(false)} onPlay={onPlay} />}
      </AnimatePresence>
    </motion.div>
  );
}
