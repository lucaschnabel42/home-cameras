import type { ActiveDetection } from "../../lib/detections";
import type { CameraInfo } from "../../lib/frigate";
import { DetectionMark } from "../LiveTile";
import { LiveVideo } from "../LiveVideo";
import { OrbField } from "../OrbField";
import { StillImage } from "../StillImage";

/**
 * One camera on the security wall. The cell can have any shape; the picture
 * keeps the camera's own shape inside it (.wall-pic, sized with container
 * units), so an upright doorbell is not stretched.
 *
 * A wall tile plays the direct stream, except where lib/streamChoice.ts
 * allows the clean stream (`clean`). Only the spotlight tile can have sound.
 */
export function WallTile({
  camera,
  live,
  clean,
  spotlight,
  sound,
  detection,
  label,
  onSoundRefused,
  onActivate,
}: {
  camera: CameraInfo;
  live: boolean;
  clean: boolean;
  spotlight: boolean;
  sound: boolean;
  detection?: ActiveDetection;
  /** The accessible name of the tile button: what a tap does. */
  label: string;
  onSoundRefused: () => void;
  onActivate: () => void;
}) {
  const classes = ["wall-tile", spotlight && "spot", detection && "detecting"].filter(Boolean).join(" ");
  return (
    <button className={classes} onClick={onActivate} aria-label={label} data-camera={camera.name}>
      <span className="wall-frame">
        <span className="wall-pic" style={{ ["--a" as string]: camera.liveOnly ? 16 / 9 : camera.aspect }}>
          {camera.liveOnly && !live ? (
            <OrbField>
              <span className="orb-label">Live on demand</span>
            </OrbField>
          ) : live ? (
            <LiveVideo camera={camera} clean={clean} sound={spotlight && sound} onSoundRefused={onSoundRefused} />
          ) : (
            <StillImage camera={camera.name} height={spotlight ? 720 : 360} />
          )}
          {detection && <DetectionMark detection={detection} />}
          <span className="wall-name glass">{camera.title}</span>
        </span>
      </span>
    </button>
  );
}
