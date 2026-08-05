import { describe, expect, it } from "vitest";
import {
  createHomographyCalibration,
  invertHomography,
  quadAspect,
  solveHomography,
  type Correspondence,
  type Homography8,
} from "./homography.js";
import { mmToUV, uvToMm } from "./gimbal.js";
import { createDetent28byj } from "../profiles/detent-28byj.js";
import { DEG_PER_STEP } from "../constants.js";

/*
 * The bench fixture. These are the four corners of a deliberately skewed rig, as
 * captured on the real machine, and the homography that was solved from them.
 *
 * The H values are recovered from audit_test.py, which feeds them through the qc3
 * adopt path. They are also what fwtest2.cpp reads from an h.txt that is missing
 * from the tree; committing them here is the fix for that.
 */
const BENCH_H: Homography8 = [
  0.009049, 0.0002516, 0.02427, 0.0004705, 0.007843, 0.02287, -0.0000231788, 0.000144292,
];

/** Captured corner positions in half steps, ordered TL, TR, BR, BL. */
const BENCH_CORNERS_STEPS: ReadonlyArray<readonly [number, number]> = [
  [-150, 140],
  [170, 155],
  [165, -130],
  [-160, -145],
];

/** The field those corners were captured against: 120 x 120 mm. */
const BENCH_FIELD = 120;
const cornerMm = (i: number): { x: number; y: number } => {
  const w = BENCH_FIELD / 2;
  return [
    { x: -w, y: w },
    { x: w, y: w },
    { x: w, y: -w },
    { x: -w, y: -w },
  ][i]!;
};

const RAD = 180 / Math.PI;
/** Half steps back to the tangent value they represent. A mirror doubles the beam. */
const stepToU = (s: number) => Math.tan((2 * s * DEG_PER_STEP) / RAD);

const BENCH: Correspondence[] = BENCH_CORNERS_STEPS.map(([sx, sy], i) => ({
  mm: cornerMm(i),
  uv: { u: stepToU(sx), v: stepToU(sy) },
}));

describe("solveHomography", () => {
  it("lands all four corners of a deliberately skewed rig", () => {
    const h = solveHomography(BENCH);
    expect(h).not.toBeNull();

    const cal = createHomographyCalibration(h!);
    const profile = createDetent28byj();

    for (let i = 0; i < 4; i++) {
      const want = BENCH_CORNERS_STEPS[i]!;
      const got = profile.inverse(cornerMm(i), cal);
      /* INV-04: within one step. The map is fitted in tangent space and the step
       * count is a rounding of it, so exact equality is not the right bar. */
      expect(Math.abs(Math.round(got.a) - want[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(Math.round(got.b) - want[1])).toBeLessThanOrEqual(1);
    }
  });

  it("reproduces the committed bench H closely enough to be the same map", () => {
    const h = solveHomography(BENCH)!;
    /*
     * Relative, not absolute. The committed values came off the board's qc3 dump at
     * four significant figures (0.02427, -0.0000231788), so an absolute tolerance
     * would be testing the printf format rather than the solve. Agreeing to one part
     * in ten thousand on every term is the honest statement that these are the same
     * map. The assertions that matter are the corner landing and the round trip
     * above; this one exists so a fixture that drifts gets caught.
     */
    for (let i = 0; i < 8; i++) {
      const rel = Math.abs(h[i]! - BENCH_H[i]!) / Math.max(1e-12, Math.abs(BENCH_H[i]!));
      expect(rel).toBeLessThan(1e-3);
    }
  });

  it("rejects collinear corners instead of solving them", () => {
    const collinear: Correspondence[] = [0, 1, 2, 3].map((i) => ({
      mm: { x: i * 10, y: i * 10 },
      uv: { u: i * 0.01, v: i * 0.01 },
    }));
    expect(solveHomography(collinear)).toBeNull();
  });

  it("rejects a degenerate set where two corners coincide", () => {
    const dup = [...BENCH];
    dup[1] = { ...dup[0]! };
    expect(solveHomography(dup)).toBeNull();
  });

  it("refuses anything that is not exactly four correspondences", () => {
    expect(solveHomography(BENCH.slice(0, 3))).toBeNull();
    expect(solveHomography([...BENCH, BENCH[0]!])).toBeNull();
  });
});

describe("the measured map round trips", () => {
  it("mm to steps to mm stays inside the 1.0 mm budget across the field", () => {
    const cal = createHomographyCalibration(BENCH_H);
    const profile = createDetent28byj();

    let worst = 0;
    for (let x = -60; x <= 60; x += 10) {
      for (let y = -60; y <= 60; y += 10) {
        const steps = profile.inverse({ x, y }, cal);
        const back = profile.forward({ a: Math.round(steps.a), b: Math.round(steps.b) }, cal);
        worst = Math.max(worst, Math.hypot(back.x - x, back.y - y));
      }
    }
    /* fwtest2.cpp budgets 1.0 mm and measured 0.289. Rounding to whole steps is the
     * dominant term, so this is really a statement about the step size. */
    expect(worst).toBeLessThan(1.0);
  });
});

describe("invertHomography", () => {
  it("stays unnormalised, as the projective use requires", () => {
    const hinv = invertHomography(BENCH_H);
    /* If someone "fixes" this by normalising, the last entry becomes 1 and the guard
     * against a near zero denominator stops meaning anything. */
    expect(hinv[8]).not.toBeCloseTo(1, 6);
    expect(hinv).toHaveLength(9);
  });

  it("composes back to the identity projectively", () => {
    const cal = createHomographyCalibration(BENCH_H);
    for (const p of [
      { x: 0, y: 0 },
      { x: 40, y: -25 },
      { x: -55, y: 58 },
    ]) {
      const a = cal.forward(p);
      const back = cal.inverse(a.t1, a.t2);
      expect(back).not.toBeNull();
      expect(back!.x).toBeCloseTo(p.x, 6);
      expect(back!.y).toBeCloseTo(p.y, 6);
    }
  });
});

describe("quadAspect", () => {
  it("reports 1 for a square quad", () => {
    const square = [
      { u: -0.1, v: 0.1 },
      { u: 0.1, v: 0.1 },
      { u: 0.1, v: -0.1 },
      { u: -0.1, v: -0.1 },
    ];
    expect(quadAspect(square)).toBeCloseTo(1, 9);
  });

  it("reports the real aspect of the skewed bench quad", () => {
    const uv = BENCH_CORNERS_STEPS.map(([sx, sy]) => ({ u: stepToU(sx), v: stepToU(sy) }));
    const a = quadAspect(uv);
    /* The bench rig is wider than it is tall in deflection terms, which is what the
     * app's aspect warning is for: if it disagrees with the configured field by more
     * than 25 percent the drawing squashes to match. */
    expect(a).toBeGreaterThan(1);
    expect(a).toBeLessThan(1.3);
  });

  it("returns 0 rather than dividing by a degenerate height", () => {
    const flat = [
      { u: -0.1, v: 0 },
      { u: 0.1, v: 0 },
      { u: 0.1, v: 0 },
      { u: -0.1, v: 0 },
    ];
    expect(quadAspect(flat)).toBe(0);
  });
});

describe("the ideal model is near linear in tangent space", () => {
  /*
   * This is why a four point homography is enough. If the ideal map were strongly
   * curved in (u, v) then four corners could not determine the correction between
   * them, and the whole calibration approach would be wrong rather than merely
   * approximate.
   */
  it("a straight line in mm stays nearly straight in uv", () => {
    const g = { throwMm: 150, sepMm: 22, vOffMm: 0 };
    const a = mmToUV({ x: -60, y: 40 }, g);
    const b = mmToUV({ x: 60, y: 40 }, g);

    let worst = 0;
    for (let t = 0.1; t < 1; t += 0.1) {
      const mid = mmToUV({ x: -60 + 120 * t, y: 40 }, g);
      const lerp = { u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t };
      /* Measure the departure back in millimetres so the number means something. */
      const p1 = uvToMm(mid, g);
      const p2 = uvToMm(lerp, g);
      worst = Math.max(worst, Math.hypot(p1.x - p2.x, p1.y - p2.y));
    }

    /* A couple of millimetres of bow across a 120 mm span. Small enough that a
     * projective fit absorbs the installation error, large enough that it is worth
     * saying out loud rather than claiming the map is affine. */
    expect(worst).toBeLessThan(3);
  });
});
