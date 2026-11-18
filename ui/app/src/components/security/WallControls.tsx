import { ArrowsIn, ArrowsOut, Crosshair, DownloadSimple, GridFour, Rows, SlidersHorizontal, SpeakerHigh, SpeakerSlash, X } from "@phosphor-icons/react";
import { forwardRef } from "react";
import type { WallView } from "../../lib/wallPrefs";

/**
 * The control bar of the security wall. It floats over the wall and hides
 * after a few seconds with no input (SecurityMode). Each control is a 44 px
 * target with a name for VoiceOver and a tooltip for a mouse.
 */
export const WallControls = forwardRef<
  HTMLButtonElement,
  {
    view: WallView;
    follow: boolean;
    sound: boolean;
    full: boolean;
    /** Sound and Save still act on the spotlight camera, so they need one. */
    hasSpotlight: boolean;
    canFull: boolean;
    onExit: () => void;
    onView: (v: WallView) => void;
    onFollow: () => void;
    onSound: () => void;
    onStill: () => void;
    onEdit: () => void;
    onFull: () => void;
  }
>(function WallControls(p, exitRef) {
  return (
    <div className="wall-controls">
      <button ref={exitRef} className="round glass" onClick={p.onExit} aria-label="Leave security mode" title="Leave security mode">
        <X size={20} aria-hidden="true" />
      </button>
      <div className="wall-switch glass" role="group" aria-label="Layout">
        <button aria-pressed={p.view === "grid"} onClick={() => p.onView("grid")} title="All cameras the same size">
          <GridFour size={18} aria-hidden="true" />
          <span>Grid</span>
        </button>
        <button aria-pressed={p.view === "spotlight"} onClick={() => p.onView("spotlight")} title="One camera large">
          <Rows size={18} aria-hidden="true" />
          <span>Spotlight</span>
        </button>
      </div>
      <span className="grow" />
      <button className="wall-pill glass" aria-pressed={p.follow} onClick={p.onFollow} title="Move the spotlight to the newest activity">
        <Crosshair size={18} aria-hidden="true" />
        <span>Follow activity</span>
      </button>
      {p.hasSpotlight && (
        <>
          <button
            className="round glass"
            aria-pressed={p.sound}
            onClick={p.onSound}
            aria-label={p.sound ? "Sound on, turn off" : "Sound off, turn on"}
            title={p.sound ? "Turn sound off" : "Sound of the large camera"}
          >
            {p.sound ? <SpeakerHigh size={20} aria-hidden="true" /> : <SpeakerSlash size={20} aria-hidden="true" />}
          </button>
          <button className="round glass" onClick={p.onStill} aria-label="Save a still" title="Save a still of the large camera">
            <DownloadSimple size={20} aria-hidden="true" />
          </button>
        </>
      )}
      <button className="round glass" onClick={p.onEdit} aria-label="Choose cameras" title="Choose and order the cameras">
        <SlidersHorizontal size={20} aria-hidden="true" />
      </button>
      {p.canFull && (
        <button className="round glass" onClick={p.onFull} aria-label={p.full ? "Leave full screen" : "Full screen"} title={p.full ? "Leave full screen" : "Full screen"}>
          {p.full ? <ArrowsIn size={20} aria-hidden="true" /> : <ArrowsOut size={20} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
});
