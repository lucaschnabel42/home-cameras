import { isTouchScreen, useElementSize } from "../hooks/useElementSize";
import type { ActiveDetection } from "../lib/detections";
import type { CameraInfo } from "../lib/frigate";
import { HOME_GAP, homeColumns, isTall, sectionColumns } from "../lib/grid";
import { LIVE_CAP_DESKTOP, LIVE_CAP_TOUCH, pickLive } from "../lib/liveCap";
import { usesCleanStream } from "../lib/streamChoice";
import { LiveTile } from "./LiveTile";

/** A home tile can play live: a recorded camera that is not offline. */
export const canPlayLive = (c: CameraInfo, online: Record<string, boolean> | undefined) => !c.liveOnly && online?.[c.name] !== false;

/**
 * The cameras on the home screen. One or two cameras on a phone stack as
 * full-width tiles, in config order. More cameras form a grid
 * (lib/grid.ts): an upright camera (a doorbell) takes two rows, and the
 * offline cameras go to a row of short tiles under the grid, so they do not
 * take the space of a live picture. Only some tiles play live
 * (lib/liveCap.ts); the camera with an active detection plays first.
 */
export function CameraGrid({
  cameras,
  online,
  active,
  paused,
  downText,
  onOpen,
  live: given,
  liveTotal,
  section,
}: {
  cameras: CameraInfo[];
  online: Record<string, boolean> | undefined;
  active: ActiveDetection[];
  paused: boolean;
  downText: (camera: string) => string;
  onOpen: (camera: string) => void;
  /** The live tiles, when a caller shares one cap among several grids (GroupBoard). */
  live?: Set<string>;
  /** The live tiles of all those grids, for the choice of stream. */
  liveTotal?: number;
  /** A grid in a group section: small tiles even for one camera. */
  section?: boolean;
}) {
  const { ref, width } = useElementSize<HTMLDivElement>();
  const isOffline = (c: CameraInfo) => !c.liveOnly && online?.[c.name] === false;
  const shown = cameras.filter((c) => !isOffline(c));
  const cols = (section ? sectionColumns : homeColumns)(shown.length, width || 358);
  // One column keeps the config order with the offline tiles in place: the
  // home screen of one or two cameras does not change. A section keeps the
  // small tiles, so that sections next to each other look the same.
  const stacked = cols === 1 && !section;
  const onGrid = cols === 1 ? cameras : shown;
  const offline = cols === 1 ? [] : cameras.filter(isOffline);
  const live =
    given ??
    pickLive(
      onGrid.map((c) => ({ name: c.name, canPlay: canPlayLive(c, online) })),
      isTouchScreen() ? LIVE_CAP_TOUCH : LIVE_CAP_DESKTOP,
      { active: active.map((a) => a.camera) },
    );
  // Few live tiles: each may use the clean stream; more: the direct stream.
  const clean = usesCleanStream({ kind: "home", liveTiles: liveTotal ?? live.size });
  const detectionOf = (name: string) => active.find((a) => a.camera === name);
  const tile = (c: CameraInfo) => (
    <LiveTile
      key={c.name}
      camera={c}
      online={online?.[c.name]}
      down={downText(c.name)}
      live={live.has(c.name)}
      clean={clean}
      paused={paused}
      detection={detectionOf(c.name)}
      onOpen={() => onOpen(c.name)}
    />
  );
  return (
    <div ref={ref} className="cam-area">
      <div
        className={stacked ? "cam-grid stacked" : "cam-grid"}
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: stacked ? 0 : HOME_GAP }}
      >
        {onGrid.map((c) =>
          !stacked && isTall(c.aspect) ? (
            <div key={c.name} className="tall-cell">
              {tile(c)}
            </div>
          ) : (
            tile(c)
          ),
        )}
      </div>
      {offline.length > 0 && (
        <section className="offline-row" aria-label="Offline cameras">
          {offline.map(tile)}
        </section>
      )}
    </div>
  );
}
