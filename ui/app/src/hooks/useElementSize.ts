import { useLayoutEffect, useRef, useState } from "react";
import { contentSize } from "../lib/grid";

/**
 * The content size of an element (the space inside its padding), kept
 * current with a ResizeObserver. The observer watches the content box, so a
 * change of the padding alone also gives a new size.
 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const px = (v: string) => parseFloat(v) || 0;
      const { width, height } = contentSize(el.clientWidth, el.clientHeight, {
        top: px(cs.paddingTop),
        right: px(cs.paddingRight),
        bottom: px(cs.paddingBottom),
        left: px(cs.paddingLeft),
      });
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
