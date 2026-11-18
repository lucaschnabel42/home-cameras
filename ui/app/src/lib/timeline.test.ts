import { describe, expect, it } from "vitest";
import { EVENT_LEAD_S, buildClipMap, clipToWall, momentsFor, motionBins, playStart, startTime, titleAt, wallToClip, type Moment, type Segment } from "./timeline";

const seg = (start: number, end: number, motion = 0): Segment => ({ start_time: start, end_time: end, motion, objects: 0 });

// Window 1000..1060 with a recording gap 1020..1030: the file is 50 s long.
const segments = [seg(995, 1005, 4), seg(1005, 1015), seg(1015, 1020, 10), seg(1030, 1040), seg(1040, 1050), seg(1050, 1065)];
const map = buildClipMap(segments, 1000, 1060);

describe("buildClipMap", () => {
  it("clips segments to the window and closes gaps", () => {
    expect(map.duration).toBe(50);
    expect(map.pieces[0]).toEqual({ wallStart: 1000, wallEnd: 1005, clipStart: 0 });
    expect(map.pieces.find((p) => p.wallStart === 1030)?.clipStart).toBe(20);
  });
  it("treats no recordings as one continuous window", () => {
    expect(buildClipMap([], 1000, 1060)).toEqual({ pieces: [{ wallStart: 1000, wallEnd: 1060, clipStart: 0 }], duration: 60 });
  });
});

describe("wallToClip and clipToWall", () => {
  it("maps before and after the gap", () => {
    expect(wallToClip(map, 1012)).toBe(12);
    expect(wallToClip(map, 1035)).toBe(25);
  });
  it("snaps a time inside the gap to where recording resumes", () => {
    expect(wallToClip(map, 1025)).toBe(20);
  });
  it("clamps outside the window", () => {
    expect(wallToClip(map, 900)).toBe(0);
    expect(wallToClip(map, 2000)).toBe(50);
  });
  it("inverts", () => {
    expect(clipToWall(map, 25)).toBe(1035);
    expect(clipToWall(map, 12)).toBe(1012);
  });
});

describe("momentsFor", () => {
  it("places reviews in clip time and ends an open one at the window end", () => {
    const m = momentsFor(map, [
      { start_time: 1035, end_time: null, data: { objects: ["car"] } },
      { start_time: 1010, end_time: 1014, data: { objects: ["person"] } },
    ]);
    expect(m).toEqual([
      { start: 10, end: 14, labels: ["person"] },
      { start: 25, end: 50, labels: ["car"] },
    ]);
  });
  it("keeps the review id, so the player can name each moment", () => {
    expect(momentsFor(map, [{ id: "r1", start_time: 1010, end_time: 1014, data: { objects: ["person"] } }])[0].id).toBe("r1");
  });
  it("drops reviews outside the window", () => {
    expect(momentsFor(map, [{ start_time: 5000, end_time: 5010, data: { objects: ["person"] } }])).toEqual([]);
  });
});

describe("startTime", () => {
  it("starts 5 s before the first moment, never before 0", () => {
    expect(startTime([{ start: 30, end: 40, labels: [] }])).toBe(25);
    expect(startTime([{ start: 2, end: 4, labels: [] }])).toBe(0);
    expect(startTime([])).toBe(0);
  });
});

describe("playStart", () => {
  const moments: Moment[] = [{ start: 10, end: 14, labels: [] }];
  it("starts EVENT_LEAD_S before the chosen event, through the real segments", () => {
    expect(EVENT_LEAD_S).toBe(2);
    // 1035 is clip 25 (the gap 1020..1030 is not in the file).
    expect(playStart({ map, moments, startAt: 1035, window: { start: 1000, end: 1060 } })).toBe(23);
  });
  it("clamps the start to the clip", () => {
    expect(playStart({ map, moments, startAt: 1001, window: { start: 1000, end: 1060 } })).toBe(0);
    expect(playStart({ map, moments, startAt: 900, window: { start: 1000, end: 1060 } })).toBe(0);
    expect(playStart({ map, moments, startAt: 9000, window: { start: 1000, end: 1060 } })).toBe(48);
  });
  it("uses the window when the timeline did not load", () => {
    expect(playStart({ map: null, moments: [], startAt: 1035, window: { start: 1000, end: 1060 } })).toBe(33);
    expect(playStart({ map: null, moments: [], startAt: 1035, window: null })).toBe(0);
  });
  it("starts at the first moment when no event was chosen", () => {
    expect(playStart({ map, moments, startAt: null, window: { start: 1000, end: 1060 } })).toBe(startTime(moments));
  });
});

describe("titleAt", () => {
  const ms: Moment[] = [
    { id: "a", start: 10, end: 200, labels: [] },
    { id: "b", start: 60, end: 64, labels: [] },
    { id: "c", start: 300, end: 310, labels: [] },
  ];
  const name = (m: Moment) => `title ${m.id}`;
  it("names the clip before the first moment", () => {
    expect(titleAt(ms, 0, name, "Clip")).toBe("Clip");
  });
  it("names the moment that started last at the playhead", () => {
    expect(titleAt(ms, 30, name, "Clip")).toBe("title a");
    expect(titleAt(ms, 62, name, "Clip")).toBe("title b");
    // Between moments the title stays until a new moment starts.
    expect(titleAt(ms, 250, name, "Clip")).toBe("title b");
    expect(titleAt(ms, 305, name, "Clip")).toBe("title c");
  });
  it("names the chosen event from the start point, EVENT_LEAD_S before it", () => {
    expect(titleAt(ms, 300 - EVENT_LEAD_S, name, "Clip")).toBe("title c");
  });
});

describe("motionBins", () => {
  it("spreads segment motion over clip-time bins and scales to the peak", () => {
    const bins = motionBins(map, segments, 5); // 10 s per bin over 50 s
    expect(bins).toHaveLength(5);
    expect(bins[1]).toBe(1); // 1015..1020 (motion 10) lands in clip 15..20
    expect(bins[0]).toBeCloseTo(0.4); // 995..1005 (motion 4) lands in clip 0..5
    expect(bins[3]).toBe(0);
  });
  it("is all zero when nothing moved", () => {
    expect(motionBins(map, [seg(1000, 1060)], 3)).toEqual([0, 0, 0]);
  });
});
