import { describe, expect, it } from "vitest";

// The household's zone; the DST cases below depend on it.
process.env.TZ = "America/Chicago";
import { clockTime, clockTimeSeconds, dayPart, longDate, minutesLabel, position, shortDay, timeRange } from "./format";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime() / 1000;
const now = new Date(2026, 9, 14, 13, 0);

describe("clockTime", () => {
  it("writes a lower-case 12-hour time", () => {
    expect(clockTime(at(14, 14, 5))).toBe("2:05 pm");
    expect(clockTime(at(14, 0, 38))).toBe("12:38 am");
  });
});

describe("longDate", () => {
  it("writes the weekday and date", () => {
    expect(longDate(now)).toBe("Wednesday, October 14");
  });
});

describe("dayPart", () => {
  it("names the parts of today", () => {
    expect(dayPart(at(14, 0, 30), now)).toBe("Last night");
    expect(dayPart(at(14, 4, 59), now)).toBe("Last night");
    expect(dayPart(at(14, 5, 0), now)).toBe("This morning");
    expect(dayPart(at(14, 12, 0), now)).toBe("This afternoon");
    expect(dayPart(at(14, 17, 0), now)).toBe("This evening");
    expect(dayPart(at(14, 22, 0), now)).toBe("Tonight");
  });
  it("puts yesterday after 22:00 into last night", () => {
    expect(dayPart(at(13, 22, 30), now)).toBe("Last night");
    expect(dayPart(at(13, 21, 59), now)).toBe("Yesterday");
    expect(dayPart(at(12, 23, 0), now)).toBe("Earlier");
  });
});

describe("dayPart across a DST change", () => {
  it("still calls the day before yesterday's midnight 'Yesterday' after clocks fall back", () => {
    // Clocks fall back at 02:00 on 2026-11-01; 24 h before midnight on 11-02 is 01:00 on 11-01.
    expect(dayPart(new Date(2026, 10, 1, 0, 30).getTime() / 1000, new Date(2026, 10, 2, 13, 0))).toBe("Yesterday");
  });
});

describe("minutesLabel", () => {
  it("rounds to whole minutes with a 1 minute floor", () => {
    expect(minutesLabel(1773)).toBe("30 min");
    expect(minutesLabel(20)).toBe("1 min");
  });
});

describe("clockTimeSeconds", () => {
  it("adds seconds for the playhead", () => {
    expect(clockTimeSeconds(at(14, 0, 21) + 37)).toBe("12:21:37 am");
  });
});

describe("position", () => {
  it("writes m:ss, and h:mm:ss past an hour", () => {
    expect(position(0)).toBe("0:00");
    expect(position(65.9)).toBe("1:05");
    expect(position(1603)).toBe("26:43");
    expect(position(3725)).toBe("1:02:05");
  });
});

describe("shortDay", () => {
  it("says 'at' today and the date on other days", () => {
    expect(shortDay(at(14, 1, 5), now)).toBe("at ");
    expect(shortDay(at(13, 1, 5), now)).toBe("Tue, Oct 13, ");
  });
});

describe("timeRange", () => {
  const t = (h: number, m: number) => new Date(2026, 9, 16, h, m).getTime() / 1000;
  it("says am or pm once when both share it", () => {
    expect(timeRange(t(7, 54), t(9, 6))).toBe("7:54 to 9:06 am");
  });
  it("says both when they differ", () => {
    expect(timeRange(t(11, 11), t(13, 5))).toBe("11:11 am to 1:05 pm");
  });
  it("says now for an open end", () => {
    expect(timeRange(t(7, 54), null)).toBe("7:54 am to now");
  });
});

describe("timeRange in the repeated hour", () => {
  it("names the zones when the two clock times are equal (DST end, 2026-11-01)", () => {
    const cdt = Date.UTC(2026, 10, 1, 6, 30) / 1000; // 1:30 am CDT
    expect(timeRange(cdt, cdt + 3600)).toBe("1:30 am CDT to 1:30 am CST");
  });
});
