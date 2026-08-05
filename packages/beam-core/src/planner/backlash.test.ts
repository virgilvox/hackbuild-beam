import { describe, expect, it } from "vitest";
import { applyBacklash } from "./backlash.js";

describe("directional compensation", () => {
  it("pushes each axis the way it is going", () => {
    expect(applyBacklash({ a: 100, b: 200 }, 1, -1, 8)).toEqual({ a: 108, b: 192 });
    expect(applyBacklash({ a: 100, b: 200 }, -1, 1, 8)).toEqual({ a: 92, b: 208 });
  });

  it("leaves a stationary axis alone", () => {
    /*
     * The important one. A signed offset on a still axis follows whatever numerical
     * dust is left in the velocity, so the command flutters between plus and minus a
     * whole deadband: a dither nobody asked for, at the worst possible amplitude.
     */
    expect(applyBacklash({ a: 100, b: 200 }, 0, 0, 8)).toEqual({ a: 100, b: 200 });
    expect(applyBacklash({ a: 100, b: 200 }, 1e-9, -1e-9, 8)).toEqual({ a: 100, b: 200 });
  });

  it("treats the axes separately, because they reverse at different moments", () => {
    /* A curve reverses one axis while the other is still running. Compensating them
     * together would apply the wrong sign to whichever had not turned yet. */
    expect(applyBacklash({ a: 0, b: 0 }, 5, 0, 8)).toEqual({ a: 8, b: 0 });
  });

  it("is a no-op at zero, so a machine without the problem pays nothing", () => {
    const cmd = { a: 3, b: 4 };
    expect(applyBacklash(cmd, 1, 1, 0)).toBe(cmd);
  });
});
