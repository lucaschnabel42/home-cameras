// The order of the cameras on the security wall, which cameras it hides, its
// layout, and the group it shows. Each device keeps its own choice in
// localStorage. This module does not know the groups: the caller gives the
// group of each camera (lib/names.ts).

/** "grid": all cameras the same size. "spotlight": one large, the others in a strip. */
export type WallView = "grid" | "spotlight";

export interface WallPrefs {
  /** Camera names in the order the person chose. A camera not in it goes last. */
  order: string[];
  hidden: string[];
  view: WallView;
  /** The id of the group the wall shows. Absent: all cameras. */
  group?: string;
}

const KEY = "cam.wall";
export const EMPTY_PREFS: WallPrefs = { order: [], hidden: [], view: "grid" };

const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The stored choice, or EMPTY_PREFS. A private window can refuse storage. */
export function readWallPrefs(storage: Pick<Storage, "getItem"> | null = safeStorage()): WallPrefs {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return EMPTY_PREFS;
    return {
      order: names(raw.order),
      hidden: names(raw.hidden),
      view: raw.view === "spotlight" ? "spotlight" : "grid",
      ...(typeof raw.group === "string" ? { group: raw.group } : {}),
    };
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

/**
 * The cameras the wall shows, in order. With a group choice, only the
 * cameras of that group; a group that holds no camera gives all cameras.
 */
export function wallNames(all: string[], p: WallPrefs, groupOf: (name: string) => string | undefined = () => undefined): string[] {
  const hidden = new Set(p.hidden);
  const inGroup = p.group && all.some((n) => groupOf(n) === p.group) ? (n: string) => groupOf(n) === p.group : () => true;
  return orderedNames(all, p).filter((n) => !hidden.has(n) && inGroup(n));
}

/** Show one group on the wall, or all cameras (null). */
export function setWallGroup(p: WallPrefs, id: string | null): WallPrefs {
  const { group: _old, ...rest } = p;
  return id ? { ...rest, group: id } : rest;
}

/**
 * Move one camera up (-1) or down (+1) in the order. It changes place with
 * the next camera in `inView`: with a group choice, the next camera of the
 * group, so each tap moves the camera on the wall.
 */
export function moveCamera(all: string[], p: WallPrefs, name: string, delta: -1 | 1, inView: (name: string) => boolean = () => true): WallPrefs {
  const order = orderedNames(all, p);
  const i = order.indexOf(name);
  let j = i + delta;
  while (j >= 0 && j < order.length && !inView(order[j])) j += delta;
  if (i < 0 || j < 0 || j >= order.length) return p;
  [order[i], order[j]] = [order[j], order[i]];
  return { ...p, order };
}

/** Show or hide one camera. */
export function setHidden(p: WallPrefs, name: string, hide: boolean): WallPrefs {
  const hidden = p.hidden.filter((n) => n !== name);
  return { ...p, hidden: hide ? [...hidden, name] : hidden };
}
