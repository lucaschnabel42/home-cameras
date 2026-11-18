import { describe, expect, it } from "vitest";
import { pickLive, type LiveCandidate } from "./liveCap";

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
