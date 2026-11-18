import { describe, expect, it } from "vitest";
import { liveReportUrl, shouldReportVideoError } from "./liveReport";

describe("liveReportUrl", () => {
  it("uses /api/review with a future after, which Frigate's nginx logs and answers with []", () => {
    expect(liveReportUrl("stall", "direct", { rs: 2, paused: 0 })).toBe(
      "/api/review?after=9999999999&live_stall=1&s=direct&rs=2&paused=0",
    );
  });
  it("keeps the field names of a restart", () => {
    expect(liveReportUrl("restart", "clean", { rs: 0 })).toBe("/api/review?after=9999999999&live_restart=1&s=clean&rs=0");
  });
  it("puts the error code in live_error and encodes the text", () => {
    expect(liveReportUrl("error", "direct", { code: 3, text: "bad frame & more" })).toBe(
      "/api/review?after=9999999999&live_error=3&s=direct&text=bad%20frame%20%26%20more",
    );
  });
  it("names the clean stream in an error of the clean stream", () => {
    expect(liveReportUrl("error", "clean", { code: 3 })).toBe("/api/review?after=9999999999&live_error=3&s=clean");
  });
  it("puts the time since the mount in live_swap", () => {
    expect(liveReportUrl("swap", "clean", { ms: 3412 })).toBe("/api/review?after=9999999999&live_swap=3412&s=clean");
  });
  it("puts the result in live_clean for a give-up and for a fall-back", () => {
    expect(liveReportUrl("clean", "clean", { result: "gave_up" })).toBe(
      "/api/review?after=9999999999&live_clean=gave_up&s=clean",
    );
    expect(liveReportUrl("clean", "clean", { result: "fell_back", rs: 2 })).toBe(
      "/api/review?after=9999999999&live_clean=fell_back&s=clean&rs=2",
    );
  });
});

describe("shouldReportVideoError", () => {
  it("skips the error that video.src = '' fires while the stream closes", () => {
    expect(shouldReportVideoError({ code: 4, socketClosed: true, hasSource: false })).toBe(false);
  });
  it("skips it after restart(), when the new socket is already connecting", () => {
    expect(shouldReportVideoError({ code: 4, socketClosed: false, hasSource: false })).toBe(false);
  });
  it("reports an error of a stream that has a source and an open socket", () => {
    expect(shouldReportVideoError({ code: 2, socketClosed: false, hasSource: true })).toBe(true);
  });
  it("always reports a decode error", () => {
    expect(shouldReportVideoError({ code: 3, socketClosed: true, hasSource: false })).toBe(true);
  });
});
