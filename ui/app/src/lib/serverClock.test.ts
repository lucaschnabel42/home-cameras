import { beforeEach, describe, expect, it } from "vitest";
import { blindSpots } from "./activity";
import { saveWindow } from "./saveWindow";
import { noteServerDate, resetServerClock, serverNow } from "./serverClock";

const REAL_MS = Date.UTC(2026, 10, 17, 14, 0, 0); // the server's time
const header = (ms: number) => new Date(ms).toUTCString();

describe("serverClock", () => {
  beforeEach(() => resetServerClock());

  it("gives the server time when the phone clock is 15 min fast", () => {
    const phone = REAL_MS + 900_000;
    noteServerDate(header(REAL_MS), phone + 80); // 80 ms on the network
    expect(Math.abs(serverNow(phone) - REAL_MS / 1000)).toBeLessThan(2);
  });

  it("gives the server time when the phone clock is 3 min slow", () => {
    const phone = REAL_MS - 180_000;
    noteServerDate(header(REAL_MS), phone + 80);
    expect(Math.abs(serverNow(phone) - REAL_MS / 1000)).toBeLessThan(2);
  });

  it("keeps the phone time when the clocks agree within a few seconds", () => {
    noteServerDate(header(REAL_MS), REAL_MS + 1300);
    expect(serverNow(REAL_MS + 1300)).toBe((REAL_MS + 1300) / 1000);
  });

  it("ignores a response from the HTTP cache, whose Date header is old", () => {
    const phone = REAL_MS + 900_000;
    noteServerDate(header(REAL_MS), phone);
    noteServerDate(header(REAL_MS - 3_600_000), phone + 10_000);
    expect(Math.abs(serverNow(phone + 10_000) - (REAL_MS + 10_000) / 1000)).toBeLessThan(2);
  });

  it("ignores a missing or broken header", () => {
    noteServerDate(null, REAL_MS);
    noteServerDate("not a date", REAL_MS);
    expect(serverNow(REAL_MS)).toBe(REAL_MS / 1000);
  });

  it("shows no false gap for a recording camera with the phone 15 min fast (finding 5)", () => {
    const phone = REAL_MS + 900_000;
    noteServerDate(header(REAL_MS), phone);
    const now = serverNow(phone);
    // Frigate reports a gap from its now up to the "before" that the app sends.
    const before = now;
    const gaps = [{ start_time: REAL_MS / 1000, end_time: before }].filter((g) => g.end_time > g.start_time);
    expect(blindSpots("living_room_cam", gaps, now - 2 * 86400, now)).toEqual([]);
  });

  it("saves the last 5 min of server time with the phone 3 min slow (finding 6)", () => {
    const phone = REAL_MS - 180_000;
    noteServerDate(header(REAL_MS), phone);
    const w = saveWindow(5, serverNow(phone));
    expect(Math.abs(w.end - (REAL_MS / 1000 - 15))).toBeLessThan(2);
  });
});
