import { describe, expect, it } from "vitest";
import { usesCleanStream } from "./streamChoice";

describe("usesCleanStream", () => {
  it("always uses the clean stream in the single camera view", () => {
    expect(usesCleanStream({ kind: "camera-view" })).toBe(true);
  });
  it("uses the clean stream on a home screen with at most 2 live tiles", () => {
    expect(usesCleanStream({ kind: "home", liveTiles: 1 })).toBe(true);
    expect(usesCleanStream({ kind: "home", liveTiles: 2 })).toBe(true);
  });
  it("uses the direct stream on a home screen with 3 or more live tiles", () => {
    expect(usesCleanStream({ kind: "home", liveTiles: 3 })).toBe(false);
    expect(usesCleanStream({ kind: "home", liveTiles: 9 })).toBe(false);
  });
  it("uses the clean stream on a wall of at most 2 cameras, in the grid and in the spotlight", () => {
    expect(usesCleanStream({ kind: "wall", wallCameras: 1 })).toBe(true);
    expect(usesCleanStream({ kind: "wall", wallCameras: 2 })).toBe(true);
  });
  it("uses the direct stream on a wall of 3 or more cameras", () => {
    expect(usesCleanStream({ kind: "wall", wallCameras: 3 })).toBe(false);
    expect(usesCleanStream({ kind: "wall", wallCameras: 9 })).toBe(false);
  });
});
