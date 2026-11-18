// The order of the cameras on the security wall, which cameras it hides, and
// its layout. Each device keeps its own choice in localStorage.

/** "grid": all cameras the same size. "spotlight": one large, the others in a strip. */
export type WallView = "grid" | "spotlight";

export interface WallPrefs {
  /** Camera names in the order the person chose. A camera not in it goes last. */
  order: string[];
  hidden: string[];
  view: WallView;
}

const KEY = "cam.wall";
export const EMPTY_PREFS: WallPrefs = { order: [], hidden: [], view: "grid" };

const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The stored choice, or EMPTY_PREFS. A private window can refuse storage. */
export function readWallPrefs(storage: Pick<Storage, "getItem"> | null = safeStorage()): WallPrefs {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return EMPTY_PREFS;
    return { order: names(raw.order), hidden: names(raw.hidden), view: raw.view === "spotlight" ? "spotlight" : "grid" };
  } catch {
    return EMPTY_PREFS;
  }
}

export function writeWallPrefs(p: WallPrefs, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(p));
  } catch {
    // Full or refused storage: the choice lasts until the page closes.
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** All cameras in the chosen order: the ordered ones first, then new cameras in config order. */
export function orderedNames(all: string[], p: WallPrefs): string[] {
  const known = new Set(all);
  const first = p.order.filter((n) => known.has(n));
  const placed = new Set(first);
  return [...first, ...all.filter((n) => !placed.has(n))];
}

/** The cameras the wall shows, in order. */
export function wallNames(all: string[], p: WallPrefs): string[] {
  const hidden = new Set(p.hidden);
  return orderedNames(all, p).filter((n) => !hidden.has(n));
}

/** Move one camera up (-1) or down (+1) in the order. */
export function moveCamera(all: string[], p: WallPrefs, name: string, delta: -1 | 1): WallPrefs {
  const order = orderedNames(all, p);
  const i = order.indexOf(name);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return p;
  [order[i], order[j]] = [order[j], order[i]];
  return { ...p, order };
}

/** Show or hide one camera. */
export function setHidden(p: WallPrefs, name: string, hide: boolean): WallPrefs {
  const hidden = p.hidden.filter((n) => n !== name);
  return { ...p, hidden: hide ? [...hidden, name] : hidden };
}
