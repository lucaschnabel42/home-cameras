import { describe, expect, it } from "vitest";
import { SHARE_LIMIT_BYTES, shareMode } from "./shareMode";

describe("shareMode", () => {
  it("offers a plain link for the 940 MB clip seen live (6,380 s)", () => {
    expect(shareMode(940_896_753, 6380)).toBe("link");
  });
  it("shares a clip at or below the limit", () => {
    expect(shareMode(30_000_000, 200)).toBe("share");
    expect(shareMode(SHARE_LIMIT_BYTES, 1000)).toBe("share");
  });
  it("offers a link just above the limit", () => {
    expect(shareMode(SHARE_LIMIT_BYTES + 1, 1000)).toBe("link");
  });
  it("estimates from the clip length when the size is not known", () => {
    expect(shareMode(null, 6380)).toBe("link");
    expect(shareMode(null, 300)).toBe("share");
  });
  it("shares when neither the size nor the length is known", () => {
    expect(shareMode(null, 0)).toBe("share");
  });
});
