import { describe, expect, it } from "vitest";
import { arrowStep, escapeStack, keyBelongsToControl } from "./keys";

describe("escapeStack", () => {
  it("closes the top layer only", () => {
    const s = escapeStack();
    const closed: string[] = [];
    s.push(() => closed.push("camera"));
    const pop = s.push(() => closed.push("search"));
    expect(s.escape()).toBe(true);
    expect(closed).toEqual(["search"]);
    pop();
    s.escape();
    expect(closed).toEqual(["search", "camera"]);
  });
  it("says so when no layer is open", () => {
    expect(escapeStack().escape()).toBe(false);
  });
  it("removes the right handler when an inner layer closes first", () => {
    const s = escapeStack();
    const seen: string[] = [];
    const popA = s.push(() => seen.push("a"));
    s.push(() => seen.push("b"));
    popA();
    s.escape();
    expect(seen).toEqual(["b"]);
    expect(s.size).toBe(1);
  });
});

describe("arrowStep", () => {
  it("steps left and right and wraps around", () => {
    expect(arrowStep("ArrowRight", 0, 3)).toBe(1);
    expect(arrowStep("ArrowRight", 2, 3)).toBe(0);
    expect(arrowStep("ArrowLeft", 0, 3)).toBe(2);
  });
  it("steps one row up and down in a grid and stops at the edge", () => {
    expect(arrowStep("ArrowDown", 1, 9, 3)).toBe(4);
    expect(arrowStep("ArrowDown", 7, 9, 3)).toBe(7);
    expect(arrowStep("ArrowUp", 4, 9, 3)).toBe(1);
    expect(arrowStep("ArrowUp", 1, 9, 3)).toBe(1);
  });
  it("ignores other keys and an empty list", () => {
    expect(arrowStep("Enter", 0, 3)).toBeNull();
    expect(arrowStep("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("keyBelongsToControl", () => {
  const el = (match: boolean) => ({ closest: () => (match ? {} : null) });
  it("is true inside a text field or a control that reads arrows", () => {
    expect(keyBelongsToControl(el(true) as unknown as EventTarget)).toBe(true);
    expect(keyBelongsToControl(el(false) as unknown as EventTarget)).toBe(false);
    expect(keyBelongsToControl(null)).toBe(false);
  });
});
