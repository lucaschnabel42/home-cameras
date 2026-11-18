// "New since you last looked", per device. Frigate's own "reviewed" state is
// per Frigate user, and both phones reach Frigate as the same user, so it
// would be shared; this stays on each phone.
const KEY = "cameras.lastSeen";

/** The time this device last left the app, or null on its first visit. */
export function lastSeen(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null; // private mode or blocked storage: nothing is marked new
  }
}

export function markSeen(unixS: number): void {
  try {
    localStorage.setItem(KEY, String(Math.floor(unixS)));
  } catch {
    // nothing to do: the marks are a convenience
  }
}
