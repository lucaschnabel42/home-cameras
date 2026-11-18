import { describe, expect, it } from "vitest";
import { EMPTY_PREFS, moveCamera, orderedNames, readWallPrefs, setHidden, setWallGroup, wallNames, writeWallPrefs } from "./wallPrefs";

const all = ["front_door_cam", "living_room_cam", "garage_cam"];

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe("wall order and hidden cameras", () => {
  it("keeps config order with no choice", () => {
    expect(wallNames(all, EMPTY_PREFS)).toEqual(all);
  });
  it("moves a camera up and down, and stops at the ends", () => {
    let p = moveCamera(all, EMPTY_PREFS, "garage_cam", -1);
    expect(orderedNames(all, p)).toEqual(["front_door_cam", "garage_cam", "living_room_cam"]);
    p = moveCamera(all, p, "garage_cam", -1);
    expect(orderedNames(all, p)[0]).toBe("garage_cam");
    expect(moveCamera(all, p, "garage_cam", -1)).toBe(p);
  });
  it("hides and shows a camera", () => {
    const p = setHidden(EMPTY_PREFS, "living_room_cam", true);
    expect(wallNames(all, p)).toEqual(["front_door_cam", "garage_cam"]);
    expect(wallNames(all, setHidden(p, "living_room_cam", false))).toEqual(all);
  });
  it("puts a new camera last and drops a camera that is gone", () => {
    const p = { order: ["garage_cam", "old_cam", "front_door_cam"], hidden: ["old_cam"], view: "grid" as const };
    expect(wallNames([...all, "porch_cam"], p)).toEqual(["garage_cam", "front_door_cam", "living_room_cam", "porch_cam"]);
  });
  it("survives storage with bad data and storage that throws", () => {
    const s = new MemoryStorage();
    s.setItem("cam.wall", "{not json");
    expect(readWallPrefs(s)).toEqual(EMPTY_PREFS);
    s.setItem("cam.wall", JSON.stringify({ order: ["a", 3], hidden: "b" }));
    expect(readWallPrefs(s)).toEqual({ order: ["a"], hidden: [], view: "grid" });
    s.setItem("cam.wall", JSON.stringify({ view: "spotlight" }));
    expect(readWallPrefs(s).view).toBe("spotlight");
    const p = setHidden(EMPTY_PREFS, "garage_cam", true);
    writeWallPrefs(p, s);
    expect(readWallPrefs(s)).toEqual(p);
    const broken = { setItem: () => { throw new Error("quota"); }, getItem: () => { throw new Error("denied"); } };
    expect(() => writeWallPrefs(p, broken)).not.toThrow();
    expect(readWallPrefs(broken)).toEqual(EMPTY_PREFS);
  });
});

describe("the group choice of the wall", () => {
  const groupOf = (n: string) => ({ front_door_cam: "g1", garage_cam: "g1", living_room_cam: "g2" })[n];
  it("shows the cameras of the chosen group in wall order, less the hidden ones", () => {
    const p = { ...EMPTY_PREFS, order: ["garage_cam"], group: "g1" };
    expect(wallNames(all, p, groupOf)).toEqual(["garage_cam", "front_door_cam"]);
    expect(wallNames(all, setHidden(p, "garage_cam", true), groupOf)).toEqual(["front_door_cam"]);
  });
  it("shows all cameras with no choice, and for a group that holds no camera", () => {
    expect(wallNames(all, EMPTY_PREFS, groupOf)).toEqual(all);
    expect(wallNames(all, { ...EMPTY_PREFS, group: "g9" }, groupOf)).toEqual(all);
    expect(wallNames(all, { ...EMPTY_PREFS, group: "g1" })).toEqual(all);
  });
  it("keeps the choice in storage and clears it", () => {
    const s = new MemoryStorage();
    writeWallPrefs(setWallGroup(EMPTY_PREFS, "g2"), s);
    expect(readWallPrefs(s).group).toBe("g2");
    writeWallPrefs(setWallGroup(readWallPrefs(s), null), s);
    expect(readWallPrefs(s)).toEqual(EMPTY_PREFS);
  });
});

describe("a move inside a group", () => {
  it("changes place with the next camera of the group", () => {
    const inG1 = (n: string) => n !== "living_room_cam";
    const p = moveCamera(all, EMPTY_PREFS, "garage_cam", -1, inG1);
    expect(orderedNames(all, p)).toEqual(["garage_cam", "living_room_cam", "front_door_cam"]);
    expect(moveCamera(all, p, "garage_cam", -1, inG1)).toBe(p);
  });
});
