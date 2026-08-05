import { describe, expect, it } from "vitest";
import {
  HUNT_RAMP_START_RATE,
  HUNT_RATES,
  HUNT_SPAN_STEPS,
  PATTERN_FIELD_FRACTION,
  RATE_RAMP_LINES,
  RULER_MARKS,
  huntPass,
  lashGauge,
  rateRamp,
  ruler,
  squareWithDiagonals,
  stallHunt,
} from "./patterns.js";

const FIELD = { widthMm: 300, heightMm: 300 };
const TICK_HZ = 20000;

describe("lashGauge", () => {
  const res = lashGauge(FIELD);

  it("draws the same line in both directions", () => {
    const a = res.strokes[0]!;
    const b = res.strokes[1]!;
    expect(a[0]!.x).toBeLessThan(a[1]!.x);
    expect(b[0]!.x).toBeGreaterThan(b[1]!.x);
  });

  it("draws an overlapping pair whose gap is the slack you measure", () => {
    /* The lower pair sits on one y, traced out and back. Everything you can see
     * between those two lines on the target is mechanical, not commanded. */
    const c = res.strokes[2]!;
    const d = res.strokes[3]!;
    expect(c[0]!.y).toBe(d[0]!.y);
    expect(c[0]!.x).toBe(d[1]!.x);
    expect(c[1]!.x).toBe(d[0]!.x);
  });

  it("stays inside the well behaved part of the field", () => {
    expect(res.bbox.maxX - res.bbox.minX).toBeCloseTo(300 * PATTERN_FIELD_FRACTION, 9);
  });
});

describe("ruler", () => {
  it("puts ticks at cumulative step offsets", () => {
    const stepMm = 0.55;
    const res = ruler(FIELD, stepMm);
    expect(res.strokes.length).toBe(RULER_MARKS.length + 1);
    const left = res.strokes[0]![0]!.x;
    let want = left;
    for (let i = 0; i < RULER_MARKS.length; i++) {
      want += RULER_MARKS[i]! * stepMm;
      expect(res.strokes[i + 1]![0]!.x).toBeCloseTo(want, 9);
    }
  });

  it("scales its ticks with the machine's own step, not with the field", () => {
    const coarse = ruler(FIELD, 0.55);
    const fine = ruler(FIELD, 0.24);
    const spread = (r: typeof coarse): number =>
      r.strokes[RULER_MARKS.length]![0]!.x - r.strokes[1]![0]!.x;
    expect(spread(coarse)).toBeGreaterThan(spread(fine));
  });
});

describe("squareWithDiagonals", () => {
  const res = squareWithDiagonals(FIELD);

  it("is a closed square plus two diagonals", () => {
    expect(res.strokes.length).toBe(3);
    const sq = res.strokes[0]!;
    expect(sq.length).toBe(5);
    expect(sq[0]).toEqual(sq[4]);
  });

  it("crosses the diagonals at the centre of the field", () => {
    /* One diagonal cannot tell a bow from a skew. The pair crossing at the centre
     * can, which is why both are drawn. */
    for (const d of [res.strokes[1]!, res.strokes[2]!]) {
      expect((d[0]!.x + d[1]!.x) / 2).toBeCloseTo(0, 12);
      expect((d[0]!.y + d[1]!.y) / 2).toBeCloseTo(0, 12);
    }
    expect(res.strokes[1]![1]!.y - res.strokes[1]![0]!.y).toBeGreaterThan(0);
    expect(res.strokes[2]![1]!.y - res.strokes[2]![0]!.y).toBeLessThan(0);
  });
});

describe("rateRamp", () => {
  const res = rateRamp(FIELD);

  it("draws equal length rungs, evenly spaced", () => {
    expect(res.strokes.length).toBe(RATE_RAMP_LINES);
    const len = (i: number): number => res.strokes[i]![1]!.x - res.strokes[i]![0]!.x;
    for (let i = 1; i < RATE_RAMP_LINES; i++) expect(len(i)).toBeCloseTo(len(0), 12);
    const gap = res.strokes[1]![0]!.y - res.strokes[0]![0]!.y;
    for (let i = 1; i < RATE_RAMP_LINES; i++) {
      expect(res.strokes[i]![0]!.y - res.strokes[i - 1]![0]!.y).toBeCloseTo(gap, 9);
    }
  });
});

describe("stall hunt", () => {
  it("goes out and comes back to zero", () => {
    /* Out and back is what makes the test readable without instruments: if the axis
     * returns to where it started, nothing was lost. */
    const pts = huntPass("a", 800, TICK_HZ);
    expect(pts[0]!.a).toBe(0);
    expect(pts[pts.length - 1]!.a).toBe(0);
    expect(Math.max(...pts.map((p) => p.a))).toBe(HUNT_SPAN_STEPS);
  });

  it("moves one step at a time on one axis only", () => {
    const pts = huntPass("b", 800, TICK_HZ);
    for (const p of pts) expect(p.a).toBe(0);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i]!.b - pts[i - 1]!.b)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the beam off, because this is a motion test", () => {
    for (const p of huntPass("a", 1500, TICK_HZ)) expect(p.laser).toBe(false);
  });

  it("ramps in and out, so the cruise is what is under test", () => {
    /* Without the ramps every leg would start with a step from standstill straight
     * to the test rate, which stalls a stepper far below its real pull-out and would
     * make the hunt measure the acceleration limit instead. */
    const rate = 1000;
    const pts = huntPass("a", rate, TICK_HZ);
    const cruise = Math.round(TICK_HZ / rate);
    const slow = Math.round(TICK_HZ / HUNT_RAMP_START_RATE);
    expect(pts[1]!.intervalTicks).toBeGreaterThan(cruise);
    expect(pts[1]!.intervalTicks).toBeLessThanOrEqual(slow);
    const mid = pts[Math.floor(HUNT_SPAN_STEPS / 2)]!;
    expect(mid.intervalTicks).toBe(cruise);
    expect(pts[pts.length - 1]!.intervalTicks).toBeGreaterThan(cruise);
  });

  it("never asks for a zero tick interval", () => {
    for (const step of stallHunt(TICK_HZ, [100000])) {
      for (const p of step.points) expect(p.intervalTicks).toBeGreaterThanOrEqual(1);
    }
  });

  it("covers both axes at every rung of the ladder", () => {
    const steps = stallHunt(TICK_HZ);
    expect(steps.length).toBe(2 * HUNT_RATES.length);
    expect(steps.filter((s) => s.axis === "a").length).toBe(HUNT_RATES.length);
    expect(steps.filter((s) => s.axis === "b").length).toBe(HUNT_RATES.length);
  });
});
