import { describe, expect, it } from "vitest";
import { FEED_S, listEndLine, recordDays } from "./listEnd";

describe("recordDays", () => {
  it("reads record.continuous.days of the recorded cameras", () => {
    const cfg = {
      record: { continuous: { days: 7 } },
      cameras: {
        living_room_cam: { enabled: true, record: { continuous: { days: 7 } } },
        front_porch_cam: { enabled: true, record: { continuous: { days: 7 } } },
      },
    };
    expect(recordDays(cfg)).toBe(7);
  });
  it("gives the shortest camera, because the line must be true for every camera", () => {
    const cfg = {
      cameras: {
        a: { record: { continuous: { days: 7 } } },
        b: { record: { continuous: { days: 3 } } },
        off: { enabled: false, record: { continuous: { days: 1 } } },
      },
    };
    expect(recordDays(cfg)).toBe(3);
  });
  it("falls back to the global value, and is null when nothing says", () => {
    expect(recordDays({ record: { continuous: { days: 5 } }, cameras: { a: {} } })).toBe(5);
    expect(recordDays({ cameras: {} })).toBeNull();
    expect(recordDays({ cameras: { a: { record: { continuous: { days: 0 } } } } })).toBeNull();
  });
});

describe("listEndLine", () => {
  it("uses the feed window and the recording days", () => {
    expect(listEndLine(FEED_S, 7)).toBe("This list shows the last 2 days. Recordings go back 7 days.");
  });
  it("follows the numbers, not fixed text", () => {
    expect(listEndLine(3 * 86_400, 10)).toBe("This list shows the last 3 days. Recordings go back 10 days.");
    expect(listEndLine(86_400, 1.5)).toBe("This list shows the last day. Recordings go back 1.5 days.");
  });
  it("drops the second sentence when the retention is unknown or not longer", () => {
    expect(listEndLine(FEED_S, null)).toBe("This list shows the last 2 days.");
    expect(listEndLine(FEED_S, 2)).toBe("This list shows the last 2 days.");
  });
  it("keeps FEED_S at two days", () => {
    expect(FEED_S).toBe(2 * 86_400);
  });
});
