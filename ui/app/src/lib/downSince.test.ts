import { describe, expect, it } from "vitest";
import { blindSpots } from "./activity";
import { downSentence, downSince, gapViews } from "./downSince";

const at = (mo: number, d: number, h: number, mi = 0) => new Date(2026, mo - 1, d, h, mi).getTime() / 1000;
const NOW = at(11, 17, 22, 0);
const now = new Date(NOW * 1000);
const DAY = 86_400;
const RETAIN_DAYS = 7;
const retainStartS = NOW - RETAIN_DAYS * DAY;
const sentence = (gap: { start: number; openStart: boolean } | null, lastLive: number | null) =>
  downSentence(downSince({ gap, lastLive, retainStartS }), RETAIN_DAYS, now);

describe("the sentence for a camera that does not record", () => {
  it("uses the start of Frigate's gap inside the retention", () => {
    expect(sentence({ start: at(11, 17, 19, 1), openStart: false }, null)).toBe("Not recording since 7:01 pm (2 h 59 min)");
    expect(sentence({ start: at(11, 14, 6, 30), openStart: false }, null)).toBe("Not recording since Nov 14, 6:30 am (3 days)");
  });
  it("uses the helper's last-live time when the gap is older than the retention", () => {
    // A camera whose last-live time is a seed value: 2026-10-15 19:01.
    expect(sentence({ start: retainStartS, openStart: true }, at(10, 15, 19, 1))).toBe("Not recording since Oct 15, 7:01 pm (33 days)");
  });
  it("says 'for over 7 days' when neither knows, never 'over 2 days'", () => {
    expect(sentence({ start: retainStartS, openStart: true }, null)).toBe("Not recording for over 7 days");
    expect(downSentence({ kind: "older" }, 7, now)).not.toContain("2 days");
  });
  it("prefers Frigate's gap to the helper inside the retention", () => {
    expect(sentence({ start: at(11, 17, 19, 1), openStart: false }, at(11, 17, 18, 0))).toBe("Not recording since 7:01 pm (2 h 59 min)");
  });
  it("does not trust a helper time that is inside the retention when Frigate's gap is older", () => {
    expect(sentence({ start: retainStartS, openStart: true }, at(11, 16, 12, 0))).toBe("Not recording for over 7 days");
  });
  it("uses the helper when Frigate has no gap yet, and says only 'Not recording' when nothing is known", () => {
    expect(sentence(null, at(11, 17, 21, 50))).toBe("Not recording since 9:50 pm (10 min)");
    expect(sentence(null, null)).toBe("Not recording");
  });
  it("counts whole days from two days on", () => {
    expect(sentence({ start: NOW - 47 * 3600, openStart: false }, null)).toMatch(/\(47 h\)$/);
    expect(sentence({ start: NOW - 49 * 3600, openStart: false }, null)).toMatch(/\(2 days\)$/);
  });
});

describe("gapViews", () => {
  const FEED_S = 2 * DAY;
  const RETAIN_S = RETAIN_DAYS * DAY;
  it("gives the feed the same rows as a 2-day question, and the open gap over the retention", () => {
    // Frigate answers one range that starts where the question starts.
    const raw = [{ start_time: NOW - RETAIN_S, end_time: NOW }];
    const v = gapViews("porch", raw, NOW, FEED_S, RETAIN_S);
    expect(v.spots).toEqual(blindSpots("porch", [{ start_time: NOW - FEED_S, end_time: NOW }], NOW - FEED_S, NOW));
    expect(v.spots[0]).toMatchObject({ ongoing: true, openStart: true });
    expect(v.ongoing).toEqual({ start: NOW - RETAIN_S, openStart: true });
  });
  it("finds a short open gap that is not a feed row, and keeps closed gaps out of the open one", () => {
    const raw = [
      { start_time: NOW - 4 * DAY, end_time: NOW - 3 * DAY },
      { start_time: NOW - 3600, end_time: NOW - 1800 },
      { start_time: NOW - 300, end_time: NOW },
    ];
    const v = gapViews("lr", raw, NOW, FEED_S, RETAIN_S);
    expect(v.spots.map((g) => g.start)).toEqual([NOW - 3600]);
    expect(v.ongoing).toEqual({ start: NOW - 300, openStart: false });
  });
  it("has no open gap for a camera that records", () => {
    expect(gapViews("lr", [{ start_time: NOW - 3600, end_time: NOW - 1800 }], NOW, FEED_S, RETAIN_S).ongoing).toBeNull();
  });
});
