export const SAVE_STEPS = [5, 10, 15, 20, 25, 30] as const;
export type SaveMinutes = (typeof SAVE_STEPS)[number];

/** Seconds kept off the end so Frigate has closed the newest 10 s segment. */
export const SEGMENT_CLOSE_S = 15;

export function saveWindow(minutes: number, nowS: number): { start: number; end: number } {
  if (!(SAVE_STEPS as readonly number[]).includes(minutes)) {
    throw new Error(`save length must be one of ${SAVE_STEPS.join(", ")} minutes`);
  }
  const now = Math.floor(nowS);
  return { start: now - minutes * 60, end: now - SEGMENT_CLOSE_S };
}
