import { CaretRight } from "@phosphor-icons/react";
import { isTouchScreen } from "../hooks/useElementSize";
import type { ActiveDetection } from "../lib/detections";
import { LIVE_CAP_DESKTOP, LIVE_CAP_TOUCH, pickLiveAcross } from "../lib/liveCap";
import type { Section } from "../lib/names";
import { CameraGrid, canPlayLive } from "./CameraGrid";

/**
 * Home in the view "By group": one section for each group, with a heading
 * (the name and the camera count), then "Other cameras". Sections sit next
 * to each other when the width allows it, and stack on a phone. A section
 * with more cameras gets more width (styles.css, --n). A tap on a group
 * heading shows that group alone.
 *
 * One live cap covers all sections together (lib/liveCap.ts
 * pickLiveAcross). This component does not order the cameras in a group:
 * the order is the Frigate config order.
 */
export function GroupBoard({
  sections,
  online,
  active,
  paused,
  downText,
  onOpen,
  onGroup,
}: {
  sections: Section[];
  online: Record<string, boolean> | undefined;
  active: ActiveDetection[];
  paused: boolean;
  downText: (camera: string) => string;
  onOpen: (camera: string) => void;
  onGroup: (id: string) => void;
}) {
  const live = pickLiveAcross(
    sections.map((s) => s.cameras.map((c) => ({ name: c.name, canPlay: canPlayLive(c, online) }))),
    isTouchScreen() ? LIVE_CAP_TOUCH : LIVE_CAP_DESKTOP,
    { active: active.map((a) => a.camera) },
  );
  return (
    <div className="group-board">
      {sections.map((s) => {
        const count = `${s.cameras.length} ${s.cameras.length === 1 ? "camera" : "cameras"}`;
        const id = s.id;
        return (
          <section key={id ?? "other"} className="group-section" style={{ ["--n" as string]: s.cameras.length }} aria-label={s.name}>
            <h2 className="group-head">
              {id ? (
                <button onClick={() => onGroup(id)} aria-label={`${s.name}, ${count}. Show this group alone`}>
                  <span className="group-name">{s.name}</span>
                  <span className="group-count">{count}</span>
                  <CaretRight size={16} aria-hidden="true" />
                </button>
              ) : (
                <span className="group-static">
                  <span className="group-name">{s.name}</span>
                  <span className="group-count">{count}</span>
                </span>
              )}
            </h2>
            <CameraGrid
              cameras={s.cameras}
              online={online}
              active={active}
              paused={paused}
              downText={downText}
              onOpen={onOpen}
              live={live}
              liveTotal={live.size}
              section
            />
          </section>
        );
      })}
    </div>
  );
}
