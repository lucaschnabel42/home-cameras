import { ArrowDown, ArrowUp, CaretLeft } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useDialog } from "../../hooks/useDialog";
import type { CameraInfo } from "../../lib/frigate";
import { moveCamera, orderedNames, setHidden, type WallPrefs } from "../../lib/wallPrefs";

/**
 * Which cameras the wall shows, and in what order. The choice is kept on
 * this device (lib/wallPrefs.ts). Buttons move a camera up or down: they work
 * with a finger, a mouse, a keyboard and VoiceOver, where a drag does not.
 */
export function WallEditor({
  cameras,
  prefs,
  onChange,
  onClose,
}: {
  cameras: CameraInfo[];
  prefs: WallPrefs;
  onChange: (p: WallPrefs) => void;
  onClose: () => void;
}) {
  const { titleId, back, root } = useDialog(onClose);
  const all = cameras.map((c) => c.name);
  const order = orderedNames(all, prefs);
  const byName = new Map(cameras.map((c) => [c.name, c]));
  const hidden = new Set(prefs.hidden);
  return (
    <motion.div className="overlay panel wall-editor" {...root} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="topbar">
        <button className="round glass" onClick={onClose} ref={back} aria-label="Back">
          <CaretLeft size={20} aria-hidden="true" />
        </button>
        <span className="pill-title glass" id={titleId}>
          Cameras on the wall
        </span>
      </div>
      <div className="alerts-body">
        <ul className="wall-list">
          {order.map((name, i) => {
            const c = byName.get(name)!;
            const shown = !hidden.has(name);
            return (
              <li key={name} className="wall-row">
                <label className="wall-show">
                  <input type="checkbox" checked={shown} onChange={(e) => onChange(setHidden(prefs, name, !e.target.checked))} />
                  <span>{c.title}</span>
                </label>
                <button
                  className="round"
                  disabled={i === 0}
                  onClick={() => onChange(moveCamera(all, prefs, name, -1))}
                  aria-label={`Move ${c.title} up`}
                >
                  <ArrowUp size={18} aria-hidden="true" />
                </button>
                <button
                  className="round"
                  disabled={i === order.length - 1}
                  onClick={() => onChange(moveCamera(all, prefs, name, 1))}
                  aria-label={`Move ${c.title} down`}
                >
                  <ArrowDown size={18} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        <p className="theme-foot">The wall shows the checked cameras in this order. The choice is kept on this device.</p>
      </div>
    </motion.div>
  );
}
