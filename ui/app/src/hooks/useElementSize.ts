import { useLayoutEffect, useRef, useState } from "react";

/** The content size of an element, kept current with a ResizeObserver. */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = Math.round(el.clientWidth);
      const height = Math.round(el.clientHeight);
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

/** True on a touch screen, where the live cap is lower (lib/liveCap.ts). */
export const isTouchScreen = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
