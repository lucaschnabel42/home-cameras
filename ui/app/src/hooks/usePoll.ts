import { useCallback, useEffect, useRef, useState } from "react";

/** Retry delay while a poll has never succeeded (Frigate restarting). */
const FIRST_LOAD_RETRY_MS = 3000;

/**
 * Calls fn now and every ms while the page is visible, and again when the
 * page becomes visible. On failure it keeps the last good data and sets error.
 * Until the first success it retries every FIRST_LOAD_RETRY_MS, so a slow poll
 * (the camera list, every 60 s) does not leave the screen empty for a minute.
 */
export function usePoll<T>(fn: () => Promise<T>, ms: number) {
  const [state, setState] = useState<{ data?: T; error?: Error }>({});
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);
  const loaded = useRef(false);
  const retry = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const data = await fnRef.current();
      loaded.current = true;
      if (alive.current) setState({ data });
    } catch (e) {
      if (!alive.current) return;
      setState((s) => ({ data: s.data, error: e as Error }));
      if (!loaded.current) {
        window.clearTimeout(retry.current);
        retry.current = window.setTimeout(() => void refresh(), FIRST_LOAD_RETRY_MS);
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(refresh, ms);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.clearTimeout(retry.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, refresh]);

  return { ...state, refresh };
}
