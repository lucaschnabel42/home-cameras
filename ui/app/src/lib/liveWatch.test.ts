import { describe, expect, it } from "vitest";
import { FROZEN_MS, liveStep, showsStill, startWatch, watchNewElement, type LiveSample, type LiveWatch } from "./liveWatch";

const T0 = 1_000_000;

/** Runs one tick a second from `from` to `to` (ms) and collects the log lines. */
function run(w: LiveWatch, from: number, to: number, sample: (now: number) => Omit<LiveSample, "now">) {
  let stalls = 0;
  let restarts = 0;
  for (let now = from; now <= to; now += 1000) {
    const r = liveStep(w, { now, ...sample(now) });
    w = r.watch;
    if (r.reportStall) stalls++;
    if (r.restart) restarts++;
  }
  return { w, stalls, restarts };
}

const playing = (now: number) => ({ hidden: false, readyState: 4, currentTime: now / 1000 });

describe("liveWatch, the picture during a stall", () => {
  it("keeps the last frame, not the still from when the tile opened, in a stall after an hour of play", () => {
    let { w } = run(startWatch(T0), T0, T0 + 3_600_000, playing);
    const frozenAt = w.last;
    ({ w } = run(w, T0 + 3_601_000, T0 + 3_606_000, () => ({ hidden: false, readyState: 2, currentTime: frozenAt })));
    expect(w.status).toBe("reconnecting");
    expect(w.showStatus).toBe(true);
    expect(showsStill(w)).toBe(false);
  });

  it("shows a still taken now, not at open, when a forced restart blanks the video", () => {
    let { w } = run(startWatch(T0), T0, T0 + 3_600_000, playing);
    const frozenAt = w.last;
    let r = run(w, T0 + 3_601_000, T0 + 3_601_000 + FROZEN_MS + 1000, () => ({
      hidden: false,
      readyState: 2,
      currentTime: frozenAt,
    }));
    expect(r.restarts).toBe(1);
    expect(showsStill(r.w)).toBe(false);
    // ondisconnect() sets video.src = "", so readyState drops to 0.
    const blankAt = T0 + 3_601_000 + FROZEN_MS + 2000;
    r = run(r.w, blankAt, blankAt, () => ({ hidden: false, readyState: 0, currentTime: 0 }));
    expect(showsStill(r.w)).toBe(true);
    expect(r.w.stillAt).toBe(blankAt);
  });

  it("shows the still from open before the first frame", () => {
    const { w } = run(startWatch(T0), T0, T0 + 5000, () => ({ hidden: false, readyState: 0, currentTime: 0 }));
    expect(showsStill(w)).toBe(true);
    expect(w.stillAt).toBe(T0);
    expect(w.status).toBe("connecting");
  });
});

describe("liveWatch, a return from the background", () => {
  it("does not count the hidden time as a stall and writes no live_stall line", () => {
    // Plays, then freezes for 1 s just before the page is hidden.
    let { w } = run(startWatch(T0), T0, T0 + 60_000, playing);
    const frozenAt = w.last;
    ({ w } = run(w, T0 + 61_000, T0 + 61_000, () => ({ hidden: false, readyState: 2, currentTime: frozenAt })));
    // Hidden for 60 s.
    let r = run(w, T0 + 62_000, T0 + 122_000, () => ({ hidden: true, readyState: 0, currentTime: 0 }));
    // Visible again; the stream needs 2 s to reconnect, then plays.
    r = run(r.w, T0 + 123_000, T0 + 124_000, () => ({ hidden: false, readyState: 0, currentTime: 0 }));
    expect(r.stalls).toBe(0);
    expect(r.restarts).toBe(0);
    expect(r.w.showStatus).toBe(false);
    r = run(r.w, T0 + 125_000, T0 + 130_000, playing);
    expect(r.stalls).toBe(0);
    expect(r.w.status).toBe("playing");
  });

  it("still reports a stall that starts after the return", () => {
    let { w } = run(startWatch(T0), T0, T0 + 10_000, playing);
    ({ w } = run(w, T0 + 11_000, T0 + 40_000, () => ({ hidden: true, readyState: 4, currentTime: 0 })));
    const r = run(w, T0 + 41_000, T0 + 46_000, () => ({ hidden: false, readyState: 2, currentTime: 7 }));
    expect(r.stalls).toBe(1);
    expect(r.w.status).toBe("reconnecting");
  });
});

describe("liveWatch, a change of the shown element", () => {
  it("starts the stall clock again for a new direct element after the clean stream stalled", () => {
    // Plays, then stalls for 21 s, with one forced restart at 11 s.
    let { w } = run(startWatch(T0), T0, T0 + 60_000, playing);
    const frozenAt = w.last;
    let r = run(w, T0 + 61_000, T0 + 82_000, () => ({ hidden: false, readyState: 2, currentTime: frozenAt }));
    expect(r.restarts).toBe(1);
    // The tile falls back: the new direct element has no frame yet.
    w = watchNewElement(r.w, T0 + 82_000, false);
    expect(showsStill(w)).toBe(true);
    expect(w.stillAt).toBe(T0 + 82_000);
    // The new element needs 5 s to connect: no restart, and no second live_stall line for the same stall.
    r = run(w, T0 + 83_000, T0 + 88_000, () => ({ hidden: false, readyState: 0, currentTime: 0 }));
    expect(r.restarts).toBe(0);
    expect(r.stalls).toBe(0);
    r = run(r.w, T0 + 89_000, T0 + 92_000, playing);
    expect(r.w.status).toBe("playing");
  });

  it("keeps the picture when the new element already holds a frame", () => {
    const { w } = run(startWatch(T0), T0, T0 + 5000, playing);
    const n = watchNewElement(w, T0 + 5000, true);
    expect(showsStill(n)).toBe(false);
    expect(n.stillAt).toBe(w.stillAt);
  });
});
