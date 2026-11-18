import { usePet } from "../../hooks/useAppConfig";
import { mediaUrl, reviewLabels, type ReviewItem } from "../../lib/feed";
import { clockTime } from "../../lib/format";
import { cameraTitle } from "../../lib/frigate";
import { subject } from "../../lib/labels";

/**
 * The newest events of all cameras, newest first, in one row that scrolls
 * sideways. A tap plays the event's clip over the wall; an event still in
 * progress has no clip yet, so a tap spotlights its camera instead.
 */
export function EventStrip({
  events,
  offline,
  onPick,
}: {
  events: ReviewItem[];
  /** The titles of the offline cameras on the wall; they get no tile. */
  offline: string[];
  onPick: (r: ReviewItem) => void;
}) {
  const pet = usePet();
  return (
    <section className="event-strip" aria-label="Newest events">
      {offline.length > 0 && <p className="wall-offline">Offline: {offline.join(", ")}</p>}
      <div className="event-row">
        {events.length === 0 && <p className="event-none">No events in the last two days</p>}
        {events.map((r) => {
          const what = subject(reviewLabels(r), pet);
          const where = cameraTitle(r.camera);
          const when = r.end_time === null ? "now" : clockTime(r.start_time);
          return (
            <button key={r.id} className="event-card" onClick={() => onPick(r)} aria-label={`${what}, ${where}, ${when}`}>
              <span className="event-thumb">{r.thumb_path && <img src={mediaUrl(r.thumb_path)} alt="" loading="lazy" />}</span>
              <span className="event-text">
                <b>{what}</b>
                <span className="tnum">
                  {where}, {r.end_time === null ? <em>now</em> : when}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
