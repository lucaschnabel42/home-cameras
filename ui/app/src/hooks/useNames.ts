import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cameraTitle } from "../lib/frigate";
import { getNames, saveNames } from "../lib/helper";
import { EMPTY_NAMES, isNewer, titleOf, type NamesDoc } from "../lib/names";
import { usePoll } from "./usePoll";

/** Another device can change the names: read them again this often. */
const POLL_MS = 60_000;

export type NamesNotice = { kind: "saving" } | { kind: "saved" } | { kind: "conflict" } | { kind: "failed"; error: string };

export interface Names {
  /** The document on this screen. After an edit it holds the edit before cam-helper stores it. */
  doc: NamesDoc;
  /** "offline": cam-helper does not answer. The app then shows the derived names. */
  state: "loading" | "ready" | "offline";
  notice: NamesNotice | null;
  /** Show an edit at once and save it. One save runs at a time. */
  edit: (next: NamesDoc) => void;
  refresh: () => void;
}

/**
 * The names of the cameras and the groups, from cam-helper. Each edit shows
 * at once and is saved; one save runs at a time, and an edit made during a
 * save goes in the next save with the revision of the last answer. On a 409
 * the stored document replaces the edits. On a failure the last stored
 * document comes back. This hook does not check a name (lib/names.ts does).
 */
export function useNames(): Names {
  const poll = usePoll(getNames, POLL_MS);
  const [doc, setDoc] = useState<NamesDoc>(EMPTY_NAMES);
  const [notice, setNotice] = useState<NamesNotice | null>(null);
  const stored = useRef<NamesDoc | null>(null);
  const pending = useRef<NamesDoc | null>(null);
  const running = useRef(false);
  const refresh = useRef(() => {});
  refresh.current = () => void poll.refresh();

  // A poll answer replaces the document only while no edit waits.
  useEffect(() => {
    const d = poll.data;
    if (!d || running.current || pending.current) return;
    // An answer that was asked for before a save can arrive after it, with
    // the older revision: only a newer document replaces the stored one.
    if (!isNewer(stored.current, d)) return;
    stored.current = d;
    setDoc(d);
  }, [poll.data]);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setNotice({ kind: "saving" });
    while (pending.current) {
      const next = { ...pending.current, rev: stored.current?.rev ?? 0 };
      pending.current = null;
      const r = await saveNames(next);
      if (r.kind === "saved") {
        stored.current = r.names;
        if (!pending.current) {
          setDoc(r.names);
          setNotice({ kind: "saved" });
        }
      } else {
        pending.current = null;
        if (r.kind === "conflict") stored.current = r.names;
        setDoc(stored.current ?? EMPTY_NAMES);
        setNotice(r.kind === "conflict" ? { kind: "conflict" } : { kind: "failed", error: r.error });
        // The server can hold the edit when only its answer was lost: read the names again.
        if (r.kind === "failed") refresh.current();
      }
    }
    running.current = false;
  }, []);

  const edit = useCallback(
    (next: NamesDoc) => {
      setDoc(next);
      pending.current = next;
      void run();
    },
    [run],
  );

  const state = poll.error ? "offline" : poll.data ? "ready" : "loading";
  return { doc, state, notice, edit, refresh: () => void poll.refresh() };
}

/** The title of a camera on the screen, for every component. Without a provider: the derived name. */
export const TitleContext = createContext<(key: string) => string>(cameraTitle);

export const useTitleOf = () => useContext(TitleContext);

/** The title function of a names document. */
export const titleFn = (doc: NamesDoc) => (key: string) => titleOf(doc, key);
