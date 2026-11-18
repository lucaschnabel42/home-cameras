import { ArrowDown, ArrowUp, CaretLeft } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useDialog } from "../../hooks/useDialog";
import type { CameraInfo } from "../../lib/frigate";
import { groupSections, type NamesDoc } from "../../lib/names";
import { moveCamera, orderedNames, setHidden, setWallGroup, type WallPrefs } from "../../lib/wallPrefs";

/**
 * Which cameras the wall shows, and in what order. The choice is kept on
 * this device (lib/wallPrefs.ts). When a group holds a camera, chips choose
 * all cameras or one group. Buttons move a camera up or down: they work with
 * a finger, a mouse, a keyboard and VoiceOver, where a drag does not. This
 * sheet does not change the names or the groups (NamesSheet does).
 */
export function WallEditor({
  cameras,
  names,
  prefs,
  onChange,
  onClose,
}: {
  cameras: CameraInfo[];
  names: NamesDoc;
  prefs: WallPrefs;
  onChange: (p: WallPrefs) => void;
  onClose: () => void;
}) {
  const { titleId, back, root } = useDialog(onClose);
  const all = cameras.map((c) => c.name);
  const order = orderedNames(all, prefs);
  const byName = new Map(cameras.map((c) => [c.name, c]));
  const hidden = new Set(prefs.hidden);
  const groups = groupSections(cameras, names).filter((s) => s.id !== null);
  // A stored group that holds no camera now shows all cameras (wallNames).
  const chosen = groups.find((g) => g.id === prefs.group) ?? null;
  const inView = (name: string) => !chosen || chosen.cameras.some((c) => c.name === name);
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
        {groups.length > 0 && (
          <div className="chips wall-groups" role="group" aria-label="Group on the wall">
            <button className="chip" aria-pressed={!chosen} onClick={() => onChange(setWallGroup(prefs, null))}>
              All cameras
            </button>
            {groups.map((g) => (
              <button key={g.id} className="chip" aria-pressed={chosen?.id === g.id} onClick={() => onChange(setWallGroup(prefs, g.id))}>
                {g.name}
              </button>
            ))}
          </div>
        )}
        <ul className="wall-list">
          {order.filter(inView).map((name, i, list) => {
            const c = byName.get(name)!;
            const shown = !hidden.has(name);
            const last = i === list.length - 1;
            return (
              <li key={name} className="wall-row">
                <label className="wall-show">
                  <input type="checkbox" checked={shown} onChange={(e) => onChange(setHidden(prefs, name, !e.target.checked))} />
                  <span>{c.title}</span>
                </label>
                <button
                  className="round"
                  disabled={i === 0}
                  onClick={() => onChange(moveCamera(all, prefs, name, -1, inView))}
                  aria-label={`Move ${c.title} up`}
                >
                  <ArrowUp size={18} aria-hidden="true" />
                </button>
                <button
                  className="round"
                  disabled={last}
                  onClick={() => onChange(moveCamera(all, prefs, name, 1, inView))}
                  aria-label={`Move ${c.title} down`}
                >
                  <ArrowDown size={18} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        <p className="theme-foot">
          {chosen ? `The wall shows the checked cameras of ${chosen.name} in this order.` : "The wall shows the checked cameras in this order."} The choice is kept on this
          device.
        </p>
      </div>
    </motion.div>
  );
}
