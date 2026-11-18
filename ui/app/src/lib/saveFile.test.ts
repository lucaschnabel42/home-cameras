import { describe, expect, it } from "vitest";
import { clipFileName, stillFileName } from "./saveFile";

describe("file names", () => {
  it("names a still after the camera and the local time, to the second", () => {
    expect(stillFileName("garage_cam", new Date(2026, 0, 5, 7, 3, 9))).toBe("garage_cam-20260105-070309.jpg");
    expect(stillFileName("garage_cam", new Date(2026, 10, 18, 23, 59, 0), "webp")).toBe("garage_cam-20261118-235900.webp");
  });
  it("names a clip after the camera and its start, to the minute", () => {
    const start = new Date(2026, 10, 18, 7, 13, 44).getTime() / 1000;
    expect(clipFileName("living_room_cam", start)).toBe("living_room_cam-20261118-0713.mp4");
  });
});
