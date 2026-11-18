import { describe, expect, it } from "vitest";
import type { CameraInfo } from "./frigate";
import {
  EMPTY_NAMES,
  addGroup,
  applyNames,
  cleanName,
  groupSections,
  isNewer,
  moveGroup,
  nameProblem,
  newGroupId,
  parseNames,
  removeGroup,
  renameCamera,
  renameGroup,
  setGroup,
  titleOf,
  type NamesDoc,
} from "./names";

const DOC: NamesDoc = {
  rev: 1,
  cameras: { front_yard: { name: "Front Door", group: "g1" }, kitchen_cam: { group: "g2" }, porch: { name: "Emma's room" } },
  groups: [
    { id: "g1", name: "Outside" },
    { id: "g2", name: "Inside" },
  ],
};

const cam = (name: string): CameraInfo => ({ name, title: name, aspect: 16 / 9, liveOnly: false, cleanStream: null });

describe("isNewer", () => {
  it("takes the first document and a higher revision only", () => {
    expect(isNewer(null, EMPTY_NAMES)).toBe(true);
    expect(isNewer(DOC, { ...DOC, rev: 2 })).toBe(true);
    // An answer from before a save arrives late: it does not replace the saved document.
    expect(isNewer({ ...DOC, rev: 4 }, { ...DOC, rev: 3 })).toBe(false);
    expect(isNewer(DOC, DOC)).toBe(false);
  });
});

describe("parseNames", () => {
  it("reads a good document", () => {
    expect(parseNames(JSON.parse(JSON.stringify(DOC)))).toEqual(DOC);
  });
  it("gives the empty document for input that is not an object", () => {
    expect(parseNames(null)).toEqual(EMPTY_NAMES);
    expect(parseNames("x")).toEqual(EMPTY_NAMES);
    expect(parseNames([1])).toEqual(EMPTY_NAMES);
  });
  it("gives each field of the wrong type its default", () => {
    expect(parseNames({ rev: "3", cameras: [], groups: {} })).toEqual(EMPTY_NAMES);
    expect(parseNames({ rev: -1 }).rev).toBe(0);
    expect(parseNames({ rev: 2.5 }).rev).toBe(0);
  });
  it("drops bad entries and a reference to a group that does not exist", () => {
    const doc = parseNames({
      rev: 4,
      cameras: { a: { name: 7, group: "g9" }, b: "x", c: { name: "Den", group: 3 }, d: { group: "g1" } },
      groups: [{ id: "g1", name: "Up" }, { id: 2, name: "Bad" }, "no", { id: "g3" }],
    });
    expect(doc).toEqual({ rev: 4, cameras: { c: { name: "Den" }, d: { group: "g1" } }, groups: [{ id: "g1", name: "Up" }] });
  });
});

describe("titles", () => {
  it("uses the name of the user, else the derived name", () => {
    expect(titleOf(DOC, "front_yard")).toBe("Front Door");
    expect(titleOf(DOC, "kitchen_cam")).toBe("Kitchen");
    expect(titleOf(DOC, "garage_cam")).toBe("Garage");
  });
  it("gives the camera list the titles and keeps the keys", () => {
    const out = applyNames([cam("front_yard"), cam("kitchen_cam")], DOC);
    expect(out.map((c) => [c.name, c.title])).toEqual([
      ["front_yard", "Front Door"],
      ["kitchen_cam", "Kitchen"],
    ]);
  });
});

describe("groupSections", () => {
  it("lists the groups in order, then the other cameras last", () => {
    const cams = ["porch", "kitchen_cam", "front_yard", "garage"].map(cam);
    const s = groupSections(cams, DOC);
    expect(s.map((x) => [x.id, x.name, x.cameras.map((c) => c.name)])).toEqual([
      ["g1", "Outside", ["front_yard"]],
      ["g2", "Inside", ["kitchen_cam"]],
      [null, "Other cameras", ["porch", "garage"]],
    ]);
  });
  it("leaves out a group with no camera, and the other section when it is empty", () => {
    const s = groupSections([cam("kitchen_cam")], DOC);
    expect(s.map((x) => x.id)).toEqual(["g2"]);
  });
});

describe("the name rule", () => {
  it("trims and collapses white space", () => {
    expect(cleanName("  Front \t  door \n")).toBe("Front door");
  });
  it.each(["Living room", "Front porch", "Front Door", "TV room", "Emma's room", "Emma’s room", "The den", "Garage 2", "Cats & dogs", "St. Clair", "Up-stairs", "Café", "2nd floor", "x".repeat(32)])(
    "accepts %j",
    (name) => {
      expect(nameProblem(name)).toBeNull();
    },
  );
  it.each(['Say "hi"', "Two\nlines", "{room}", "<b>", "-dash", " ", "x".repeat(33), "Room!", "Room/2", "'quoted'", "Cam²", "Ⅷ room"])("refuses %j", (name) => {
    expect(nameProblem(name)).not.toBeNull();
  });
  it("allows an empty camera name (no name) but not an empty group name", () => {
    expect(nameProblem("", { empty: true })).toBeNull();
    expect(nameProblem("")).not.toBeNull();
  });
  it("counts characters, not code units", () => {
    expect(nameProblem("é".repeat(32))).toBeNull();
  });
});

describe("edits", () => {
  it("renames a camera and removes the name with an empty text", () => {
    let d = renameCamera(DOC, "garage", "  Big   shed ");
    expect(d.cameras.garage).toEqual({ name: "Big shed" });
    d = renameCamera(d, "garage", "");
    expect(d.cameras.garage).toBeUndefined();
    d = renameCamera(d, "front_yard", "");
    expect(d.cameras.front_yard).toEqual({ group: "g1" });
    expect(DOC.cameras.front_yard.name).toBe("Front Door");
  });
  it("puts a camera in a group and takes it out", () => {
    let d = setGroup(DOC, "porch", "g2");
    expect(d.cameras.porch).toEqual({ name: "Emma's room", group: "g2" });
    d = setGroup(d, "kitchen_cam", null);
    expect(d.cameras.kitchen_cam).toBeUndefined();
    expect(setGroup(DOC, "porch", "nope")).toBe(DOC);
  });
  it("adds a group with a new valid id and a name that is free", () => {
    const { doc, id } = addGroup(DOC);
    expect(id).toMatch(/^[a-z0-9]{1,12}$/);
    expect(DOC.groups.some((g) => g.id === id)).toBe(false);
    expect(doc.groups.at(-1)).toEqual({ id, name: "Group 1" });
    expect(addGroup(doc).doc.groups.at(-1)!.name).toBe("Group 2");
  });
  it("makes an id that is new in the document", () => {
    const doc = { ...DOC, groups: [{ id: "g1", name: "A" }, { id: "g2", name: "B" }, { id: "g3", name: "C" }] };
    expect(newGroupId(doc)).toBe("g4");
    expect(newGroupId(EMPTY_NAMES)).toBe("g1");
  });
  it("renames a group", () => {
    expect(renameGroup(DOC, "g2", " Indoors ").groups[1]).toEqual({ id: "g2", name: "Indoors" });
  });
  it("refuses a group name that another group has, with letter case ignored", () => {
    expect(nameProblem("outside", { taken: ["Outside", "Inside"] })).not.toBeNull();
  });
  it("moves a group up and down, and stops at the ends", () => {
    expect(moveGroup(DOC, "g2", -1).groups.map((g) => g.id)).toEqual(["g2", "g1"]);
    expect(moveGroup(DOC, "g1", 1).groups.map((g) => g.id)).toEqual(["g2", "g1"]);
    expect(moveGroup(DOC, "g1", -1)).toBe(DOC);
    expect(moveGroup(DOC, "g2", 1)).toBe(DOC);
  });
  it("removes a group and leaves no reference to it", () => {
    const d = removeGroup(DOC, "g1");
    expect(d.groups).toEqual([{ id: "g2", name: "Inside" }]);
    expect(d.cameras.front_yard).toEqual({ name: "Front Door" });
    expect(JSON.stringify(d)).not.toContain('"g1"');
    const e = removeGroup(DOC, "g2");
    expect(e.cameras.kitchen_cam).toBeUndefined();
  });
});
