import { ArrowsOut, CaretLeft, DownloadSimple, Export, Pause, Play, SkipBack, SkipForward, MagnifyingGlassMinus } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { usePet } from "../hooks/useAppConfig";
import { useClipShare } from "../hooks/useClipShare";
import { useDialog } from "../hooks/useDialog";
import { useZoomPan } from "../hooks/useZoomPan";
import { shareMode } from "../lib/shareMode";
import { enterFullscreen } from "../lib/fullscreen";
import { getReviewsIn, getSegments } from "../lib/frigate";
import { useTitleOf } from "../hooks/useNames";
import type { Summary } from "../lib/helper";
import { caption } from "../lib/labels";
import {
  LEAD_S,
  buildClipMap,
  momentsFor,
  motionBins,
  playStart,
  titleAt,
  type ClipMap,
  type Moment,
} from "../lib/timeline";
import type { PlayRequest } from "./ActivityFeed";
import { Timeline } from "./Timeline";

const MOTION_BINS = 96;
const CLOSE_PX = 90;
/** How far past a damaged spot "Skip ahead" jumps. */
const SKIP_S = 15;
/** A first decode error skips this far without a word (about one keyframe). */
const QUIET_SKIP_S = 2;
/** Playback speeds the speed button steps through: a 6 min clip often holds 30 s of activity. */
const SPEEDS = [1, 2, 4] as const;


type Track = { map: ClipMap; moments: Moment[]; motion: number[] };

/**
 * Plays one clip with a timeline of what happened in it, starting 2 s before
 * the event the person chose (clip.startAt), or LEAD_S before the first
 * detection. The title pill names the event under the playhead. Share hands the MP4 to the iOS share sheet;
 * where a browser cannot share files, the same button downloads the file.
 * A clip with no window (an untagged export) falls back to native controls.
 * Swipe the picture down to close.
 */
export function ClipPlayer({
  clip,
  summaries = {},
  onClose,
}: {
  clip: PlayRequest;
  /** The vision model's titles by review id, for the title pill. */
  summaries?: Record<string, Summary>;
  onClose: () => void;
}) {
  const pet = usePet();
  const cameraTitle = useTitleOf();
  const { titleId, back: backButton, root: dialogRoot } = useDialog(onClose);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  // undefined while loading, null when there is no timeline.
  const [track, setTrack] = useState<Track | null | undefined>(clip.window ? undefined : null);
  const started = useRef(false);
  const resumeAt = useRef<number | null>(null);
  // Where the last quiet skip happened; a second error near it is shown.
  const quietSkipAt = useRef<number | null>(null);
  // The last position that played. A failed source resets currentTime to 0
  // before the error event, so the error handler cannot read it from there.
  const playedAt = useRef(0);
  const [failed, setFailed] = useState(false);
  // A clip that played and then hit a broken stretch: offer to skip it.
  const [damagedAt, setDamagedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0); // bump to load the clip again
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const { shareState, shareSize, share, name, canShareFiles } = useClipShare(clip);
  useEffect(() => {
    if (!clip.window) return;
    const { start, end } = clip.window;
    let alive = true;
    // One retry: a single aborted request otherwise leaves the clip with no timeline.
    const load = () => Promise.all([getSegments(clip.camera, start, end), getReviewsIn(clip.camera, start, end)]);
    load()
      .catch(() => new Promise((r) => setTimeout(r, 1500)).then(load))
      .then(([segments, reviews]) => {
        if (!alive) return;
        const map = buildClipMap(segments, start, end);
        setTrack({ map, moments: momentsFor(map, reviews), motion: motionBins(map, segments, MOTION_BINS) });
      })
      .catch(() => alive && setTrack(null));
    return () => {
      alive = false;
    };
  }, [clip]);

  // An HLS playlist (an event not yet exported) plays natively on iPhone
  // Safari and through hls.js elsewhere; an MP4 plays directly.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    setFailed(false);
    const isHls = clip.clipUrl.includes(".m3u8");
    if (!isHls || v.canPlayType("application/vnd.apple.mpegurl")) {
      v.src = clip.clipUrl;
      v.load();
      return;
    }
    let hls: { destroy(): void } | null = null;
    let alive = true;
    void import("hls.js")
      .then(({ default: Hls }) => {
        if (!alive) return;
        if (!Hls.isSupported()) return setFailed(true);
        const h = new Hls();
        h.on(Hls.Events.ERROR, (_e, data) => data.fatal && setFailed(true));
        h.loadSource(clip.clipUrl);
        h.attachMedia(v);
        hls = h;
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      hls?.destroy();
    };
  }, [clip.clipUrl, attempt]);

  // Start once both the file and the timeline are known.
  useEffect(() => {
    const v = video.current;
    if (!v || started.current || duration <= 0 || track === undefined) return;
    started.current = true;
    const from = playStart({ map: track?.map ?? null, moments: track?.moments ?? [], startAt: clip.startAt, window: clip.window });
    const at = Math.min(resumeAt.current ?? from, Math.max(0, duration - 1));
    resumeAt.current = null;
    v.currentTime = at;
    v.playbackRate = speed; // a reload resets the rate
    setCurrent(at); // the timeline shows the start point at once, not 0:00
    void v.play().catch(() => setPaused(true));
  }, [duration, track]);

  const seek = (t: number) => {
    if (video.current) video.current.currentTime = t;
    setCurrent(t);
  };
  // Pinch to zoom, one finger to pan; swipe down closes at 1x. Not for the
  // plain player (native controls), whose own taps must reach its controls.
  const zoom = useZoomPan();
  const zoomable = track !== null;
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const toggle = () => {
    const g = zoom.lastGesture();
    if (g.moved || g.multi) return; // the end of a pan or a pinch is not a tap
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };
  const reload = () => {
    started.current = false;
    setDuration(0);
    setFailed(false);
    setDamagedAt(null);
    setAttempt((a) => a + 1);
  };
  const onVideoError = () => {
    // A decode error after the clip has played is a broken stretch, not a lost
    // clip. The first one skips to about the next keyframe without a word; a
    // second error near the same place is shown.
    const at = playedAt.current;
    if (!(started.current && at > 0)) return setFailed(true);
    const last = quietSkipAt.current;
    if (last === null || Math.abs(at - last) > SKIP_S) {
      quietSkipAt.current = at;
      resumeAt.current = at + QUIET_SKIP_S;
      return reload();
    }
    setDamagedAt(at);
  };
  const skipAhead = () => {
    resumeAt.current = (damagedAt ?? current) + SKIP_S;
    reload();
  };
  const loaded = duration > 0 && !failed && damagedAt === null;
  const moments = track?.moments ?? [];
  const next = moments.find((m) => m.start - LEAD_S > current + 0.5);
  const prev = [...moments].reverse().find((m) => m.start - LEAD_S < current - 2);
  // The pill follows the playhead; before playback starts it keeps the title
  // of the row that was tapped.
  const momentTitle = (m: Moment) => (m.id && summaries[m.id]?.title) || caption(m.labels, cameraTitle(clip.camera), pet);
  const title = loaded ? titleAt(moments, current, momentTitle, clip.title) : clip.title;

  // A round button of fixed size: progress shows as a ring and a status line,
  // so a long label never pushes the controls off the sheet.
  const verb = canShareFiles ? "Share" : "Download";
  const pct = shareState.progress ?? 0;
  const clipSeconds = clip.window ? clip.window.end - clip.window.start : duration;
  // A file too large to read into memory gets a plain link: Safari streams it
  // to Files and the page holds none of it (lib/shareMode.ts).
  const asLink = !!clip.shareUrl && !shareState.busy && shareMode(shareSize, clipSeconds) === "link";
  const shareButton = asLink ? (
    <a className="round share" href={clip.shareUrl!} download={name} aria-label="Download clip">
      <DownloadSimple size={20} aria-hidden="true" />
    </a>
  ) : clip.shareUrl && (
    <button
      className={shareState.busy ? "round share busy" : "round share"}
      onClick={share}
      aria-label={shareState.busy ? `Preparing clip, ${pct}%` : `${verb} clip`}
      aria-busy={shareState.busy}
      style={shareState.busy ? { background: `conic-gradient(var(--accent) ${pct * 3.6}deg, var(--line) 0)` } : undefined}
    >
      {canShareFiles ? <Export size={20} aria-hidden="true" /> : <DownloadSimple size={20} aria-hidden="true" />}
    </button>
  );
  const shareStatus = shareState.busy
    ? `Preparing the clip file${shareState.progress ? `, ${shareState.progress}%` : ""}`
    : shareState.error;

  return (
    <motion.div className="overlay" {...dialogRoot} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="topbar">
        <button className="round glass" onClick={onClose} ref={backButton} aria-label="Back">
          <CaretLeft size={20} aria-hidden="true" />
        </button>
        <span className="pill-title glass" id={titleId}>{title}</span>
      </div>
      <div
        ref={(el) => {
          stage.current = el;
          zoom.frame.current = el;
        }}
        className={track === null ? "player" : "player with-sheet zoomable"}
        onPointerDown={(e) => {
          if (!zoomable) return;
          zoom.handlers.onPointerDown(e);
          if (!swipe.current) swipe.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={zoomable ? zoom.handlers.onPointerMove : undefined}
        onPointerUp={(e) => {
          if (!zoomable) return;
          zoom.handlers.onPointerUp(e);
          const from = swipe.current;
          swipe.current = null;
          const g = zoom.lastGesture();
          if (!from || zoom.busy() || g.multi || g.zoomed) return;
          const dx = e.clientX - from.x;
          const dy = e.clientY - from.y;
          if (dy > CLOSE_PX && Math.abs(dy) > Math.abs(dx)) onClose();
        }}
        onPointerCancel={(e) => {
          zoom.handlers.onPointerCancel(e);
          swipe.current = null;
        }}
      >
        <video
          ref={(el) => {
            video.current = el;
            zoom.content.current = el;
          }}
          playsInline
          preload="auto"
          controls={track === null}
          onClick={track === null ? undefined : toggle}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onError={onVideoError}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setCurrent(t);
            if (t > 0) playedAt.current = t;
          }}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
        />
        {zoom.zoomed && (
          <button className="zoom-reset glass" onClick={zoom.reset} onPointerDown={(e) => e.stopPropagation()} aria-label="Zoom out">
            <MagnifyingGlassMinus size={20} aria-hidden="true" />
          </button>
        )}
      </div>
      {track === null ? (
        <div className="player-actions">
          {failed ? (
            <div className="player-error glass" role="alert">
              <span>This clip could not load.</span>
              <button className="action" onClick={reload}>
                Try again
              </button>
            </div>
          ) : (
            <>
              {shareButton}
              {shareStatus && (
                <p className={shareState.error ? "save-status error" : "save-status"} role="status">
                  {shareStatus}
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="sheet glass player-sheet">
          {failed ? (
            <div className="player-error" role="alert">
              <span>This clip could not load.</span>
              <button className="action" onClick={reload}>
                Try again
              </button>
            </div>
          ) : damagedAt !== null ? (
            <div className="player-error" role="alert">
              <span>Part of this clip is damaged.</span>
              <button className="action" onClick={skipAhead}>
                Skip ahead {SKIP_S} s
              </button>
            </div>
          ) : !loaded ? (
            <div className="player-error" role="status">
              <span>Loading clip</span>
            </div>
          ) : (
            <Timeline
              duration={duration}
              current={current}
              map={track?.map ?? null}
              moments={moments}
              motion={track?.motion ?? []}
              onSeek={seek}
            />
          )}
          <div className="player-controls">
            <button className="round" onClick={() => prev && seek(Math.max(0, prev.start - LEAD_S))} aria-label="Previous moment" disabled={!loaded || !prev}>
              <SkipBack size={20} aria-hidden="true" />
            </button>
            <button className="round play" onClick={toggle} aria-label={paused ? "Play" : "Pause"} disabled={!loaded}>
              {paused ? <Play size={22} weight="fill" aria-hidden="true" /> : <Pause size={22} weight="fill" aria-hidden="true" />}
            </button>
            <button className="round" onClick={() => next && seek(Math.max(0, next.start - LEAD_S))} aria-label="Next moment" disabled={!loaded || !next}>
              <SkipForward size={20} aria-hidden="true" />
            </button>
            <button
              className="round speed tnum"
              onClick={() => {
                const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
                setSpeed(next);
                if (video.current) video.current.playbackRate = next;
              }}
              aria-label={`Speed ${speed} times, change`}
              disabled={!loaded}
            >
              {speed}×
            </button>
            <button className="round" onClick={() => stage.current && enterFullscreen(stage.current)} aria-label="Full screen" disabled={!loaded}>
              <ArrowsOut size={20} aria-hidden="true" />
            </button>
            <span className="grow" />
            {!failed && shareButton}
          </div>
          {shareStatus && (
            <p className={shareState.error ? "save-status error" : "save-status"} role="status">
              {shareStatus}
            </p>
          )}
        </div>
      )}
    </motion.div>
  );
}
