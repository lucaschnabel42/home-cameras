// Client for cam-helper (helper/), which Caddy serves at /helper on this
// origin. Every call here is optional: the app works when the helper is down.
// The install settings (/helper/config) are in appConfig.ts.
import { parseNames, type NamesDoc } from "./names";

const TIMEOUT_MS = 10_000;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/helper${path}`, { credentials: "same-origin", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  if (!r.ok) throw new Error(`/helper${path} returned ${r.status}`);
  return (r.status === 204 ? undefined : r.json()) as Promise<T>;
}

const post = (path: string, body: unknown) =>
  call<void>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export interface Summary {
  title: string;
  summary: string;
}

/** Summaries from the local vision model, by review id. */
export const getSummaries = (afterS: number) => call<Record<string, Summary>>(`/summaries?after=${Math.floor(afterS)}`);

/** The last time each camera sent frames (helper/cameras.py). A seeded value has a source other than "frigate-stats". */
export interface LastLive {
  last_live: number;
  source: string;
}
export const getLastLive = () => call<{ cameras: Record<string, LastLive> }>("/cameras").then((r) => r.cameras);

/** The names of the cameras and the groups (lib/names.ts). Fails when cam-helper does not answer. */
export const getNames = () => call<unknown>("/names").then(parseNames);

export type SaveResult =
  | { kind: "saved"; names: NamesDoc }
  /** Another device saved first. Nothing was stored; `names` is the stored document. */
  | { kind: "conflict"; error: string; names: NamesDoc }
  /** cam-helper refused the document (400) or did not answer. */
  | { kind: "failed"; error: string };

/**
 * Store a whole document. `rev` is the revision the client read; cam-helper
 * stores the document only when it is the stored revision. The body has
 * the fields in contract order.
 */
export async function saveNames(doc: NamesDoc): Promise<SaveResult> {
  const body = {
    rev: doc.rev,
    cameras: Object.fromEntries(
      Object.entries(doc.cameras).map(([k, e]) => [k, { ...(e.name ? { name: e.name } : {}), ...(e.group ? { group: e.group } : {}) }]),
    ),
    groups: doc.groups.map((g) => ({ id: g.id, name: g.name })),
  };
  try {
    const r = await fetch("/helper/names", {
      method: "POST",
      credentials: "same-origin",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = (await r.json().catch(() => ({}))) as { error?: unknown; names?: unknown };
    if (r.ok) return { kind: "saved", names: parseNames(answer) };
    const error = typeof answer.error === "string" ? answer.error : `cam-helper returned ${r.status}`;
    // A 409 with no document in it must not empty the names of this screen.
    const stored = answer.names;
    if (r.status === 409 && stored && typeof stored === "object") return { kind: "conflict", error, names: parseNames(stored) };
    return { kind: "failed", error };
  } catch {
    return { kind: "failed", error: "The names service does not answer." };
  }
}

export const getPushKey = () => call<{ publicKey: string }>("/push/key");
export const subscribePush = (sub: PushSubscription) => post("/push/subscribe", sub.toJSON());
export const unsubscribePush = (endpoint: string) => post("/push/unsubscribe", { endpoint });
export const testPush = (endpoint: string) => post("/push/test", { endpoint });

// The pet day: a story of the pet's day and the places it went, made by
// cam-helper once for each day when the install names a pet.
export interface PetDayInfo {
  date: string;
  updated: number;
}
export interface PetPlace {
  id: number;
  /** "couch", "floor", ... from the summaries; null when they do not say. */
  name: string | null;
  x: number;
  y: number;
  /** Minutes Frigate saw the pet there (short gaps filled), not exact time. */
  minutes: number;
}
export interface PetMoment {
  t: number;
  place: number;
  /** Path under /helper/pet/, for example "<date>/<unix time>.jpg". */
  image: string;
  kind: string | null;
  title: string | null;
  review: string | null;
}
export interface PetChapter {
  start: number;
  end: number;
  text: string;
  /** Moment times (PetMoment.t) this chapter shows. */
  moments: number[];
  /** Written by the code (no summary yet), not by the model. */
  code: boolean;
}
export interface PetStory {
  title: string;
  /** The whole day, never rewritten; false while the day is still going. */
  final: boolean;
  written: number;
  chapters: PetChapter[];
}
export interface PetDay {
  date: string;
  updated: number;
  rest: string | null;
  main: { place: number; minutes: number } | null;
  places: PetPlace[];
  ribbon: { start: number; end: number; place: number }[];
  moments: PetMoment[];
  barks: { start: number; end: number }[];
  story: PetStory | null;
}

export const getPetDays = () => call<PetDayInfo[]>("/pet/days");
export const getPetDay = (date: string) => call<PetDay>(`/pet/${date}.json`);
export const petFileUrl = (path: string) => `/helper/pet/${path}`;
