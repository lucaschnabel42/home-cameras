import { describe, expect, it } from "vitest";
import { clampView, pan, pinch, IDENTITY, type View } from "./zoom";

const box = { w: 400, h: 225 };

describe("clampView", () => {
  it("keeps scale between 1 and the maximum", () => {
    expect(clampView({ s: 0.5, x: 0, y: 0 }, box, 4).s).toBe(1);
    expect(clampView({ s: 9, x: 0, y: 0 }, box, 4).s).toBe(4);
  });
  it("never shows past an edge of the picture", () => {
    // at 2x the picture is 800x450: x runs from -400 to 0, y from -225 to 0
    expect(clampView({ s: 2, x: 50, y: 10 }, box, 4)).toEqual({ s: 2, x: 0, y: 0 });
    expect(clampView({ s: 2, x: -999, y: -999 }, box, 4)).toEqual({ s: 2, x: -400, y: -225 });
  });
  it("returns to rest at 1x", () => {
    expect(clampView({ s: 1, x: -30, y: 12 }, box, 4)).toEqual(IDENTITY);
  });
});

describe("pinch", () => {
  it("keeps the point between the fingers still while it zooms", () => {
    const start: View = IDENTITY;
    const mid = { x: 100, y: 50 };
    const v = pinch(start, mid, 100, mid, 200, box, 4);
    expect(v.s).toBe(2);
    // the picture point under the fingers (100, 50) is still at (100, 50)
    expect(v.x + v.s * 100).toBeCloseTo(100);
    expect(v.y + v.s * 50).toBeCloseTo(50);
  });
  it("follows the fingers when they move together", () => {
    const start: View = { s: 2, x: -200, y: -100 };
    const v = pinch(start, { x: 200, y: 100 }, 100, { x: 150, y: 80 }, 100, box, 4);
    expect(v).toEqual({ s: 2, x: -250, y: -120 });
  });
});

describe("pan", () => {
  it("moves the zoomed picture with one finger, inside its edges", () => {
    const start: View = { s: 2, x: -200, y: -100 };
    expect(pan(start, 50, 20, box, 4)).toEqual({ s: 2, x: -150, y: -80 });
    expect(pan(start, 500, 500, box, 4)).toEqual({ s: 2, x: 0, y: 0 });
  });
  it("does nothing at 1x", () => {
    expect(pan(IDENTITY, 50, 20, box, 4)).toEqual(IDENTITY);
  });
});
