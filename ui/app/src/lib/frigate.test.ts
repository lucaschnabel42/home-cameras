import { describe, expect, it } from "vitest";
import { camerasFromConfig } from "./frigate";

describe("camerasFromConfig, the clean stream", () => {
  it("gives a camera its clean stream when go2rtc has the stream <camera>_clean", () => {
    const cams = camerasFromConfig({
      cameras: { living_room_cam: { detect: { width: 1280, height: 720 } } },
      go2rtc: { streams: { living_room_cam: [], living_room_cam_clean: [] } },
    });
    expect(cams.map((c) => [c.name, c.cleanStream])).toEqual([["living_room_cam", "living_room_cam_clean"]]);
  });

  it("gives null when go2rtc has no clean stream for the camera", () => {
    const cams = camerasFromConfig({ cameras: { porch_cam: {} }, go2rtc: { streams: { porch_cam: [] } } });
    expect(cams).toEqual([{ name: "porch_cam", title: "Porch", aspect: 16 / 9, liveOnly: false, cleanStream: null }]);
  });

  it("does not list the clean stream of a Frigate camera as a live-only camera", () => {
    const cams = camerasFromConfig({
      cameras: { porch_cam: {} },
      go2rtc: { streams: { porch_cam: [], porch_cam_clean: [], doorbell: [], birdseye: [] } },
    });
    expect(cams.map((c) => c.name)).toEqual(["porch_cam", "doorbell"]);
  });

  it("never gives a live-only stream a clean stream", () => {
    const cams = camerasFromConfig({ cameras: {}, go2rtc: { streams: { doorbell: [], doorbell_clean: [] } } });
    const door = cams.find((c) => c.name === "doorbell");
    expect(door?.liveOnly).toBe(true);
    expect(door?.cleanStream).toBeNull();
  });

  it("gives no clean stream when the config has no go2rtc section", () => {
    const cams = camerasFromConfig({ cameras: { porch_cam: { enabled: true } } });
    expect(cams[0].cleanStream).toBeNull();
  });
});
