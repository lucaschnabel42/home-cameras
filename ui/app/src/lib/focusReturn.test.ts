import { describe, expect, it } from "vitest";
import { dialogProps, focusReturn } from "./focusReturn";

/** A stand-in for an element: it counts focus calls and can leave the page. */
const el = (connected = true) => {
  const e = { isConnected: connected, calls: 0, focus: () => void e.calls++ };
  return e;
};

describe("focusReturn", () => {
  it("gives focus back to the opener when the overlay closes", () => {
    const opener = el();
    const r = focusReturn();
    r.remember(opener);
    r.restore();
    expect(opener.calls).toBe(1);
  });
  it("keeps the first opener when one overlay replaces another", () => {
    // Home tile -> camera view -> clip player -> close: focus goes to the tile.
    const tile = el();
    const playButton = el();
    const r = focusReturn();
    r.remember(tile);
    r.remember(playButton);
    r.restore();
    expect(tile.calls).toBe(1);
    expect(playButton.calls).toBe(0);
  });
  it("forgets the opener after a restore", () => {
    const a = el();
    const b = el();
    const r = focusReturn();
    r.remember(a);
    r.restore();
    r.remember(b);
    r.restore();
    expect([a.calls, b.calls]).toEqual([1, 1]);
  });
  it("does nothing for an opener that left the page, or for no opener", () => {
    const gone = el(false);
    const r = focusReturn();
    r.restore();
    r.remember(gone);
    r.restore();
    expect(gone.calls).toBe(0);
    r.remember(null);
    expect(() => r.restore()).not.toThrow();
  });
});

describe("dialogProps", () => {
  it("makes a modal dialog named by its title", () => {
    expect(dialogProps("t1")).toEqual({ role: "dialog", "aria-modal": true, "aria-labelledby": "t1" });
  });
});
