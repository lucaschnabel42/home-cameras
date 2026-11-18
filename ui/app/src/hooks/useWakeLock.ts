import { useEffect } from "react";

type Sentinel = { release(): Promise<void>; released?: boolean };
type WakeLockApi = { request(type: "screen"): Promise<Sentinel> };

/**
 * Keeps the screen on while `on` is true (the Screen Wake Lock API). The
 * browser drops the lock when the page is hidden, so the hook takes it again
 * when the page becomes visible. It releases the lock when `on` goes false or
 * the component goes away. A browser without the API, or one that refuses,
 * changes nothing: the screen then turns off on its own timer.
 */
export function useWakeLock(on: boolean) {
  useEffect(() => {
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (!on || !api) return;
    let lock: Sentinel | null = null;
    let alive = true;
    const take = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        const l = await api.request("screen");
        if (alive) lock = l;
        else void l.release();
      } catch {
        // Refused (low battery, or a frame without permission).
      }
    };
    const onVisible = () => void take();
    void take();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, [on]);
}
