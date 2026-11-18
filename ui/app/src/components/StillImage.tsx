import { useEffect, useState } from "react";
import { latestUrl } from "../lib/frigate";

/** A tile that does not play live refreshes its still this often. */
export const STILL_REFRESH_MS = 5000;

/**
 * The latest still of a camera from Frigate, refreshed every `refreshMs`
 * while the page is visible. The next still loads off screen and replaces
 * the shown one only when it has loaded, so the tile never flashes empty.
 * A still that fails to load keeps the last good one.
 */
export function StillImage({
  camera,
  height = 360,
  refreshMs = STILL_REFRESH_MS,
  className = "tile-still",
}: {
  camera: string;
  height?: number;
  /** null shows one still and never refreshes it. */
  refreshMs?: number | null;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = () => {
      window.clearTimeout(timer);
      const next = `${latestUrl(camera, height)}&t=${Date.now()}`;
      const img = new Image();
      const again = () => {
        if (alive && refreshMs !== null) timer = window.setTimeout(load, refreshMs);
      };
      img.onload = () => {
        if (alive) setSrc(next);
        again();
      };
      img.onerror = again;
      img.src = next;
    };
    // A hidden page asks for nothing; it loads a fresh still when it comes back.
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
      else window.clearTimeout(timer);
    };
    load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [camera, height, refreshMs]);
  return src ? <img className={className} src={src} alt="" decoding="async" /> : null;
}
