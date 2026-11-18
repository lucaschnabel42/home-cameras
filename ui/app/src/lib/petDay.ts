// What the pet day screen says and computes. The data comes from
// cam-helper (the pet day module and the story module); see helper.ts.
import { span } from "./activity";
import type { Pet } from "./appConfig";
import type { PetDay, PetMoment } from "./helper";

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** "Mostly on the couch, 4 h 53 min", or null without a main place. */
export function mainLine(day: PetDay): string | null {
  if (!day.main) return null;
  const place = day.places.find((p) => p.id === day.main!.place);
  const where = place?.name ? `on the ${place.name}` : "in one spot";
  return `Mostly ${where}, ${span(day.main.minutes * 60)}`;
}

/** "6 spots, 30 moments, 7 barks"; a zero count is left out. */
export function countsLine(day: PetDay): string {
  const parts = [plural(day.places.length, "spot"), plural(day.moments.length, "moment")];
  if (day.barks.length) parts.push(plural(day.barks.length, "bark"));
  return parts.join(", ");
}

/** The moment closest in time to t; on a tie, the earlier one. */
export function nearestMoment(moments: PetMoment[], t: number): PetMoment | null {
  let best: PetMoment | null = null;
  for (const m of moments) if (!best || Math.abs(m.t - t) < Math.abs(best.t - t)) best = m;
  return best;
}

/** [first, last] time of anything on the strip, or null for an empty day. */
export function stripRange(day: PetDay): [number, number] | null {
  const times = [
    ...day.ribbon.flatMap((r) => [r.start, r.end]),
    ...day.moments.map((m) => m.t),
    ...day.barks.flatMap((b) => [b.start, b.end]),
  ];
  return times.length ? [Math.min(...times), Math.max(...times)] : null;
}

/** The first sentence, for the home card. */
export function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : text;
}

/** "Rex's day": the title of the pet day. */
export const petDayTitle = (pet: Pet) => `${pet.name}'s day`;
