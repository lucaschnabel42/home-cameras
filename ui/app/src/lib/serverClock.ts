// The server's clock, as seen from the phone. Every Frigate response carries
// a Date header; the app takes the offset between that and the phone clock,
// and uses server time for each "now" that it sends to Frigate or compares
// with Frigate's times (the recording gaps, "Save last N min"). A phone clock
// that is wrong by minutes otherwise shows a false "not recording" row and
// saves the wrong window.
//
// What this does not do: the Date header has whole seconds, and the network
// delay is not measured, so the offset is good to about 1 s. Offsets below
// MIN_OFFSET_MS are ignored, so a phone with a correct clock uses its own.

/** A smaller difference is network delay and rounding, not a wrong clock. */
const MIN_OFFSET_MS = 5000;
/** The offset is the largest of this many recent samples. */
const SAMPLES = 10;

let samples: number[] = [];

/**
 * Notes the Date header of a response that arrived at phoneMs. The header
 * time is the server time rounded down to the second, so add 500 ms. A late
 * or cached response (an old Date header) gives a sample that is too low,
 * never too high, so the largest recent sample is the best estimate.
 */
export function noteServerDate(dateHeader: string | null, phoneMs = Date.now()): void {
  if (!dateHeader) return;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs)) return;
  samples.push(serverMs + 500 - phoneMs);
  if (samples.length > SAMPLES) samples = samples.slice(-SAMPLES);
}

/** The offset from the phone clock to the server clock, in ms. */
export function serverOffsetMs(): number {
  if (!samples.length) return 0;
  const best = Math.max(...samples);
  return Math.abs(best) < MIN_OFFSET_MS ? 0 : best;
}

/** Now on the server clock, in unix seconds. */
export function serverNow(phoneMs = Date.now()): number {
  return (phoneMs + serverOffsetMs()) / 1000;
}

/** For tests. */
export function resetServerClock(): void {
  samples = [];
}
