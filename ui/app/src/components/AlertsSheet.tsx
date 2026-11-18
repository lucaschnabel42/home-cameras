import { Bell, BellSlash, CaretLeft, Check, WarningCircle } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { usePet } from "../hooks/useAppConfig";
import { useDialog } from "../hooks/useDialog";
import { pushState, sendTest, turnOff, turnOn, type PushState } from "../lib/push";

type Note = { kind: "ok" | "error"; text: string } | null;

/**
 * Alerts on this device. What sends one is fixed in cam-helper: a dog barking
 * for 2 minutes when nobody was seen inside for 20 minutes, and a smoke alarm
 * or breaking glass at any time.
 */
export function AlertsSheet({ onClose }: { onClose: () => void }) {
  const pet = usePet();
  // The bark rule hears any dog; it names the pet when the pet is a dog.
  const barker = pet?.label === "dog" ? pet.name : "A dog";
  const { titleId, back: backButton, root: dialogRoot } = useDialog(onClose);
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    void pushState()
      .then(setState)
      .catch(() => setState("unsupported"));
  }, []);

  const run = async (work: () => Promise<PushState | void>, ok?: string) => {
    setBusy(true);
    setNote(null);
    try {
      const s = await work();
      if (s) setState(s);
      if (ok) setNote({ kind: "ok", text: ok });
    } catch {
      setNote({ kind: "error", text: "That did not work. Check the connection and try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div className="overlay panel alerts" {...dialogRoot} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="topbar">
        <button className="round glass" onClick={onClose} ref={backButton} aria-label="Back">
          <CaretLeft size={20} aria-hidden="true" />
        </button>
        <span className="pill-title glass" id={titleId}>Alerts</span>
      </div>
      <div className="alerts-body">
        <div className="sheet glass note static">
          <b>What sends an alert</b>
          <span>{barker} barks for 2 minutes and nobody was seen inside in the last 20 minutes.</span>
          <span>A smoke alarm or breaking glass, at any time.</span>
        </div>

        {state === "needs-home-screen" && (
          <div className="sheet glass note static">
            <b>Add the app to your Home Screen first</b>
            <span>In Safari, tap Share, then Add to Home Screen. Open Cameras from the Home Screen and come back here.</span>
          </div>
        )}
        {state === "unreachable" && (
          <div className="sheet glass note static">
            <b>The alert service is not answering</b>
            <span>This device is set up, but the recorder could not be told. Alerts may not arrive until it answers. Open this page again later.</span>
          </div>
        )}
        {state === "unreachable" && (
          <button className="save quiet" disabled={busy} onClick={() => run(turnOff)}>
            <BellSlash size={18} aria-hidden="true" />
            Turn off alerts on this device
          </button>
        )}
        {state === "unsupported" && (
          <div className="sheet glass note static">
            <b>This browser cannot get alerts</b>
            <span>Use the Cameras app on the Home Screen of an iPhone with iOS 16.4 or later.</span>
          </div>
        )}
        {state === "blocked" && (
          <div className="sheet glass note static">
            <b>Alerts are turned off for this app</b>
            <span>Open Settings, then Notifications, then Cameras, and allow notifications.</span>
          </div>
        )}
        {state === "off" && (
          <button className="save" disabled={busy} onClick={() => run(turnOn)}>
            <Bell size={18} aria-hidden="true" />
            {busy ? "Turning on" : "Turn on alerts on this device"}
          </button>
        )}
        {state === "on" && (
          <>
            <p className="alerts-on">
              <Check size={18} aria-hidden="true" /> Alerts are on for this device
            </p>
            <button className="save" disabled={busy} onClick={() => run(sendTest, "Test alert sent. It arrives in a few seconds.")}>
              <Bell size={18} aria-hidden="true" />
              Send a test alert
            </button>
            <button className="save quiet" disabled={busy} onClick={() => run(turnOff)}>
              <BellSlash size={18} aria-hidden="true" />
              Turn off alerts on this device
            </button>
          </>
        )}
        {note && (
          <p className={note.kind === "error" ? "save-status error" : "save-status"} role="status">
            {note.kind === "error" && <WarningCircle size={16} aria-hidden="true" />} {note.text}
          </p>
        )}
      </div>
    </motion.div>
  );
}
