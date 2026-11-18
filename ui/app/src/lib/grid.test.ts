import { describe, expect, it } from "vitest";
import { homeColumns, isTall, wallLayout } from "./grid";

describe("homeColumns", () => {
  it("keeps one column for one or two cameras on a phone", () => {
    expect(homeColumns(1, 358)).toBe(1);
    expect(homeColumns(2, 358)).toBe(1);
  });
  it("puts two cameras side by side on a wide screen", () => {
    expect(homeColumns(2, 812)).toBe(2);
    expect(homeColumns(2, 950)).toBe(2);
  });
  it("gives two columns for three or four cameras", () => {
    expect(homeColumns(3, 358)).toBe(2);
    expect(homeColumns(4, 950)).toBe(2);
  });
  it("gives a near-square grid for many cameras when the width allows it", () => {
    expect(homeColumns(9, 950)).toBe(3);
    expect(homeColumns(16, 950)).toBe(4);
    expect(homeColumns(20, 1400)).toBe(5);
  });
  it("never makes a tile narrower than the minimum", () => {
    expect(homeColumns(9, 358)).toBe(2);
    expect(homeColumns(16, 358)).toBe(2);
    expect(homeColumns(16, 120)).toBe(1);
  });
});

describe("wallLayout", () => {
  const wide = (n: number) => Array.from({ length: n }, () => 16 / 9);
  it("fills a desktop screen with a near-square grid", () => {
    expect(wallLayout(wide(1), 1440, 900)).toMatchObject({ cols: 1, rows: 1 });
    expect(wallLayout(wide(4), 1440, 900)).toMatchObject({ cols: 2, rows: 2 });
    expect(wallLayout(wide(9), 1440, 900)).toMatchObject({ cols: 3, rows: 3 });
    expect(wallLayout(wide(16), 1440, 900)).toMatchObject({ cols: 4, rows: 4 });
  });
  it("puts two cameras side by side on a landscape screen and one above the other in portrait", () => {
    expect(wallLayout(wide(2), 844, 390)).toMatchObject({ cols: 2, rows: 1 });
    expect(wallLayout(wide(2), 390, 844)).toMatchObject({ cols: 1, rows: 2 });
  });
  it("gives a tall camera two rows", () => {
    const l = wallLayout([16 / 9, 16 / 9, 3 / 4], 1440, 900);
    expect(l.cols * l.rows).toBeGreaterThanOrEqual(4);
    expect(l.rows).toBeGreaterThanOrEqual(2);
    expect(isTall(3 / 4)).toBe(true);
    expect(isTall(16 / 9)).toBe(false);
  });
  it("gives a larger picture than any other column count", () => {
    for (const n of [3, 5, 6, 7, 9, 12, 16, 20]) {
      for (const [w, h] of [[1440, 900], [390, 844], [844, 390]]) {
        const l = wallLayout(wide(n), w, h);
        for (let c = 1; c <= n; c++) {
          const r = Math.ceil(n / c);
          const tw = Math.min((w - 6 * (c - 1)) / c, (((h - 6 * (r - 1)) / r) * 16) / 9);
          expect(l.tileWidth).toBeGreaterThanOrEqual(Math.floor(tw) - 1);
        }
      }
    }
  });
  it("is safe with no cameras or no space", () => {
    expect(wallLayout([], 1440, 900)).toEqual({ cols: 1, rows: 1, tileWidth: 0 });
    expect(wallLayout(wide(3), 0, 900).tileWidth).toBe(0);
  });
});
