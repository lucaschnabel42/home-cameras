import { describe, expect, it } from "vitest";
import { buildFeed, mediaUrl, type ExportItem, type ReviewItem } from "./feed";

const rv = (id: string, cam: string, start: number, end: number | null, objects = ["person"]): ReviewItem => ({
  id, camera: cam, start_time: start, end_time: end, severity: "alert",
  thumb_path: `/media/frigate/clips/review/thumb-${cam}-${id}.webp`, data: { objects },
});
const ex = (id: string, cam: string, name: string, inProgress = false, date = 5000): ExportItem => ({
  id, camera: cam, name, date, in_progress: inProgress,
  video_path: `/media/frigate/exports/${cam}_${id}.mp4`, thumb_path: `/media/frigate/exports/${cam}_${id}.webp`,
});

describe("mediaUrl", () => {
  it("maps Frigate file paths to served URLs", () => {
    expect(mediaUrl("/media/frigate/exports/a.mp4")).toBe("/exports/a.mp4");
    expect(mediaUrl("/media/frigate/clips/review/t.webp")).toBe("/clips/review/t.webp");
  });
});

describe("buildFeed", () => {
  it("marks an active event as recording with no clip", () => {
    const { events } = buildFeed([rv("a", "lr", 1000, null)], []);
    expect(events[0]).toMatchObject({ state: "recording", clipUrl: null, window: null });
  });
  it("plays the padded window from recordings at once, before the export exists", () => {
    const { events } = buildFeed([rv("a", "lr", 1000, 1020)], [], 2000);
    expect(events[0]).toMatchObject({
      state: "waiting",
      clipUrl: "/vod/lr/start/850/end/1170/index.m3u8",
      window: { start: 850, end: 1170 },
      shareUrl: "/api/review/a/clip.mp4?padding=150",
      clipSeconds: null,
    });
  });
  it("cuts the window at now while the post-event padding is still being recorded", () => {
    const { events } = buildFeed([rv("a", "lr", 1000, 1020)], [], 1100.7);
    expect(events[0]).toMatchObject({ clipUrl: "/vod/lr/start/850/end/1100/index.m3u8", window: { start: 850, end: 1100 } });
  });
  it("joins overlapping events to one export", () => {
    const e = ex("x1", "lr", "wc1;k=e;c=lr;s=850;e=1360;l=car,person");
    const { events } = buildFeed([rv("b", "lr", 1200, 1210, ["car"]), rv("a", "lr", 1000, 1020)], [e]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      state: "ready", clipUrl: "/exports/lr_x1.mp4", start: 1000, end: 1210, reviewIds: ["a", "b"],
      clipSeconds: 510, window: { start: 850, end: 1360 }, shareUrl: "/exports/lr_x1.mp4",
    });
    expect([...events[0].labels].sort()).toEqual(["car", "person"]);
  });
  it("labels a clip with its real length when the exporter has measured it", () => {
    const e = ex("x1", "lr", "wc1;k=e;c=lr;s=850;e=2623;l=person;d=1603");
    expect(buildFeed([rv("a", "lr", 1000, 1020)], [e], 9999).events[0].clipSeconds).toBe(1603);
  });
  it("shows an export in progress as exporting", () => {
    const e = ex("x1", "lr", "wc1;k=e;c=lr;s=850;e=1170;l=person", true);
    expect(buildFeed([rv("a", "lr", 1000, 1020)], [e]).events[0].state).toBe("exporting");
  });
  it("never joins across cameras", () => {
    const e = ex("x1", "porch", "wc1;k=e;c=porch;s=850;e=1170;l=person");
    expect(buildFeed([rv("a", "lr", 1000, 1020)], [e]).events[0].state).toBe("waiting");
  });
  it("lists saved and untagged exports, newest first, and keeps them out of events", () => {
    const saved = ex("s1", "lr", "wc1;k=s;c=lr;s=2000;e=2900;l=", false, 3000);
    const other = ex("u1", "lr", "My clip", false, 4000);
    const { events, saved: list } = buildFeed([], [saved, other]);
    expect(events).toHaveLength(0);
    expect(list.map((s) => s.key)).toEqual(["u1", "s1"]);
    expect(list[1]).toMatchObject({ minutes: 15, start: 2000, end: 2900, window: { start: 2000, end: 2900 } });
    expect(list[0]).toMatchObject({ minutes: null, title: "My clip", window: null });
  });
  it("sorts events newest first", () => {
    const { events } = buildFeed([rv("a", "lr", 1000, 1020), rv("b", "lr", 9000, 9020)], []);
    expect(events.map((e) => e.key)).toEqual(["r:b", "r:a"]);
  });
});
