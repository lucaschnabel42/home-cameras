import { describe, expect, it } from "vitest";
import type { ReviewItem } from "./feed";
import {
  DWELL_MS,
  HOLD_MS,
  MANUAL_MS,
  MAX_ACTIVE_S,
  activeDetections,
  followStep,
  mergeReviews,
  newestEvents,
  pickCamera,
  startFollow,
} from "./detections";

const rv = (id: string, camera: string, start: number, end: number | null, objects = ["person"]): ReviewItem => ({
  id, camera, start_time: start, end_time: end, severity: "detection", thumb_path: "", data: { objects },
});

describe("activeDetections", () => {
  it("lists the cameras with an open review item, newest first, one for each camera", () => {
    const a = activeDetections(
      [rv("a", "garage_cam", 100, null, ["car"]), rv("b", "front_door_cam", 200, null), rv("c", "garage_cam", 150, null, ["person"]), rv("d", "yard_cam", 300, 310)],
      400,
    );
    expect(a.map((x) => [x.camera, x.id])).toEqual([["front_door_cam", "b"], ["garage_cam", "c"]]);
    expect(a[1].labels).toEqual(["person"]);
  });
  it("ignores an item that has been open too long", () => {
    expect(activeDetections([rv("a", "garage_cam", 0, null)], MAX_ACTIVE_S + 1)).toEqual([]);
  });
});

describe("mergeReviews and newestEvents", () => {
  it("lets the fresh copy of an item win", () => {
    const m = mergeReviews([rv("a", "x", 1, null), rv("b", "x", 2, 3)], [rv("a", "x", 1, 5)]);
    expect(m.find((r) => r.id === "a")?.end_time).toBe(5);
    expect(m).toHaveLength(2);
  });
  it("gives the newest items first", () => {
    expect(newestEvents([rv("a", "x", 1, 2), rv("b", "x", 3, 4), rv("c", "x", 2, 3)], 2).map((r) => r.id)).toEqual(["b", "c"]);
  });
});

describe("followStep", () => {
  const act = (camera: string, start: number) => ({ id: camera + start, camera, start, labels: ["person"] });

  it("moves the spotlight to the camera with a new detection", () => {
    const f = followStep(startFollow("living_room_cam"), [act("garage_cam", 10)], 1000);
    expect(f.camera).toBe("garage_cam");
  });
  it("stays while the detection lasts and for a short time after it ends", () => {
    let f = followStep(startFollow(null), [act("garage_cam", 10)], 1000);
    f = followStep(f, [act("garage_cam", 10), act("yard_cam", 5)], 2000);
    expect(f.camera).toBe("garage_cam");
    // The garage detection ends; the older yard detection is still open.
    f = followStep(f, [act("yard_cam", 5)], 2000 + HOLD_MS - 1);
    expect(f.camera).toBe("garage_cam");
    f = followStep(f, [act("yard_cam", 5)], 2000 + HOLD_MS + 1);
    expect(f.camera).toBe("yard_cam");
  });
  it("stays on the camera when nothing is active", () => {
    const f = followStep(startFollow("garage_cam"), [], 99_000);
    expect(f.camera).toBe("garage_cam");
  });
  it("takes a newer detection elsewhere only after the dwell time", () => {
    let f = followStep(startFollow(null), [act("garage_cam", 10)], 1000);
    f = followStep(f, [act("yard_cam", 20), act("garage_cam", 10)], 1000 + DWELL_MS - 1);
    expect(f.camera).toBe("garage_cam");
    f = followStep(f, [act("yard_cam", 20), act("garage_cam", 10)], 1000 + DWELL_MS);
    expect(f.camera).toBe("yard_cam");
  });
  it("keeps a camera that the person picked, for a time", () => {
    let f = pickCamera("living_room_cam", 1000);
    f = followStep(f, [act("garage_cam", 10)], 1000 + MANUAL_MS - 1);
    expect(f.camera).toBe("living_room_cam");
    f = followStep(f, [act("garage_cam", 10)], 1000 + MANUAL_MS);
    expect(f.camera).toBe("garage_cam");
  });
});
