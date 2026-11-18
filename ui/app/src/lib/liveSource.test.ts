import { describe, expect, it } from "vitest";
import {
  CLEAN_FAIL_MS,
  CLEAN_WAIT_MS,
  shownStream,
  sourceStep,
  startSource,
  type CleanSample,
  type LiveSource,
} from "./liveSource";

const T0 = 1_000_000;

interface Tick {
  hidden?: boolean;
  clean?: CleanSample | null;
  shownMoving?: boolean;
}

/** Runs one tick a second from `from` to `to` (ms) and counts the actions. */
function run(s: LiveSource, from: number, to: number, tick: (now: number) => Tick) {
  let swaps = 0;
  let giveUps = 0;
  let fallBacks = 0;
  let swapAt = -1;
  for (let now = from; now <= to; now += 1000) {
    const t = tick(now);
    const r = sourceStep(s, {
      now,
      hidden: t.hidden ?? false,
      clean: t.clean === undefined ? null : t.clean,
      shownMoving: t.shownMoving ?? true,
    });
    s = r.source;
    if (r.swap) {
      swaps++;
      swapAt = now;
    }
    if (r.giveUp) giveUps++;
    if (r.fallBack) fallBacks++;
  }
  return { s, swaps, giveUps, fallBacks, swapAt };
}

const cleanPlays = (now: number): Tick => ({ clean: { readyState: 4, currentTime: now / 1000 } });
const cleanLoads: Tick = { clean: { readyState: 0, currentTime: 0 } };

describe("liveSource, a camera with no clean stream", () => {
  it("stays on the direct stream and does nothing", () => {
    const r = run(startSource(T0, false), T0, T0 + 60_000, () => ({ clean: null, shownMoving: false }));
    expect(shownStream(r.s)).toBe("direct");
    expect([r.swaps, r.giveUps, r.fallBacks]).toEqual([0, 0, 0]);
  });
});

describe("liveSource, the change to the clean stream", () => {
  it("starts on the direct stream", () => {
    expect(shownStream(startSource(T0, true))).toBe("direct");
  });

  it("swaps after two ticks in sequence on which the clean stream's time moved", () => {
    // The first sample with a frame gives no comparison. Its time moves on the next two.
    const r = run(startSource(T0, true), T0 + 1000, T0 + 3000, cleanPlays);
    expect(r.swaps).toBe(1);
    expect(r.swapAt).toBe(T0 + 3000);
    expect(shownStream(r.s)).toBe("clean");
  });

  it("does not swap after only one tick of movement", () => {
    const r = run(startSource(T0, true), T0 + 1000, T0 + 4000, (now) => ({
      // The time moves at T0 + 2000 and then stops.
      clean: { readyState: 4, currentTime: Math.min(now, T0 + 2000) / 1000 },
    }));
    expect(r.swaps).toBe(0);
    expect(shownStream(r.s)).toBe("direct");
  });

  it("does not count a time that moves without a frame", () => {
    const r = run(startSource(T0, true), T0 + 1000, T0 + 5000, (now) => ({ clean: { readyState: 1, currentTime: now / 1000 } }));
    expect(r.swaps).toBe(0);
  });

  it("swaps only once", () => {
    const r = run(startSource(T0, true), T0 + 1000, T0 + 60_000, cleanPlays);
    expect(r.swaps).toBe(1);
  });
});

describe("liveSource, a clean stream that does not start", () => {
  it("gives up at 20 s of visible time and stays on the direct stream", () => {
    let r = run(startSource(T0, true), T0 + 1000, T0 + CLEAN_WAIT_MS - 1000, () => cleanLoads);
    expect(r.giveUps).toBe(0);
    r = run(r.s, T0 + CLEAN_WAIT_MS, T0 + CLEAN_WAIT_MS, () => cleanLoads);
    expect(r.giveUps).toBe(1);
    expect(shownStream(r.s)).toBe("direct");
  });

  it("does not count the time with the page hidden", () => {
    // 10 s visible, 60 s hidden, then 9 s visible: 19 s of visible time.
    let r = run(startSource(T0, true), T0 + 1000, T0 + 10_000, () => cleanLoads);
    r = run(r.s, T0 + 11_000, T0 + 70_000, () => ({ hidden: true, clean: null }));
    r = run(r.s, T0 + 71_000, T0 + 80_000, () => cleanLoads);
    expect(r.giveUps).toBe(0);
    r = run(r.s, T0 + 81_000, T0 + 81_000, () => cleanLoads);
    expect(r.giveUps).toBe(1);
  });

  it("does not swap after it gave up, in the same mount", () => {
    let r = run(startSource(T0, true), T0 + 1000, T0 + 30_000, () => cleanLoads);
    expect(r.giveUps).toBe(1);
    r = run(r.s, T0 + 31_000, T0 + 90_000, cleanPlays);
    expect([r.swaps, r.giveUps, r.fallBacks]).toEqual([0, 0, 0]);
    expect(shownStream(r.s)).toBe("direct");
  });
});

describe("liveSource, a clean stream that stalls after the change", () => {
  /** A source that shows the clean stream from T0 + 3000. */
  function swapped() {
    const r = run(startSource(T0, true), T0 + 1000, T0 + 3000, cleanPlays);
    expect(r.swaps).toBe(1);
    return r.s;
  }
  const stalls = (): Tick => ({ clean: { readyState: 2, currentTime: 7 }, shownMoving: false });

  it("falls back to the direct stream after more than 20 s of stall", () => {
    let r = run(swapped(), T0 + 4000, T0 + 4000 + CLEAN_FAIL_MS, stalls);
    expect(r.fallBacks).toBe(0);
    r = run(r.s, T0 + 5000 + CLEAN_FAIL_MS, T0 + 5000 + CLEAN_FAIL_MS, stalls);
    expect(r.fallBacks).toBe(1);
    expect(shownStream(r.s)).toBe("direct");
  });

  it("starts the stall count again when the frames move", () => {
    let r = run(swapped(), T0 + 4000, T0 + 18_000, stalls);
    r = run(r.s, T0 + 19_000, T0 + 19_000, cleanPlays);
    r = run(r.s, T0 + 20_000, T0 + 35_000, stalls);
    expect(r.fallBacks).toBe(0);
    expect(shownStream(r.s)).toBe("clean");
  });

  it("does not count the time with the page hidden", () => {
    let r = run(swapped(), T0 + 4000, T0 + 14_000, stalls);
    r = run(r.s, T0 + 15_000, T0 + 300_000, () => ({ hidden: true, clean: null, shownMoving: false }));
    r = run(r.s, T0 + 301_000, T0 + 310_000, stalls);
    expect(r.fallBacks).toBe(0);
    r = run(r.s, T0 + 311_000, T0 + 312_000, stalls);
    expect(r.fallBacks).toBe(1);
  });

  it("does not swap again after a fall-back, in the same mount", () => {
    let r = run(swapped(), T0 + 4000, T0 + 30_000, stalls);
    expect(r.fallBacks).toBe(1);
    r = run(r.s, T0 + 31_000, T0 + 120_000, cleanPlays);
    expect([r.swaps, r.giveUps, r.fallBacks]).toEqual([0, 0, 0]);
    expect(shownStream(r.s)).toBe("direct");
  });
});
