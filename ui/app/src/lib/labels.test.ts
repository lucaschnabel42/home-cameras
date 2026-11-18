import { describe, expect, it } from "vitest";
import type { Pet } from "./appConfig";
import { caption, isUrgent, kindName, kinds, lowerTitle, placePhrase, subject } from "./labels";

const rex: Pet = { name: "Rex", camera: "living_room_cam", label: "dog" };
const mia: Pet = { name: "Mia", camera: "kitchen_cam", label: "cat" };

describe("caption", () => {
  it("names the pet and keeps a fixed order", () => {
    expect(caption(["dog", "person"], "Living room", rex)).toBe("Person and Rex in the living room");
  });
  it("says barking once, not the pet twice", () => {
    expect(caption(["dog", "bark"], "Living room", rex)).toBe("Rex barking in the living room");
    expect(caption(["howl"], "Living room", rex)).toBe("Rex barking in the living room");
  });
  it("says dog and cat when no pet is set", () => {
    expect(caption(["dog"], "Living room")).toBe("Dog in the living room");
    expect(caption(["cat"], "Living room", null)).toBe("Cat in the living room");
    expect(caption(["person", "dog"], "Living room")).toBe("Person and dog in the living room");
    expect(caption(["bark"], "Living room")).toBe("Dog barking in the living room");
  });
  it("names only the animal of the pet's kind", () => {
    expect(caption(["cat", "dog"], "Kitchen", mia)).toBe("Mia and dog in the kitchen");
    expect(caption(["bark"], "Kitchen", mia)).toBe("Dog barking in the kitchen");
  });
  it("puts an alarm first", () => {
    expect(caption(["person", "smoke_detector"], "Living room")).toBe("Smoke alarm and person in the living room");
    expect(caption(["fire_alarm", "smoke_detector"], "Living room")).toBe("Smoke alarm in the living room");
    expect(caption(["shatter"], "Front porch")).toBe("Glass breaking at the front porch");
  });
  it("says movement when there is no label", () => {
    expect(caption([], "Front porch")).toBe("Movement at the front porch");
  });
  it("keeps an unknown label, with spaces for underscores", () => {
    expect(caption(["car"], "Front porch")).toBe("Car at the front porch");
    expect(subject(["license_plate"])).toBe("License plate");
  });
});

describe("kinds and urgency", () => {
  it("sorts labels into the filter kinds", () => {
    expect(kinds(["person"])).toEqual(new Set(["people"]));
    expect(kinds(["dog"])).toEqual(new Set(["animals"]));
    expect(kinds(["cat"])).toEqual(new Set(["animals"]));
    expect(kinds(["bark"])).toEqual(new Set(["animals", "sounds"]));
    expect(kinds(["car", "truck"])).toEqual(new Set(["vehicles"]));
    expect(kinds(["smoke_detector", "person"])).toEqual(new Set(["people", "sounds"]));
  });
  it("names the animals chip after the pet when one is set", () => {
    expect(kindName("animals", rex)).toBe("Rex");
    expect(kindName("animals", null)).toBe("Animals");
    expect(kindName("vehicles", null)).toBe("Vehicles");
  });
  it("marks alarms and glass urgent", () => {
    expect(isUrgent(["shatter"])).toBe(true);
    expect(isUrgent(["fire_alarm"])).toBe(true);
    expect(isUrgent(["bark", "person"])).toBe(false);
  });
});

describe("placePhrase", () => {
  // The table of the place phrase. helper/test_names.py has the same rows.
  it.each([
    ["Living room", "in the living room"],
    ["Front porch", "at the front porch"],
    ["Front Door", "at the front door"],
    ["TV room", "in the TV room"],
    ["Emma's room", "in Emma's room"],
    ["The den", "in the den"],
    ["Garage 2", "at the garage 2"],
    // Names derived from a Frigate key read as they did before the names existed.
    ["Cam1", "in the cam1"],
    ["Back-yard", "at the back-yard"],
    ["A1 hall", "in the A1 hall"],
  ])("%s -> %s", (title, phrase) => {
    expect(placePhrase(title)).toBe(phrase);
  });
  it("treats the curly apostrophe as the straight one", () => {
    expect(placePhrase("Emma’s room")).toBe("in Emma’s room");
  });
  it("keeps a word of one capital letter", () => {
    expect(placePhrase("Room A")).toBe("in the room A");
  });
  it("puts a user's name in a caption", () => {
    expect(caption(["person"], "Front Door")).toBe("Person at the front door");
  });
});

describe("lowerTitle", () => {
  it("lowers the plain words and keeps the others", () => {
    expect(lowerTitle("Emma's TV Room")).toBe("Emma's TV room");
  });
});
