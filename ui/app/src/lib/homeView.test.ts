import { describe, expect, it } from "vitest";
import type { CameraInfo } from "./frigate";
import { ALL, readHomeView, resolveHomeView, writeHomeView } from "./homeView";
import type { NamesDoc } from "./names";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}
const throwing = {
  getItem(): string | null {
    throw new Error("refused");
  },
  setItem() {
    throw new Error("refused");
  },
};

const cam = (name: string): CameraInfo => ({ name, title: name, aspect: 16 / 9, liveOnly: false, cleanStream: null });
const CAMS = ["a", "b", "c"].map(cam);
const DOC: NamesDoc = { rev: 1, cameras: { a: { group: "g1" } }, groups: [{ id: "g1", name: "Outside" }, { id: "g2", name: "Empty" }] };

describe("the home view of this device", () => {
  it("reads all cameras with no stored choice", () => {
    expect(readHomeView(new MemoryStorage())).toEqual(ALL);
    expect(readHomeView(null)).toEqual(ALL);
  });
  it("writes and reads each kind", () => {
    const s = new MemoryStorage();
    writeHomeView({ kind: "groups" }, s);
    expect(readHomeView(s)).toEqual({ kind: "groups" });
    writeHomeView({ kind: "group", id: "g1" }, s);
    expect(readHomeView(s)).toEqual({ kind: "group", id: "g1" });
    writeHomeView(ALL, s);
    expect(readHomeView(s)).toEqual(ALL);
  });
  it("survives bad data and storage that throws", () => {
    const s = new MemoryStorage();
    s.setItem("cam.home", "{nope");
    expect(readHomeView(s)).toEqual(ALL);
    s.setItem("cam.home", JSON.stringify({ kind: "group", id: 4 }));
    expect(readHomeView(s)).toEqual(ALL);
    expect(readHomeView(throwing)).toEqual(ALL);
    expect(() => writeHomeView(ALL, throwing)).not.toThrow();
  });
  it("falls back to all for a group that no longer exists or holds no camera", () => {
    expect(resolveHomeView({ kind: "group", id: "g1" }, CAMS, DOC)).toEqual({ kind: "group", id: "g1" });
    expect(resolveHomeView({ kind: "group", id: "g9" }, CAMS, DOC)).toEqual(ALL);
    expect(resolveHomeView({ kind: "group", id: "g2" }, CAMS, DOC)).toEqual(ALL);
  });
  it("falls back to all when no group holds a camera", () => {
    const none: NamesDoc = { ...DOC, cameras: {} };
    expect(resolveHomeView({ kind: "groups" }, CAMS, none)).toEqual(ALL);
    expect(resolveHomeView({ kind: "groups" }, CAMS, DOC)).toEqual({ kind: "groups" });
  });
});
