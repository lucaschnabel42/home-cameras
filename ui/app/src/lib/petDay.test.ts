import { describe, expect, it } from "vitest";
import { countsLine, firstSentence, mainLine, nearestMoment, petDayTitle, stripRange } from "./petDay";
import type { PetDay, PetMoment } from "./helper";

const m = (t: number, place = 0): PetMoment => ({ t, place, image: `d/${t}.jpg`, kind: null, title: null, review: null });

const day = (over: Partial<PetDay> = {}): PetDay => ({
  date: "2026-10-17",
  updated: 0,
  rest: "d/rest.jpg",
  main: { place: 0, minutes: 293 },
  places: [
    { id: 0, name: "couch", x: 0.4, y: 0.6, minutes: 293 },
    { id: 1, name: null, x: 0.8, y: 0.7, minutes: 12 },
  ],
  ribbon: [
    { start: 1000, end: 5000, place: 0 },
    { start: 6000, end: 6500, place: 1 },
  ],
  moments: [m(1100), m(3000), m(6100, 1)],
  barks: [{ start: 7000, end: 7060 }],
  story: null,
  ...over,
});

describe("mainLine", () => {
  it("names his main place and how long he was seen there", () => {
    expect(mainLine(day())).toBe("Mostly on the couch, 4 h 53 min");
  });
  it("says 'in one spot' when the place has no name", () => {
    expect(mainLine(day({ main: { place: 1, minutes: 45 } }))).toBe("Mostly in one spot, 45 min");
  });
  it("says nothing without a main place", () => {
    expect(mainLine(day({ main: null }))).toBeNull();
  });
});

describe("countsLine", () => {
  it("counts spots, moments and barks, and skips a zero", () => {
    expect(countsLine(day())).toBe("2 spots, 3 moments, 1 bark");
    expect(countsLine(day({ barks: [] }))).toBe("2 spots, 3 moments");
    expect(countsLine(day({ places: [day().places[0]], moments: [m(1)] , barks: [] }))).toBe("1 spot, 1 moment");
  });
});

describe("nearestMoment", () => {
  it("picks the moment closest in time", () => {
    const ms = day().moments;
    expect(nearestMoment(ms, 2000)?.t).toBe(1100);
    expect(nearestMoment(ms, 2100)?.t).toBe(3000);
    expect(nearestMoment(ms, 99999)?.t).toBe(6100);
    expect(nearestMoment([], 1)).toBeNull();
  });
});

describe("stripRange", () => {
  it("spans the ribbon, the moments and the barks", () => {
    expect(stripRange(day())).toEqual([1000, 7060]);
  });
  it("is null for an empty day", () => {
    expect(stripRange(day({ ribbon: [], moments: [], barks: [] }))).toBeNull();
  });
});

describe("firstSentence", () => {
  it("cuts at the first full stop", () => {
    expect(firstSentence("The first big nap. Then more naps.")).toBe("The first big nap.");
    expect(firstSentence("No stop here")).toBe("No stop here");
  });
});

describe("petDayTitle", () => {
  it("names the day after the pet", () => {
    expect(petDayTitle({ name: "Rex", camera: "living_room_cam", label: "dog" })).toBe("Rex's day");
  });
});
