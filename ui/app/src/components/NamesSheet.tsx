import { ArrowDown, ArrowUp, CaretLeft, Plus, Trash, WarningCircle } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { useDialog } from "../hooks/useDialog";
import type { Names } from "../hooks/useNames";
import { cameraTitle, latestUrl, type CameraInfo } from "../lib/frigate";
import { MAX_GROUPS, addGroup, cleanName, moveGroup, nameProblem, removeGroup, renameCamera, renameGroup, setGroup } from "../lib/names";

/**
 * The names of the cameras and the groups of cameras. cam-helper keeps them,
 * so every device shows the same names. Each change saves at once: a text
 * field on blur and on Enter, a select and a button on the tap. There is no
 * Save button. A name that breaks the rule shows the reason and is not
 * saved. When cam-helper does not answer, the fields are disabled.
 *
 * This sheet does not change a Frigate key, a recording, or a setting of
 * the wall or of Home.
 */
export function NamesSheet({ cameras, names, onClose }: { cameras: CameraInfo[]; names: Names; onClose: () => void }) {
  const { titleId, back, root } = useDialog(onClose);
  const { doc, edit } = names;
  const off = names.state !== "ready";
  // A new group's name field takes the focus, so the user can type its name.
  const [focusGroup, setFocusGroup] = useState<string | null>(null);
  const refresh = names.refresh;
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div className="overlay panel names" {...root} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="topbar">
        <button className="round glass" onClick={onClose} ref={back} aria-label="Back">
          <CaretLeft size={20} aria-hidden="true" />
        </button>
        <span className="pill-title glass" id={titleId}>
          Names and groups
        </span>
      </div>
      <div className="alerts-body">
        <Status names={names} />

        <h2 className="names-head">Cameras</h2>
        <ul className="names-list">
          {cameras.map((c) => {
            const derived = cameraTitle(c.name);
            const entry = doc.cameras[c.name];
            return (
              <li key={c.name} className="names-row">
                {c.liveOnly ? <span className="names-still" aria-hidden="true" /> : <img className="names-still" src={latestUrl(c.name, 120)} alt="" loading="lazy" />}
                <div className={doc.groups.length > 0 ? "names-fields two" : "names-fields"}>
                  <NameField
                    label={derived}
                    value={entry?.name ?? ""}
                    placeholder={derived}
                    disabled={off}
                    check={(v) => nameProblem(v, { empty: true })}
                    onCommit={(v) => edit(renameCamera(doc, c.name, v))}
                  />
                  {doc.groups.length > 0 && (
                    <select
                      className="names-input names-select"
                      aria-label={`Group of ${c.title}`}
                      value={entry?.group ?? ""}
                      disabled={off}
                      onChange={(e) => edit(setGroup(doc, c.name, e.target.value || null))}
                    >
                      <option value="">No group</option>
                      {doc.groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="theme-foot">An empty name shows the name from the camera settings.</p>

        <h2 className="names-head">Groups</h2>
        {doc.groups.length === 0 && <p className="theme-foot names-empty">No groups yet. Add a group, then choose it for each of its cameras.</p>}
        <ul className="names-list">
          {doc.groups.map((g, i) => (
            <li key={g.id} className="names-row group">
              <NameField
                label={`Name of the group ${g.name}`}
                hideLabel
                value={g.name}
                disabled={off}
                autoFocus={focusGroup === g.id}
                check={(v) => nameProblem(v, { taken: doc.groups.filter((x) => x.id !== g.id).map((x) => x.name) })}
                onCommit={(v) => edit(renameGroup(doc, g.id, v))}
              />
              <button className="round" disabled={off || i === 0} onClick={() => edit(moveGroup(doc, g.id, -1))} aria-label={`Move ${g.name} up`}>
                <ArrowUp size={18} aria-hidden="true" />
              </button>
              <button
                className="round"
                disabled={off || i === doc.groups.length - 1}
                onClick={() => edit(moveGroup(doc, g.id, 1))}
                aria-label={`Move ${g.name} down`}
              >
                <ArrowDown size={18} aria-hidden="true" />
              </button>
              <button className="round" disabled={off} onClick={() => edit(removeGroup(doc, g.id))} aria-label={`Remove ${g.name}`}>
                <Trash size={18} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <button
          className="save quiet"
          disabled={off || doc.groups.length >= MAX_GROUPS}
          onClick={() => {
            const r = addGroup(doc);
            setFocusGroup(r.id);
            edit(r.doc);
          }}
        >
          <Plus size={18} aria-hidden="true" />
          Add group
        </button>
        <p className="theme-foot">Remove a group and its cameras stay, with no group. Home shows the groups on each device that chooses to.</p>
      </div>
    </motion.div>
  );
}

/** One line under the title: what the last save did, or why the fields are off. */
function Status({ names }: { names: Names }) {
  const n = names.notice;
  let text = "Names and groups show on every device.";
  let warn = false;
  if (names.state === "offline") {
    text = "The names service does not answer. The cameras keep the names from their settings.";
    warn = true;
  } else if (names.state === "loading") text = "Loading the names.";
  else if (n?.kind === "saving") text = "Saving.";
  else if (n?.kind === "saved") text = "Saved.";
  else if (n?.kind === "conflict") {
    text = "Another device changed the names. This list now shows them.";
    warn = true;
  } else if (n?.kind === "failed") {
    text = `The change was not saved. ${n.error}`;
    warn = true;
  }
  return (
    <p className={warn ? "names-status warn" : "names-status"} role="status">
      {warn && <WarningCircle size={18} aria-hidden="true" />}
      <span>{text}</span>
    </p>
  );
}

/**
 * A text field that saves on blur and on Enter, not on each key. A name
 * that breaks the rule shows the reason under the field and is not saved.
 * Escape puts back the stored value.
 */
function NameField({
  label,
  hideLabel,
  value,
  placeholder,
  disabled,
  autoFocus,
  check,
  onCommit,
}: {
  label: string;
  hideLabel?: boolean;
  value: string;
  placeholder?: string;
  disabled: boolean;
  autoFocus?: boolean;
  check: (v: string) => string | null;
  onCommit: (v: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const [problem, setProblem] = useState<string | null>(null);
  // A new stored value (a save, a 409, another device) replaces the draft.
  useEffect(() => {
    setDraft(value);
    setProblem(null);
  }, [value]);
  useEffect(() => {
    if (autoFocus) {
      input.current?.focus();
      input.current?.select();
    }
  }, [autoFocus]);

  const commit = () => {
    const p = check(draft);
    setProblem(p);
    if (p) return;
    const clean = cleanName(draft);
    setDraft(clean);
    if (clean !== value) onCommit(clean);
  };

  return (
    <div className="names-field">
      <label htmlFor={id} className={hideLabel ? "names-label hidden" : "names-label"}>
        {label}
      </label>
      <input
        ref={input}
        id={id}
        className="names-input"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={64}
        autoComplete="off"
        enterKeyHint="done"
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-p` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          if (problem) setProblem(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape" && draft !== value) {
            // Escape first puts back the stored value; a second Escape closes the sheet.
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setDraft(value);
            setProblem(null);
          }
        }}
      />
      {problem && (
        <p className="names-problem" id={`${id}-p`} role="alert">
          <WarningCircle size={16} aria-hidden="true" />
          {problem}
        </p>
      )}
    </div>
  );
}
