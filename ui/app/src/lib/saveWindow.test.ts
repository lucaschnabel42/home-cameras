import { describe, expect, it } from "vitest";
import { SAVE_STEPS, saveWindow } from "./saveWindow";

describe("saveWindow", () => {
  it("offers 5 to 30 minutes in 5-minute steps", () => {
    expect(SAVE_STEPS).toEqual([5, 10, 15, 20, 25, 30]);
  });
  it("ends 15 s before now so the last segment has closed", () => {
    expect(saveWindow(15, 10_000)).toEqual({ start: 10_000 - 900, end: 10_000 - 15 });
  });
  it("floors fractional now", () => {
    expect(saveWindow(5, 10_000.9)).toEqual({ start: 9_700, end: 9_985 });
  });
  it("rejects a length that is not a step", () => {
    expect(() => saveWindow(7, 10_000)).toThrow();
  });
});
