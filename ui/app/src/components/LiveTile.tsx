import { motion } from "motion/react";
import { usePet } from "../hooks/useAppConfig";
import type { ActiveDetection } from "../lib/detections";
import type { CameraInfo } from "../lib/frigate";
import { subject } from "../lib/labels";
import { LiveVideo } from "./LiveVideo";
import { OrbField } from "./OrbField";
import { StillImage } from "./StillImage";

/**
 * The mark on a tile while Frigate has an active detection on its camera:
 * a dot and what is in view ("Person", "Car").
 */
export function DetectionMark({ detection }: { detection: ActiveDetection }) {
  const pet = usePet();
  return (
    <span className="detect-mark glass" role="status">
      <i className="detect-dot" aria-hidden="true" />
      {subject(detection.labels, pet)}
    </span>
  );
}

/**
 * One camera on the home screen. An online camera plays live when `live` is
 * true (the grid gives a limited count of live tiles, lib/liveCap.ts) and
 * shows a still that refreshes when it is false. An offline camera is a short
 * orb strip. While an overlay covers the home screen (`paused`) the tile
 * shows a still, so no hidden stream uses data.
 */
export function LiveTile({
  camera,
  online,
  down,
  live,
  clean,
  paused,
  detection,
  onOpen,
}: {
  camera: CameraInfo;
  /** undefined when the stats are not known: the tile then tries to play. */
  online: boolean | undefined;
  /** "Not recording since Oct 15, 7:01 pm (33 days)" (lib/downSince.ts). */
  down: string;
  live: boolean;
  /** Ask for the clean stream (lib/streamChoice.ts). */
  clean: boolean;
  paused: boolean;
  detection?: ActiveDetection;
  onOpen: () => void;
}) {
  const offline = !camera.liveOnly && online === false;
  const playing = live && !paused;
  const classes = ["tile", offline && "compact", detection && "detecting"].filter(Boolean).join(" ");
  return (
    <div className="tile-cell">
      <motion.button
        className={classes}
        // A live-only tile shows no video at home, so it keeps the 16:9 shape.
        style={offline ? undefined : { aspectRatio: camera.liveOnly ? 16 / 9 : camera.aspect }}
        onClick={onOpen}
        aria-label={`Open ${camera.title}`}
      >
        {camera.liveOnly ? (
          <OrbField>
            <span className="orb-label">Tap for live view</span>
          </OrbField>
        ) : offline ? (
          <OrbField>
            <span className="orb-label">Offline</span>
          </OrbField>
        ) : playing ? (
          <LiveVideo camera={camera} clean={clean} />
        ) : (
          <StillImage camera={camera.name} height={480} refreshMs={paused ? null : undefined} />
        )}
        {detection && <DetectionMark detection={detection} />}
      </motion.button>
      <div className="tile-meta">
        <b>{camera.title}</b>
        <span className="tnum">{camera.liveOnly ? "Live on demand" : offline ? down : playing ? "Live" : "Still"}</span>
      </div>
    </div>
  );
}
