import { useCallback, useRef, useState, type PointerEvent } from "react";
import { IDENTITY, pan, pinch, type Point, type View } from "../lib/zoom";

/** Below this after a pinch, the view snaps back to 1x. */
const SNAP_S = 1.05;
/** A finger that moves less than this is a tap, not a pan. */
const TAP_SLOP_PX = 8;

export interface Gesture {
  /** Two or more fingers touched during the gesture (a pinch). */
  multi: boolean;
  /** The picture was zoomed when the gesture began or when it ended. */
  zoomed: boolean;
  /** A finger moved further than a tap. */
  moved: boolean;
}

/**
 * Pinch to zoom a video inside its frame, and pan it with one finger while it
 * is zoomed. `frame` goes on the element that clips and gets the pointer
 * handlers; `content` on the element that moves. The transform is written to
 * the element directly, so a pan does not re-render React; only `zoomed`
 * changes state. The caller reads `lastGesture()` in its own pointer-up
 * handler, after `handlers.onPointerUp`, to keep swipes and taps for 1x.
 */
export function useZoomPan(max = 4) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLElement>(null);
  const view = useRef<View>(IDENTITY);
  const pts = useRef(new Map<number, Point>());
  const g = useRef<{ start: View; mid: Point; dist: number; from: Point; multi: boolean; moved: boolean; zoomed: boolean } | null>(null);
  const last = useRef<Gesture>({ multi: false, zoomed: false, moved: false });
  const [zoomed, setZoomed] = useState(false);

  const apply = useCallback((v: View) => {
    view.current = v;
    const el = content.current;
    if (el) el.style.transform = v.s === 1 ? "" : `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
    setZoomed(v.s > 1);
  }, []);

  // The content's layout box (offset*, which ignores the transform) inside the
  // frame: a letterboxed video sits centred in a larger frame. The frame must
  // be the content's offsetParent (positioned).
  const box = () => {
    const c = content.current;
    const r = frame.current?.getBoundingClientRect();
    return { w: c?.offsetWidth || r?.width || 1, h: c?.offsetHeight || r?.height || 1 };
  };
  const local = (e: PointerEvent): Point => {
    const r = frame.current!.getBoundingClientRect();
    const c = content.current;
    return { x: e.clientX - r.left - (c?.offsetLeft ?? 0), y: e.clientY - r.top - (c?.offsetTop ?? 0) };
  };
  /** Start the maths again from the current view and fingers (a finger came or went). */
  const rebase = () => {
    if (!g.current) return;
    const [a, b] = [...pts.current.values()];
    g.current.start = view.current;
    g.current.from = a;
    if (b) {
      g.current.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      g.current.dist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!frame.current) return;
    frame.current.setPointerCapture?.(e.pointerId);
    pts.current.set(e.pointerId, local(e));
    if (!g.current) {
      const p = local(e);
      g.current = { start: view.current, mid: p, dist: 1, from: p, multi: false, moved: false, zoomed: view.current.s > 1 };
    }
    if (pts.current.size >= 2) g.current.multi = true;
    rebase();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pts.current.has(e.pointerId) || !g.current) return;
    const p = local(e);
    pts.current.set(e.pointerId, p);
    const st = g.current;
    if (pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      apply(pinch(st.start, st.mid, st.dist, mid, Math.hypot(a.x - b.x, a.y - b.y), box(), max));
      st.moved = true;
    } else {
      const dx = p.x - st.from.x;
      const dy = p.y - st.from.y;
      if (Math.hypot(dx, dy) > TAP_SLOP_PX) st.moved = true;
      if (st.start.s > 1) apply(pan(st.start, dx, dy, box(), max));
    }
  };

  const end = (e: PointerEvent) => {
    if (!pts.current.delete(e.pointerId) || !g.current) return;
    if (pts.current.size > 0) return rebase();
    if (view.current.s < SNAP_S) apply(IDENTITY);
    last.current = { multi: g.current.multi, moved: g.current.moved, zoomed: g.current.zoomed || view.current.s > 1 };
    g.current = null;
  };

  const reset = useCallback(() => {
    pts.current.clear();
    g.current = null;
    apply(IDENTITY);
  }, [apply]);

  return {
    frame,
    content,
    zoomed,
    reset,
    lastGesture: () => last.current,
    /** Fingers are still down: the gesture has not ended. */
    busy: () => pts.current.size > 0,
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
  };
}
