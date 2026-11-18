// What Home shows on this device: all cameras, the cameras by group, or one
// group. Each device keeps its own choice in localStorage, like the theme
// and the security wall. This module does not keep the groups themselves
// (lib/names.ts and cam-helper do), and it does not filter the activity list.
import type { CameraInfo } from "./frigate";
import { groupSections, type NamesDoc } from "./names";

export type HomeView = { kind: "all" } | { kind: "groups" } | { kind: "group"; id: string };

export const ALL: HomeView = { kind: "all" };
const KEY = "cam.home";

/** The stored choice, or ALL. A private window can refuse storage. */
export function readHomeView(storage: Pick<Storage, "getItem"> | null = safeStorage()): HomeView {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? "null");
    if (raw?.kind === "groups") return { kind: "groups" };
    if (raw?.kind === "group" && typeof raw.id === "string") return { kind: "group", id: raw.id };
    return ALL;
  } catch {
    return ALL;
  }
}

export function writeHomeView(v: HomeView, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(v));
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

/**
 * The view Home can show now. A group that no longer exists, or that holds
 * no camera, gives ALL. With no group that holds a camera, every view is ALL:
 * Home then looks as it did before groups.
 */
export function resolveHomeView(v: HomeView, cams: CameraInfo[], doc: NamesDoc): HomeView {
  const groups = groupSections(cams, doc).filter((s) => s.id !== null);
  if (groups.length === 0) return ALL;
  if (v.kind === "group" && !groups.some((s) => s.id === v.id)) return ALL;
  return v;
}
