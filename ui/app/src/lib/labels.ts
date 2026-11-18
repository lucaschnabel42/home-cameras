// What Frigate's labels mean to a person. Object labels come from Frigate's
// detector; sound labels come from its audio detection. When the install
// names a pet (lib/appConfig.ts), the label of that pet reads as its name.
import type { Pet } from "./appConfig";

const SOUND = new Set(["bark", "howl", "smoke_detector", "fire_alarm", "shatter"]);
const URGENT = new Set(["smoke_detector", "fire_alarm", "shatter"]);
const ANIMAL = new Set(["dog", "cat", "bird", "horse", "sheep", "cow", "bear", "deer", "fox", "raccoon", "squirrel", "rabbit", "bark", "howl"]);
const VEHICLE = new Set(["car", "motorcycle", "bicycle", "bus", "truck", "boat"]);

/** Phrases in a fixed order, so one event always reads the same way. */
const ORDER = ["smoke alarm", "glass breaking", "person", "barking"];

/** One phrase for each label; labels that mean the same thing share a phrase. */
function phrase(label: string, pet: Pet | null): string {
  switch (label) {
    case "smoke_detector":
    case "fire_alarm":
      return "smoke alarm";
    case "shatter":
      return "glass breaking";
    case "bark":
    case "howl":
      return `${pet?.label === "dog" ? pet.name : "dog"} barking`;
    default:
      return pet && label === pet.label ? pet.name : label.replace(/_/g, " ");
  }
}

export type Kind = "people" | "animals" | "vehicles" | "sounds";

/** The filter kinds in the order of the chips. */
export const KINDS: Kind[] = ["people", "animals", "vehicles", "sounds"];

/** The chip text for a kind. The animals chip carries the pet's name when one is set. */
export function kindName(kind: Kind, pet: Pet | null): string {
  if (kind === "animals") return pet?.name ?? "Animals";
  return { people: "People", vehicles: "Vehicles", sounds: "Sounds" }[kind];
}

/** The filter chips a set of labels belongs to. */
export function kinds(labels: string[]): Set<Kind> {
  const out = new Set<Kind>();
  for (const l of labels) {
    if (l === "person") out.add("people");
    if (ANIMAL.has(l)) out.add("animals");
    if (VEHICLE.has(l)) out.add("vehicles");
    if (SOUND.has(l)) out.add("sounds");
  }
  return out;
}

/** A smoke alarm or breaking glass: never folded into a group of events. */
export const isUrgent = (labels: string[]) => labels.some((l) => URGENT.has(l));

export const isSound = (label: string) => SOUND.has(label);

const OUTDOOR = /porch|door|yard|drive|garage|gate|patio|deck|garden|street/;

function joinAnd(words: string[]): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

/** The subject alone: "Person and dog", "Rex barking". */
export function subject(labels: string[], pet: Pet | null = null): string {
  let phrases = [...new Set(labels.map((l) => phrase(l, pet)))];
  // "Rex barking" already says Rex; "dog barking" already says dog.
  const barking = phrases.find((p) => p.endsWith(" barking"));
  if (barking) phrases = phrases.filter((p) => p !== barking.slice(0, -" barking".length));
  // The pet comes after the fixed phrases and before any other label.
  const rank = (p: string) => {
    const i = ORDER.findIndex((o) => p === o || p.endsWith(` ${o}`));
    if (i >= 0) return i;
    return pet && p === pet.name ? ORDER.length : ORDER.length + 1;
  };
  phrases.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const what = phrases.length ? joinAnd(phrases) : "movement";
  return what.charAt(0).toUpperCase() + what.slice(1);
}

/** "in the living room", "at the front porch". */
export function placePhrase(cameraTitle: string): string {
  const place = cameraTitle.toLowerCase();
  return `${OUTDOOR.test(place) ? "at" : "in"} the ${place}`;
}

/** "Person and dog in the living room". */
export function caption(labels: string[], cameraTitle: string, pet: Pet | null = null): string {
  return `${subject(labels, pet)} ${placePhrase(cameraTitle)}`;
}
