import { describe, expect, it } from "vitest";
import { contentSize, homeColumns, isTall, sectionColumns, wallLayout } from "./grid";

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

describe("sectionColumns", () => {
  it("puts two cameras side by side, also in a narrow section", () => {
    expect(sectionColumns(2, 358)).toBe(2);
    expect(sectionColumns(2, 375)).toBe(2);
    // homeColumns stacks two cameras there: a home screen with no sections.
    expect(homeColumns(2, 375)).toBe(1);
  });
  it("gives the columns of the home grid for other counts", () => {
    expect(sectionColumns(1, 375)).toBe(1);
    expect(sectionColumns(3, 358)).toBe(2);
    expect(sectionColumns(9, 950)).toBe(3);
    expect(sectionColumns(2, 120)).toBe(1);
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
  it("gets the box inside the padding, so five cameras fill a desktop screen", () => {
    // The wall area of a 1440 x 900 screen: 825 px above the event strip,
    // with 6 px of padding and 64 px more at the top while the controls show.
    const box = contentSize(1440, 825, { top: 70, right: 6, bottom: 6, left: 6 });
    expect(box).toEqual({ width: 1428, height: 749 });
    expect(wallLayout(wide(5), box.width, box.height)).toMatchObject({ cols: 3, rows: 2 });
    // The padding box is too high: it gave two columns and a wide empty band.
    expect(wallLayout(wide(5), 1440, 825)).toMatchObject({ cols: 2, rows: 3 });
  });
  it("makes each row only as high as its pictures need", () => {
    // Five 16:9 cameras, three columns: the width sets the picture, so the
    // two rows do not need the whole height and the grid can sit together.
    expect(wallLayout(wide(5), 1428, 749)).toMatchObject({ cols: 3, rows: 2, rowHeight: 265 });
    // One camera on a low, wide screen: the height sets the picture.
    expect(wallLayout(wide(1), 1440, 300)).toMatchObject({ rowHeight: 300 });
    // A 4:3 camera needs a higher row than a 16:9 camera of the same width.
    expect(wallLayout([4 / 3, 16 / 9], 390, 844)).toMatchObject({ cols: 1, rows: 2, rowHeight: 292 });
    // A tall camera has two rows and the gap between them.
    const l = wallLayout([16 / 9, 16 / 9, 3 / 4], 1440, 900);
    expect(l.rowHeight * l.rows + 6 * (l.rows - 1)).toBeLessThanOrEqual(900);
    expect(l.rowHeight).toBeGreaterThan(0);
  });
  it("is safe with no cameras or no space", () => {
    expect(wallLayout(wide(3), 0, 900).rowHeight).toBe(0);
    expect(contentSize(10, 10, { top: 8, right: 8, bottom: 8, left: 8 })).toEqual({ width: 0, height: 0 });
    expect(wallLayout([], 1440, 900)).toEqual({ cols: 1, rows: 1, tileWidth: 0, rowHeight: 0 });
    expect(wallLayout(wide(3), 0, 900).tileWidth).toBe(0);
  });
});
