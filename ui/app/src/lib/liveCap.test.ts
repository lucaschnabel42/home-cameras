import { describe, expect, it } from "vitest";
import { LIVE_CAP_DESKTOP, LIVE_CAP_TOUCH, pickLive, pickLiveAcross, type LiveCandidate } from "./liveCap";

const cams = (n: number): LiveCandidate[] => Array.from({ length: n }, (_, i) => ({ name: `cam_${i}`, canPlay: true }));

describe("pickLive", () => {
  it("plays every tile when the cap allows it", () => {
    expect([...pickLive(cams(2), 4)]).toEqual(["cam_0", "cam_1"]);
  });
  it("plays the first tiles in grid order up to the cap", () => {
    expect([...pickLive(cams(9), 4)]).toEqual(["cam_0", "cam_1", "cam_2", "cam_3"]);
  });
  it("plays the spotlight tile first, then the cameras with a detection", () => {
    const live = pickLive(cams(9), 3, { spotlight: "cam_8", active: ["cam_5"] });
    expect([...live]).toEqual(["cam_8", "cam_5", "cam_0"]);
  });
  it("never plays an offline camera or an on-demand stream, and gives its place to the next tile", () => {
    const tiles = cams(5);
    tiles[0].canPlay = false;
    tiles[2].canPlay = false;
    const live = pickLive(tiles, 2, { spotlight: "cam_0", active: ["cam_2"] });
    expect([...live]).toEqual(["cam_1", "cam_3"]);
  });
  it("ignores a name that is not in the grid", () => {
    expect([...pickLive(cams(2), 4, { spotlight: "gone_cam", active: ["gone_cam"] })]).toEqual(["cam_0", "cam_1"]);
  });
});

describe("pickLiveAcross", () => {
  const section = (prefix: string, n: number): LiveCandidate[] => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, canPlay: true }));
  it("never plays more than the cap across all sections", () => {
    for (const cap of [LIVE_CAP_TOUCH, LIVE_CAP_DESKTOP]) {
      for (const sizes of [[3, 3, 1], [9, 9], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 2], []]) {
        const sections = sizes.map((n, i) => section(`s${i}_`, n));
        const total = sizes.reduce((a, b) => a + b, 0);
        expect(pickLiveAcross(sections, cap).size).toBe(Math.min(cap, total));
      }
    }
  });
  it("gives each section a live tile before a second one", () => {
    const live = pickLiveAcross([section("a", 3), section("b", 3), section("c", 1)], 4);
    expect([...live]).toEqual(["a0", "b0", "c0", "a1"]);
  });
  it("plays the cameras with a detection first and skips a camera that cannot play", () => {
    const sections = [section("a", 3), [{ name: "off", canPlay: false }, ...section("b", 2)]];
    const live = pickLiveAcross(sections, 2, { active: ["b1", "off"] });
    expect([...live]).toEqual(["b1", "a0"]);
  });
});
