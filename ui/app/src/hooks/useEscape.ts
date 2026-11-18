import { useEffect, useRef } from "react";
import { escapeStack } from "../lib/keys";

/** One stack for the whole page: each open layer pushes its own handler. */
const stack = escapeStack();

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (stack.escape()) e.preventDefault();
  });
}

/** While `on` is true, Escape runs `close`, if this layer is the top one. */
export function useEscape(close: () => void, on = true) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!on) return;
    return stack.push(() => ref.current());
  }, [on]);
}
