import { useEffect, useRef, useState } from "react";
import { reportLive, type CamStream } from "../lib/camStream";
import { latestUrl, liveWsUrl, type CameraInfo } from "../lib/frigate";
import { sourceStep, startSource, type StreamKind } from "../lib/liveSource";
import { liveStep, showsStill, startWatch, watchNewElement, type LiveWatch } from "../lib/liveWatch";

/**
 * Live MSE video for one camera, inside a box that sets its aspect.
 * Shows the latest still until frames move. go2rtc's element reconnects when
 * its socket closes; a stream that freezes with the socket open is restarted
 * here. After 30 s with no frame the tile says it cannot connect, and keeps
 * trying. The rules are in lib/liveWatch.ts.
 *
 * A camera with a clean stream starts on the direct stream. The clean element
 * loads under it, covered, and the tile changes to the clean stream when
 * the clean stream plays. The rules are in lib/liveSource.ts. The stall watch
 * always reads the shown element.
 *
 * The clean stream costs the server 0.8 of one CPU core for each viewer and
 * camera. lib/streamChoice.ts decides where a tile may ask for it; a tile
 * with `clean` false plays the direct stream only.
 *
 * `sound` unmutes the video. A browser can refuse sound without a tap on the
 * page; VideoRTC then mutes the video again so that it keeps playing, and
 * `onSoundRefused` tells the caller.
 */
export function LiveVideo({
  camera,
  clean = true,
  sound = false,
  onSoundRefused,
}: {
  camera: CameraInfo;
  clean?: boolean;
  sound?: boolean;
  onSoundRefused?: () => void;
}) {
  const soundRef = useRef({ sound, onSoundRefused });
  soundRef.current = { sound, onSoundRefused };
  const host = useRef<HTMLDivElement>(null);
  const [watch, setWatch] = useState<LiveWatch>(() => startWatch(Date.now()));
  // The stillAt value whose still failed to load. A new stillAt tries again.
  const [failedStill, setFailedStill] = useState<number | null>(null);

  useEffect(() => {
    const box = host.current;
    const make = (stream: string, kind: StreamKind) => {
      const el = document.createElement("cam-stream") as CamStream;
      el.mode = "mse";
      el.streamKind = kind;
      if (camera.liveOnly) el.setAttribute("fit", "contain");
      el.src = liveWsUrl(stream);
      return el;
    };

    // The shown element, and the clean element while it loads under it. The
    // clean element comes first in the DOM, so the direct element covers it:
    // the two have the same box. The clean element has no opacity: 0, no
    // display: none and no hidden attribute. WebKit pauses a muted video that
    // it counts as not visible, and it is not tested whether opacity: 0
    // counts. A covered element is the safe case.
    let shown = make(camera.name, "direct");
    box?.appendChild(shown);
    const cleanStream = clean ? camera.cleanStream : null;
    let cleanEl: CamStream | null = null;
    if (cleanStream) {
      cleanEl = make(cleanStream, "clean");
      box?.insertBefore(cleanEl, shown);
    }
    // The sound that the shown element was last asked for, so that a change
    // of element or of the setting unmutes once, not on each tick.
    let soundAsked: { el: CamStream; on: boolean } | null = null;

    const opened = Date.now();
    let w = startWatch(opened);
    let src = startSource(opened, cleanEl !== null);
    const timer = window.setInterval(() => {
      const now = Date.now();
      const v = shown.video;
      const r = liveStep(w, {
        now,
        hidden: document.hidden,
        readyState: v ? v.readyState : -1,
        currentTime: v?.currentTime ?? 0,
      });
      if (r.restart) {
        reportLive("restart", shown);
        shown.restart();
      }
      if (r.reportStall) reportLive("stall", shown);
      let n = r.watch;

      const cv = cleanEl?.video;
      const s = sourceStep(src, {
        now,
        hidden: document.hidden,
        clean: cleanEl ? { readyState: cv ? cv.readyState : -1, currentTime: cv?.currentTime ?? 0 } : null,
        // liveStep clears stalledSince only on a tick on which the frames moved.
        shownMoving: !document.hidden && n.stalledSince === 0,
      });
      src = s.source;
      if (s.swap && cleanEl) {
        reportLive("swap", cleanEl, { ms: now - opened });
        shown.dispose(); // the clean element under it is now in view
        shown = cleanEl;
        cleanEl = null;
        n = watchNewElement(n, now, true);
      }
      if (s.giveUp && cleanEl) {
        reportLive("clean", cleanEl, { result: "gave_up" });
        cleanEl.dispose();
        cleanEl = null;
      }
      if (s.fallBack) {
        const old = shown;
        reportLive("clean", old, { result: "fell_back" });
        shown = make(camera.name, "direct");
        box?.appendChild(shown);
        old.dispose();
        n = watchNewElement(n, now, false);
      }

      const want = soundRef.current.sound;
      const sv = shown.video;
      if (sv && (soundAsked?.el !== shown || soundAsked.on !== want)) {
        soundAsked = { el: shown, on: want };
        sv.muted = !want;
        if (want) shown.play(); // VideoRTC mutes again if the browser refuses
      } else if (sv && want && sv.muted && soundAsked?.el === shown) {
        soundAsked = { el: shown, on: false };
        soundRef.current.onSoundRefused?.();
      }

      // Render only when something on screen changes, not on every tick.
      if (n.status !== w.status || n.showStatus !== w.showStatus || n.hasFrame !== w.hasFrame || n.stillAt !== w.stillAt)
        setWatch(n);
      w = n;
    }, 1000);

    return () => {
      window.clearInterval(timer);
      shown.dispose();
      cleanEl?.dispose();
    };
  }, [camera.name, camera.liveOnly, camera.cleanStream, clean]);

  const { status, showStatus, stillAt } = watch;
  const still = showsStill(watch);
  // Live-only streams are not Frigate cameras, so Frigate has no still for them.
  const poster = camera.liveOnly || failedStill === stillAt ? null : `${latestUrl(camera.name)}&t=${stillAt}`;
  return (
    <div className="live">
      {poster && <img className="poster" src={poster} alt="" hidden={!still} onError={() => setFailedStill(stillAt)} />}
      <div ref={host} className="stream" style={{ opacity: still ? 0 : 1 }} />
      {showStatus && status !== "playing" && (
        <span className="status glass" role="status">
          {status === "reconnecting" ? "Reconnecting" : status === "failed" ? "Can't connect, still trying" : "Connecting"}
        </span>
      )}
    </div>
  );
}
