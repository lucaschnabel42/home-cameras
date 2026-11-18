import { describe, expect, it } from "vitest";
import { blindSpots, clockUnder, dayTitle, readyLength, gapRowStart, groupSessions, sections, span, type Row } from "./activity";
import type { EventEntry } from "./feed";

process.env.TZ = "America/Chicago";

const ev = (key: string, start: number, end: number | null, labels = ["person"], camera = "living_room_cam"): EventEntry => ({
  key, camera, start, end, labels, severity: "detection", state: "ready", thumbUrl: "", clipUrl: "/x.mp4",
  window: null, shareUrl: null, clipSeconds: 300, reviewIds: [key],
});

const T = 1_792_000_000; // a real unix time

describe("groupSessions", () => {
  it("joins events on one camera less than the gap apart, newest first", () => {
    const s = groupSessions([ev("c", T + 2000, T + 2010), ev("b", T + 1000, T + 1010), ev("a", T, T + 10)], 1200);
    expect(s.map((x) => x.entries.map((e) => e.key))).toEqual([["c", "b", "a"]]);
    expect(s[0].start).toBe(T);
    expect(s[0].end).toBe(T + 2010);
  });
  it("splits at a gap longer than the limit", () => {
    const s = groupSessions([ev("b", T + 2000, T + 2010), ev("a", T, T + 10)], 1200);
    expect(s.map((x) => x.entries.map((e) => e.key))).toEqual([["b"], ["a"]]);
  });
  it("keeps cameras apart", () => {
    const s = groupSessions([ev("b", T + 60, T + 70, ["person"], "porch"), ev("a", T, T + 10)], 1200);
    expect(s).toHaveLength(2);
  });
  it("never folds a smoke alarm or glass into a group", () => {
    const s = groupSessions([ev("b", T + 60, T + 70, ["smoke_detector"]), ev("a", T, T + 10)], 1200);
    expect(s.map((x) => x.entries.map((e) => e.key))).toEqual([["b"], ["a"]]);
  });
  it("treats an event still going as touching now", () => {
    const s = groupSessions([ev("b", T + 600, null), ev("a", T, T + 10)], 1200);
    expect(s).toHaveLength(1);
    expect(s[0].end).toBeNull();
  });
  it("collects the labels of every event", () => {
    const s = groupSessions([ev("b", T + 60, T + 70, ["dog"]), ev("a", T, T + 10, ["person"])], 1200);
    expect(s[0].labels.sort()).toEqual(["dog", "person"]);
  });
});

describe("blindSpots", () => {
  it("keeps gaps of 10 min or more and marks one that runs to now", () => {
    const gaps = [
      { start_time: T, end_time: T + 60 },
      { start_time: T + 1000, end_time: T + 1000 + 49_200 },
      { start_time: T + 60_000, end_time: T + 70_000 },
    ];
    const b = blindSpots("living_room_cam", gaps, T + 900, T + 70_030);
    expect(b.map((x) => [x.start, x.end, x.ongoing, x.openStart])).toEqual([
      [T + 60_000, T + 70_000, true, false],
      [T + 1000, T + 50_200, false, true],
    ]);
  });
});

describe("dayTitle and sections", () => {
  const now = new Date(2026, 9, 16, 9, 0); // Fri Oct 16, 9:00 am local
  const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).getTime() / 1000;
  it("says Today, Yesterday, then the weekday and date", () => {
    expect(dayTitle(at(16, 1), now)).toBe("Today");
    expect(dayTitle(at(15, 23), now)).toBe("Yesterday");
    expect(dayTitle(at(14, 12), now)).toBe("Wednesday, Oct 14");
  });
  it("puts rows under their day, newest day first", () => {
    const rows: Row[] = [
      { kind: "session", start: at(16, 8), session: groupSessions([ev("a", at(16, 8), at(16, 8) + 10)])[0] },
      { kind: "session", start: at(14, 9), session: groupSessions([ev("b", at(14, 9), at(14, 9) + 10)])[0] },
      { kind: "gap", start: at(16, 2), gap: { camera: "x", start: at(16, 2), end: at(16, 3), ongoing: false, openStart: false } },
    ];
    const s = sections(rows, now);
    expect(s.map((x) => [x.title, x.rows.length])).toEqual([["Today", 2], ["Wednesday, Oct 14", 1]]);
    expect(s[0].rows[0].start).toBe(at(16, 8)); // newest first inside a day
  });
});

describe("groupSessions edges", () => {
  it("does not fold a normal event into a smoke alarm's visit", () => {
    const s = groupSessions([ev("b", T + 60, T + 70, ["person"]), ev("a", T, T + 10, ["smoke_detector"])], 1200);
    expect(s.map((x) => x.entries.map((e) => e.key))).toEqual([["b"], ["a"]]);
  });
  it("keeps the later end when a short event sits inside a long one", () => {
    const s = groupSessions([ev("b", T + 100, T + 110), ev("a", T, T + 5000)], 1200);
    expect(s[0].end).toBe(T + 5000);
  });
  it("joins at exactly the gap and splits one second past it", () => {
    expect(groupSessions([ev("b", T + 10 + 1200, T + 1300), ev("a", T, T + 10)], 1200)).toHaveLength(1);
    expect(groupSessions([ev("b", T + 10 + 1201, T + 1300), ev("a", T, T + 10)], 1200)).toHaveLength(2);
  });
});

describe("blindSpots edges", () => {
  it("keeps a gap of exactly 10 min and drops one second less", () => {
    const b = blindSpots("c", [{ start_time: T, end_time: T + 600 }, { start_time: T + 5000, end_time: T + 5599 }], T - 10_000, T + 90_000);
    expect(b.map((x) => x.start)).toEqual([T]);
  });
});

describe("gapRowStart", () => {
  const L = (s: string) => new Date(s).getTime() / 1000; // local time
  const now = new Date("2026-11-17T08:00:00");
  const nowS = now.getTime() / 1000;
  const after = nowS - 2 * 86400;
  const header = (gaps: { start_time: number; end_time: number }[]) => {
    const g = blindSpots("front_porch_cam", gaps, after, nowS)[0];
    return sections([{ kind: "gap", start: gapRowStart(g, nowS), gap: g }], now)[0].title;
  };
  it("files a gap that began before the window and ended today under Today, the day of its end", () => {
    // The row says only "Until 7:00 am", so its header must be the end day.
    expect(header([{ start_time: after, end_time: L("2026-11-17T07:00:00") }])).toBe("Today");
  });
  it("files a gap that began in the window under its start day", () => {
    expect(header([{ start_time: L("2026-11-16T22:00:00"), end_time: L("2026-11-17T06:00:00") }])).toBe("Yesterday");
  });
  it("files a gap that is still open under Today", () => {
    expect(header([{ start_time: L("2026-11-16T22:00:00"), end_time: nowS }])).toBe("Today");
  });
});

describe("clockUnder", () => {
  const L = (s: string) => new Date(s).getTime() / 1000; // local time
  const now = new Date("2026-11-17T08:00:00");
  it("names the day of a row in a visit that crossed midnight", () => {
    // The visit starts at 11:50 pm yesterday, so its rows sit under "Yesterday".
    expect(clockUnder(L("2026-11-17T00:10:00"), L("2026-11-16T23:50:00"), now)).toBe("today at 12:10 am");
  });
  it("names an older day in short form", () => {
    expect(clockUnder(L("2026-11-16T00:10:00"), L("2026-11-15T23:50:00"), now)).toBe("yesterday at 12:10 am");
    expect(clockUnder(L("2026-11-15T00:10:00"), L("2026-11-14T23:50:00"), now)).toBe("Sun, Nov 15 at 12:10 am");
  });
  it("gives only the clock time on the day of the header", () => {
    expect(clockUnder(L("2026-11-16T23:55:00"), L("2026-11-16T23:50:00"), now)).toBe("11:55 pm");
  });
});

describe("readyLength", () => {
  it("says that a clip is only the first part of a longer event", () => {
    // A case from live data: event 7:26 pm to 10:54 pm (12,500 s),
    // clip 7:06 pm to 8:28 pm (4,938 s).
    const s = 1_794_792_367;
    const e = { ...ev("long", s, s + 12_500), window: { start: s - 1200, end: s - 1200 + 4938 }, clipSeconds: 4938 };
    expect(readyLength(e, s + 20_000)).toBe("First 1 h 22 min of 3 h 28 min");
  });
  it("shows the event length when the clip covers the whole event", () => {
    const e = { ...ev("short", T, T + 40), window: { start: T - 150, end: T + 190 }, clipSeconds: 340 };
    expect(readyLength(e, T + 1000)).toBe("40 s");
  });
  it("shows the event length when the clip has no window", () => {
    expect(readyLength(ev("x", T, T + 600), T + 1000)).toBe("10 min");
  });
});

describe("span, for a detection of one frame", () => {
  it("never says 0 s", () => {
    // Frigate keeps review items of 0.0 to 0.4 s: one frame with a person in it.
    expect(span(0)).toBe("under 1 s");
    expect(span(0.4)).toBe("under 1 s");
    expect(span(0.6)).toBe("1 s");
    expect(span(26.6)).toBe("27 s");
  });
});
