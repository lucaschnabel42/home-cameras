import { describe, expect, it } from "vitest";
import { groupSessions } from "./activity";
import { buildFeed, mediaUrl, type EventEntry, type ExportItem, type ReviewItem } from "./feed";
import { LONG_CLIP_EXPORTS, LONG_CLIP_REVIEWS, LONG_CLIP_SUMMARIES } from "./fixtures/longClip";
import { JOIN_S, eventCount, filterEntries, rowLength, visitRows } from "./visits";

const rv = (id: string, start: number, end: number | null, objects = ["person"], cam = "lr"): ReviewItem => ({
  id, camera: cam, start_time: start, end_time: end, severity: "alert",
  thumb_path: `/media/frigate/clips/review/thumb-${cam}-${id}.webp`, data: { objects },
});
const ex = (id: string, name: string): ExportItem => ({
  id, camera: "lr", name, date: 0, in_progress: false,
  video_path: `/media/frigate/exports/lr_${id}.mp4`, thumb_path: `/media/frigate/exports/lr_${id}.webp`,
});
const sum = (title: string) => ({ title, summary: `${title}.` });

/** A time far from midnight, so every row is under one day. */
const NOW = 1764740000;
const live = () => buildFeed(LONG_CLIP_REVIEWS, LONG_CLIP_EXPORTS, NOW);

describe("buildFeed moments", () => {
  it("keeps every review item of a clip, in start order, with its own thumbnail", () => {
    const clip = live().events.find((e) => e.key === "x:living_room_cam_clip2b")!;
    expect(clip.moments).toHaveLength(9);
    expect(clip.moments.map((m) => m.id)).toEqual(clip.reviewIds);
    const starts = clip.moments.map((m) => m.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(clip.moments[0]).toMatchObject({
      id: "1764728362.709365-ev02bb",
      thumbUrl: "/clips/review/thumb-living_room_cam-1764728362.709365-ev02bb.webp",
      labels: ["person", "dog"],
    });
  });
});

describe("visitRows on a 58-minute clip of an evening", () => {
  const sessions = groupSessions(live().events);
  const visit = sessions.find((s) => s.entries.some((e) => e.key === "x:living_room_cam_clip2b"))!;
  const rows = visitRows(visit.entries, LONG_CLIP_SUMMARIES);

  it("makes each event its own row, newest first", () => {
    // 9 events in the long clip and 1 in the clip at 9:32 pm, 15 min later.
    expect(rows).toHaveLength(10);
    expect(eventCount(visit.entries)).toBe(10);
    expect(rows.map((r) => r.summary?.title)).toEqual([
      "Person stands at the counter",
      "Person walks through the room",
      "Person walks in, dog follows",
      "Person and dog rest",
      "Dog rests",
      "Dog moves to the rug",
      "Dog lies down",
      "Two people sit in the room",
      "Dog walks to the window",
      "Dog walks across the room",
    ]);
  });
  it("gives a row its own time and the clip that covers it", () => {
    const r = rows.find((x) => x.summary?.title === "Person walks through the room")!;
    expect(r.start).toBeCloseTo(1764731830.31, 2);
    expect(r.entry.key).toBe("x:living_room_cam_clip2b");
    const file = LONG_CLIP_EXPORTS.find((x) => x.id === "living_room_cam_clip2b")!.video_path;
    expect(r.entry.clipUrl).toBe(mediaUrl(file));
    expect(r.thumbUrl).toContain("ev10kk");
    expect(rowLength(r, NOW)).toBe("30 s");
  });
  it("keeps the single-event clip before it as one row", () => {
    const first = sessions.find((s) => s.entries.some((e) => e.key === "x:living_room_cam_clip3c"))!;
    expect(first.entries).toHaveLength(1);
    expect(visitRows(first.entries, LONG_CLIP_SUMMARIES)).toHaveLength(1);
  });
});

describe("visitRows", () => {
  const clip = ex("x1", "wc1;k=e;c=lr;s=850;e=2000;l=person");

  it("makes a clip that holds two events two rows", () => {
    const { events } = buildFeed([rv("a", 1000, 1010), rv("b", 1500, 1510)], [clip]);
    expect(events).toHaveLength(1);
    const rows = visitRows(events, { a: sum("A"), b: sum("B") });
    expect(rows.map((r) => r.ids)).toEqual([["b"], ["a"]]);
  });
  it(`joins an event with no summary that starts within ${JOIN_S} s of the row before`, () => {
    const { events } = buildFeed([rv("a", 1000, 1010), rv("b", 1000 + 10 + JOIN_S, 1080), rv("c", 1300, 1310)], [clip]);
    const rows = visitRows(events, { a: sum("A") });
    expect(rows.map((r) => r.ids)).toEqual([["c"], ["a", "b"]]);
    expect(rows[1]).toMatchObject({ start: 1000, end: 1080, more: 1 });
    expect(rows[1].summary?.title).toBe("A");
  });
  it("never joins an event that has a summary", () => {
    const { events } = buildFeed([rv("a", 1000, 1010), rv("b", 1020, 1030)], [clip]);
    const rows = visitRows(events, { a: sum("A"), b: sum("B") });
    expect(rows.map((r) => r.ids)).toEqual([["b"], ["a"]]);
  });
  it("does not join across two clips", () => {
    const other = ex("x2", "wc1;k=e;c=lr;s=2001;e=3000;l=person");
    const { events } = buildFeed([rv("a", 1990, 2000), rv("b", 2010, 2020)], [clip, other]);
    expect(visitRows(events, {}).map((r) => r.ids)).toEqual([["b"], ["a"]]);
  });
});

describe("filterEntries", () => {
  it("keeps only the events of the kind, so a clip shared with a person-only event shows the dog alone", () => {
    const { events } = buildFeed([rv("a", 1000, 1010, ["person"]), rv("b", 1500, 1510, ["dog"])], [ex("x1", "wc1;k=e;c=lr;s=850;e=2000;l=person,dog")]);
    const animals = filterEntries(events, "animals");
    expect(animals).toHaveLength(1);
    expect(animals[0].moments.map((m) => m.id)).toEqual(["b"]);
    expect(animals[0]).toMatchObject({ start: 1500, end: 1510, labels: ["dog"], reviewIds: ["b"] });
    expect(filterEntries(events, "sounds")).toEqual([]);
    expect(filterEntries(events, "all")).toBe(events);
  });
  it("drops the person-only clip at 9:32 pm from the animals filter in the live data", () => {
    const keys = filterEntries(live().events, "animals").map((e: EventEntry) => e.key);
    expect(keys).not.toContain("x:living_room_cam_clip1a");
    expect(keys).toContain("x:living_room_cam_clip2b");
  });
});

describe("rowLength", () => {
  const entry = { window: { start: 850, end: 2000 } } as EventEntry;
  const row = (start: number, end: number | null) => ({ start, end, entry });
  it("gives the event length when the clip holds all of it", () => {
    expect(rowLength(row(1000, 1040), 5000)).toBe("40 s");
  });
  it("does not promise more than the clip plays", () => {
    expect(rowLength(row(1900, 2500), 5000)).toBe("First 2 min of 10 min");
    expect(rowLength(row(2100, 2400), 5000)).toBe("5 min, after the clip ends");
  });
  it("runs an open event to now", () => {
    expect(rowLength({ start: 1000, end: null, entry: { window: null } as EventEntry }, 1300)).toBe("5 min");
  });
});
