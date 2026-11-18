import { isTouchScreen, useElementSize } from "../hooks/useElementSize";
import type { ActiveDetection } from "../lib/detections";
import type { CameraInfo } from "../lib/frigate";
import { HOME_GAP, homeColumns, isTall } from "../lib/grid";
import { LIVE_CAP_DESKTOP, LIVE_CAP_TOUCH, pickLive } from "../lib/liveCap";
import { usesCleanStream } from "../lib/streamChoice";
import { LiveTile } from "./LiveTile";

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
}: {
  cameras: CameraInfo[];
  online: Record<string, boolean> | undefined;
  active: ActiveDetection[];
  paused: boolean;
  downText: (camera: string) => string;
  onOpen: (camera: string) => void;
}) {
  const { ref, width } = useElementSize<HTMLDivElement>();
  const isOffline = (c: CameraInfo) => !c.liveOnly && online?.[c.name] === false;
  const shown = cameras.filter((c) => !isOffline(c));
  const cols = homeColumns(shown.length, width || 358);
  // One column keeps the config order with the offline tiles in place: the
  // home screen of one or two cameras does not change.
  const stacked = cols === 1;
  const onGrid = stacked ? cameras : shown;
  const offline = stacked ? [] : cameras.filter(isOffline);
  const live = pickLive(
    onGrid.map((c) => ({ name: c.name, canPlay: !c.liveOnly && !isOffline(c) })),
    isTouchScreen() ? LIVE_CAP_TOUCH : LIVE_CAP_DESKTOP,
    { active: active.map((a) => a.camera) },
  );
  // Few live tiles: each may use the clean stream; more: the direct stream.
  const clean = usesCleanStream({ kind: "home", liveTiles: live.size });
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
