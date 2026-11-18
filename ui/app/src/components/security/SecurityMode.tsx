import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePet } from "../../hooks/useAppConfig";
import { isTouchScreen, useElementSize } from "../../hooks/useElementSize";
import { useEscape } from "../../hooks/useEscape";
import { useIdle } from "../../hooks/useIdle";
import { usePoll } from "../../hooks/usePoll";
import { useWakeLock } from "../../hooks/useWakeLock";
import { activeDetections, followStep, mergeReviews, newestEvents, pickCamera, startFollow, type Follow } from "../../lib/detections";
import type { EventEntry, ReviewItem } from "../../lib/feed";
import { cameraTitle, getReviews, latestUrl, type CameraInfo } from "../../lib/frigate";
import { focusReturn } from "../../lib/focusReturn";
import { canFullscreenPage, enterPageFullscreen, leavePageFullscreen } from "../../lib/fullscreen";
import { isTall, wallLayout } from "../../lib/grid";
import { arrowStep, keyBelongsToControl } from "../../lib/keys";
import type { Summary } from "../../lib/helper";
import { caption } from "../../lib/labels";
import { LIVE_CAP_DESKTOP, LIVE_CAP_TOUCH, pickLive } from "../../lib/liveCap";
import type { SaveMinutes } from "../../lib/saveWindow";
import { frameOf, handOver, stillFileName } from "../../lib/saveFile";
import { serverNow } from "../../lib/serverClock";
import { usesCleanStream } from "../../lib/streamChoice";
import { readWallPrefs, wallNames, writeWallPrefs, type WallPrefs } from "../../lib/wallPrefs";
import type { PlayRequest } from "../ActivityFeed";
import { CameraView } from "../CameraView";
import { ClipPlayer } from "../ClipPlayer";
import { EventStrip } from "./EventStrip";
import { WallControls } from "./WallControls";
import { WallEditor } from "./WallEditor";
import { WallTile } from "./WallTile";

/** The wall asks Frigate for the review items of the last hour this often, for the marks. */
const FAST_POLL_MS = 4000;
const FAST_WINDOW_S = 3600;
/** The events strip shows this many events. */
const STRIP_EVENTS = 24;
/** The controls hide after this long with no input. */
const IDLE_MS = 4000;

type Layer = { kind: "clip"; clip: PlayRequest } | { kind: "camera"; name: string } | { kind: "edit" } | null;

/**
 * Security mode: every camera on one screen with no page chrome, for a person
 * who watches several cameras at once.
 *
 * - Grid: all cameras the same size (lib/grid.ts wallLayout). A tap
 *   spotlights a camera.
 * - Spotlight: one camera large, the others in a strip. A tap on a strip tile
 *   spotlights it; a tap on the large tile opens the camera view.
 * - A mark on a tile while Frigate has an active detection on its camera.
 * - The newest events of all cameras in a strip; a tap plays the clip over
 *   the wall, and Back returns to the wall.
 * - Follow activity: the spotlight goes to the camera with the newest active
 *   detection (lib/detections.ts followStep).
 * - The screen stays on (Wake Lock); full screen where the browser allows it.
 * - Sound only on the spotlight tile, off at the start.
 * - Hide cameras and change their order (WallEditor), kept on this device.
 * - Save a still of the spotlight camera to the device.
 *
 * At most LIVE_CAP_* tiles play live (lib/liveCap.ts): the spotlight first,
 * then the cameras with a detection. The others show a still that
 * refreshes. While a clip or the camera view is open, the wall shows stills.
 */
export function SecurityMode({
  cameras,
  online,
  reviews,
  events,
  summaries,
  downText,
  onSave,
  onClose,
}: {
  cameras: CameraInfo[];
  online: Record<string, boolean> | undefined;
  /** The review items of the home feed (the last two days). */
  reviews: ReviewItem[];
  /** The feed entries, for the clip that covers an event. */
  events: EventEntry[];
  summaries: Record<string, Summary>;
  downText: (camera: string) => string;
  onSave: (camera: string, minutes: SaveMinutes) => Promise<{ success: boolean; message: string }>;
  onClose: () => void;
}) {
  const pet = usePet();
  const root = useRef<HTMLDivElement>(null);
  const exitButton = useRef<HTMLButtonElement>(null);
  const [prefs, setPrefsState] = useState<WallPrefs>(readWallPrefs);
  const setPrefs = (p: WallPrefs) => {
    setPrefsState(p);
    writeWallPrefs(p);
  };
  const [layer, setLayerState] = useState<Layer>(null);
  // Focus goes back to the control that opened a layer (lib/focusReturn.ts).
  const opener = useRef(focusReturn());
  const setLayer = (l: Layer) => {
    if (l && !layer) opener.current.remember(document.activeElement as HTMLElement | null);
    setLayerState(l);
  };
  useEffect(() => {
    if (!layer) opener.current.restore();
  }, [layer]);
  const [spot, setSpot] = useState<Follow>(() => startFollow(null));
  const [follow, setFollow] = useState(false);
  const [sound, setSound] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const idle = useIdle(IDLE_MS);
  useWakeLock(true);
  useEscape(onClose);

  useEffect(() => {
    exitButton.current?.focus({ preventScroll: true });
    const onFull = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFull);
    return () => {
      document.removeEventListener("fullscreenchange", onFull);
      leavePageFullscreen();
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // The home feed polls every 10 s. The marks need a faster answer, so the
  // wall also asks for the last hour every few seconds.
  const fast = usePoll(() => getReviews(serverNow() - FAST_WINDOW_S), FAST_POLL_MS);
  const all = useMemo(() => mergeReviews(reviews, fast.data ?? []), [reviews, fast.data]);
  const active = useMemo(() => activeDetections(all, serverNow()), [all]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const strip = useMemo(() => newestEvents(all, STRIP_EVENTS), [all]);

  const byName = new Map(cameras.map((c) => [c.name, c]));
  const isOffline = (c: CameraInfo) => !c.liveOnly && online?.[c.name] === false;
  const shown = wallNames(
    cameras.map((c) => c.name),
    prefs,
  ).map((n) => byName.get(n)!);
  const onWall = shown.filter((c) => !isOffline(c));
  const offlineTitles = shown.filter(isOffline).map((c) => c.title);
  const spotName = onWall.some((c) => c.name === spot.camera) ? spot.camera! : (active.find((a) => onWall.some((c) => c.name === a.camera))?.camera ?? onWall[0]?.name ?? null);
  const view = prefs.view;

  // Follow activity: one step each second, and at once when it is turned on.
  useEffect(() => {
    if (!follow) return;
    const step = () => setSpot((f) => followStep(f, activeRef.current, Date.now()));
    step();
    const t = window.setInterval(step, 1000);
    return () => window.clearInterval(t);
  }, [follow]);

  const spotlight = (name: string) => {
    setSpot(pickCamera(name, Date.now()));
    if (view !== "spotlight") setPrefs({ ...prefs, view: "spotlight" });
  };
  const openCamera = (name: string) => setLayer({ kind: "camera", name });

  // The live tiles. A clip or the camera view covers the wall: then no tile plays.
  const covered = layer !== null && layer.kind !== "edit";
  const others = onWall.filter((c) => c.name !== spotName);
  const order = view === "spotlight" && spotName ? [byName.get(spotName)!, ...others] : onWall;
  const live = covered
    ? new Set<string>()
    : pickLive(
        order.map((c) => ({ name: c.name, canPlay: !c.liveOnly || (view === "spotlight" && c.name === spotName) })),
        isTouchScreen() ? LIVE_CAP_TOUCH : LIVE_CAP_DESKTOP,
        { spotlight: view === "spotlight" ? spotName : null, active: active.map((a) => a.camera) },
      );
  const detectionOf = (name: string) => active.find((a) => a.camera === name);

  const area = useElementSize<HTMLDivElement>();
  const grid = wallLayout(
    onWall.map((c) => (c.liveOnly ? 16 / 9 : c.aspect)),
    area.width,
    area.height,
  );

  // The arrow keys: in the spotlight layout they change the spotlight camera;
  // in the grid they move the focus from tile to tile.
  useEffect(() => {
    if (layer) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.key.startsWith("Arrow") || e.defaultPrevented || keyBelongsToControl(e.target)) return;
      if (view === "spotlight") {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const i = onWall.findIndex((c) => c.name === spotName);
        const next = arrowStep(e.key, Math.max(0, i), onWall.length);
        if (next !== null) {
          e.preventDefault();
          setSpot(pickCamera(onWall[next].name, Date.now()));
        }
        return;
      }
      const tiles = [...(root.current?.querySelectorAll<HTMLButtonElement>(".wall-grid .wall-tile") ?? [])];
      const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
      const next = arrowStep(e.key, Math.max(0, i), tiles.length, grid.cols);
      if (next !== null) {
        e.preventDefault();
        tiles[next]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const playEvent = (r: ReviewItem) => {
    const e = events.find((x) => x.reviewIds.includes(r.id));
    if (!e?.clipUrl) return spotlight(r.camera); // in progress: no clip yet
    const m = e.moments.find((x) => x.id === r.id);
    const title = summaries[r.id]?.title ?? caption(m?.labels ?? e.labels, cameraTitle(e.camera), pet);
    setLayer({ kind: "clip", clip: { title, camera: e.camera, start: e.start, clipUrl: e.clipUrl, window: e.window, shareUrl: e.shareUrl, startAt: r.start_time } });
  };

  async function saveStill() {
    if (!spotName) return;
    const title = byName.get(spotName)?.title ?? spotName;
    const at = new Date();
    try {
      // The frame on screen first; Frigate's latest still when the tile has no frame.
      const videos = root.current?.querySelectorAll<HTMLVideoElement>(".wall-tile.spot video");
      let file = await frameOf(videos?.[videos.length - 1] ?? null, stillFileName(spotName, at));
      if (!file) {
        const r = await fetch(latestUrl(spotName, 1080), { credentials: "same-origin" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        file = new File([await r.blob()], stillFileName(spotName, at, "webp"), { type: "image/webp" });
      }
      // The share sheet on a phone (it can save to Photos); a download on a desktop.
      await handOver(file, title, isTouchScreen());
      setNotice(`Saved a still of ${title}`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setNotice("Could not save the still. Try again.");
    }
  }

  const tile = (c: CameraInfo, isSpot: boolean) => (
    <WallTile
      key={c.name}
      camera={c}
      live={live.has(c.name)}
      clean={usesCleanStream({ kind: "wall", wallCameras: onWall.length })}
      spotlight={isSpot}
      sound={sound}
      detection={detectionOf(c.name)}
      label={isSpot ? `Open ${c.title}` : `Spotlight ${c.title}`}
      onSoundRefused={() => {
        setSound(false);
        setNotice("The browser did not allow sound. Tap Sound again.");
      }}
      onActivate={() => (isSpot ? openCamera(c.name) : spotlight(c.name))}
    />
  );

  const cameraLayer = layer?.kind === "camera" ? layer : null;
  const cameraIndex = cameraLayer ? cameras.findIndex((c) => c.name === cameraLayer.name) : -1;
  const showControls = !idle || layer !== null;
  // A touch on the wall while the controls are hidden shows the controls and
  // does nothing else: the wall moves down under them (security.css), so the
  // tile under the finger at the touch is not the tile at the lift.
  const wakeTouch = useRef(false);

  return (
    <motion.div
      ref={root}
      className={showControls ? "security" : "security idle"}
      onPointerDownCapture={(e) => {
        wakeTouch.current = !showControls && e.pointerType !== "mouse";
      }}
      onClickCapture={(e) => {
        if (!wakeTouch.current) return;
        wakeTouch.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Security mode"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="security-body" inert={layer !== null}>
        <WallControls
          ref={exitButton}
          view={view}
          follow={follow}
          sound={sound}
          full={full}
          hasSpotlight={view === "spotlight" && !!spotName}
          canFull={canFullscreenPage()}
          onExit={onClose}
          onView={(v) => setPrefs({ ...prefs, view: v })}
          onFollow={() => {
            const on = !follow;
            setFollow(on);
            if (on) {
              setSpot((f) => ({ ...f, holdUntil: 0 }));
              if (view !== "spotlight") setPrefs({ ...prefs, view: "spotlight" });
            }
          }}
          onSound={() => setSound(!sound)}
          onStill={saveStill}
          onEdit={() => setLayer({ kind: "edit" })}
          onFull={() => (full ? leavePageFullscreen() : root.current && void enterPageFullscreen(root.current, isTouchScreen()))}
        />

        <div ref={area.ref} className={view !== "spotlight" ? "wall-area" : others.length > 0 ? "wall-area spotlight" : "wall-area spotlight solo"}>
          {onWall.length === 0 ? (
            <p className="wall-empty">{shown.length === 0 ? "Every camera is hidden. Choose cameras to show them here." : "No camera is online."}</p>
          ) : view === "spotlight" && spotName ? (
            <>
              <div className="wall-main" style={{ ["--spot-a" as string]: byName.get(spotName)!.liveOnly ? 16 / 9 : byName.get(spotName)!.aspect }}>
                {tile(byName.get(spotName)!, true)}
              </div>
              {others.length > 0 && (
                <div className="wall-side" role="group" aria-label="Other cameras">
                  {others.map((c) => tile(c, false))}
                </div>
              )}
            </>
          ) : (
            <div
              className="wall-grid"
              style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridTemplateRows: grid.rowHeight > 0 ? `repeat(${grid.rows}, ${grid.rowHeight}px)` : `repeat(${grid.rows}, minmax(0, 1fr))` }}
            >
              {onWall.map((c) =>
                isTall(c.aspect) && !c.liveOnly && grid.rows > 1 ? (
                  <div key={c.name} className="wall-cell tall">
                    {tile(c, false)}
                  </div>
                ) : (
                  <div key={c.name} className="wall-cell">
                    {tile(c, false)}
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        <EventStrip events={strip} offline={offlineTitles} onPick={playEvent} />
        {notice && (
          <p className="wall-notice glass" role="status">
            {notice}
          </p>
        )}
      </div>

      <AnimatePresence>
        {layer?.kind === "clip" && <ClipPlayer key="clip" clip={layer.clip} summaries={summaries} onClose={() => setLayer(null)} />}
        {cameraLayer && cameraIndex >= 0 && (
          <CameraView
            key="camera"
            cameras={cameras}
            index={cameraIndex}
            online={online}
            downText={downText}
            onIndex={(i) => setLayer({ kind: "camera", name: cameras[i].name })}
            onClose={() => setLayer(null)}
            onSave={onSave}
            onPlay={(clip) => setLayer({ kind: "clip", clip })}
          />
        )}
        {layer?.kind === "edit" && <WallEditor key="edit" cameras={cameras} prefs={prefs} onChange={setPrefs} onClose={() => setLayer(null)} />}
      </AnimatePresence>
    </motion.div>
  );
}
