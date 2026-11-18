// Keyboard control. Escape closes the top overlay only; the arrow keys change
// the camera.

/**
 * A stack of Escape handlers, one for each open layer (an overlay, a sheet
 * in it). Escape runs the handler on top, so one key press closes one layer.
 */
export function escapeStack() {
  const handlers: (() => void)[] = [];
  return {
    push(h: () => void): () => void {
      handlers.push(h);
      return () => {
        const i = handlers.lastIndexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    /** Runs the top handler. False when no layer is open. */
    escape(): boolean {
      const top = handlers[handlers.length - 1];
      top?.();
      return !!top;
    },
    get size() {
      return handlers.length;
    },
  };
}

/**
 * The index after an arrow key in a list of `n` cameras laid out `cols` wide.
 * Left and right step by one and wrap around; up and down step by one row and
 * stop at the edge. Any other key gives null.
 */
export function arrowStep(key: string, index: number, n: number, cols = n): number | null {
  if (n <= 0) return null;
  switch (key) {
    case "ArrowLeft":
      return (index - 1 + n) % n;
    case "ArrowRight":
      return (index + 1) % n;
    case "ArrowUp":
      return index - cols >= 0 ? index - cols : index;
    case "ArrowDown":
      return index + cols < n ? index + cols : index;
    default:
      return null;
  }
}

/**
 * True when a key press belongs to the focused control and not to the page:
 * text fields, and the controls that read arrow keys themselves (the rewind
 * dial is a radio group; the timeline and the pet day strip are sliders).
 */
export function keyBelongsToControl(target: EventTarget | null): boolean {
  const el = target as { closest?: (s: string) => unknown; isContentEditable?: boolean } | null;
  if (!el?.closest) return false;
  return !!el.isContentEditable || !!el.closest('input, textarea, select, [role="slider"], [role="radiogroup"], [role="radio"]');
}
