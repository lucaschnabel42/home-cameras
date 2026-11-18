import { describe, expect, it } from "vitest";
import { formatClipName, parseClipName } from "./clipName";

describe("clipName", () => {
  it("parses what the exporter writes", () => {
    expect(parseClipName("wc1;k=e;c=living_room_cam;s=1000;e=1301;l=car,person")).toEqual({
      kind: "event", camera: "living_room_cam", start: 1000, end: 1301, labels: ["car", "person"],
    });
  });
  it("reads the real length the exporter adds", () => {
    expect(parseClipName("wc1;k=e;c=cam;s=1000;e=2773;l=person;d=1603")).toMatchObject({ start: 1000, end: 2773, duration: 1603 });
    expect(parseClipName("wc1;k=e;c=cam;s=1000;e=2773;l=person")?.duration).toBeUndefined();
  });
  it("round-trips a saved clip", () => {
    const tag = { kind: "saved" as const, camera: "front_porch_cam", start: 2000, end: 2900, labels: [] };
    expect(parseClipName(formatClipName(tag))).toEqual(tag);
  });
  it("rejects names it did not write", () => {
    for (const bad of [
      "living_room_cam 2026-10-14 person",
      "wc1;k=x;c=a;s=1;e=2;l=",
      "wc1;k=e;c=;s=1;e=2;l=",
      "wc1;k=e;c=a;s=;e=2;l=",
      "wc1;k=e;c=a;s=5;e=2;l=",
      "wc1;k=e;c=a;s=2;e=2;l=",
      "wc2;k=e;c=a;s=1;e=2;l=",
    ]) expect(parseClipName(bad), bad).toBeNull();
  });
  it("keeps saved names under the 100-character column", () => {
    const n = formatClipName({ kind: "saved", camera: "c".repeat(20), start: 1791956307, end: 1791958107, labels: [] });
    expect(n.length).toBeLessThanOrEqual(100);
  });
});
