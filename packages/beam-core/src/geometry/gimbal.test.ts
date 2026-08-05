import { describe, expect, it } from "vitest";
import { mmToAngles, mmToUV, sweepDeg, uvToMm } from "./gimbal.js";
import type { GimbalGeometry, Point } from "../types.js";

/*
 * These tests are the evidence for the claim in the PRD section 2.1. They do not
 * check the merged model against itself, they check it against the two shipped
 * implementations, reproduced here verbatim from the original single file tools.
 * If the merged model is right, it agrees with both to floating point noise; if
 * the unification is wrong, one of them diverges and says so.
 */

const RAD = 180 / Math.PI;

/* laser-rig.html, ik(), lines 2200-2206. Trims and inversion stripped: those are
 * axis-space corrections applied after the geometry, not part of it. */
function washerIk(wx: number, wy: number, distMm: number, vOffMm: number) {
  const D = Math.max(distMm, 40);
  const pan = 90 + Math.atan2(wx, D) * RAD;
  const tilt = 90 + Math.atan2(wy + vOffMm, Math.hypot(wx, D)) * RAD;
  return { pan, tilt };
}

/* laser-rig.html, fk(), lines 2258-2280. Same stripping. */
function washerFk(panDeg: number, tiltDeg: number, distMm: number, vOffMm: number) {
  const D = Math.max(distMm, 40);
  const ap = (panDeg - 90) / RAD;
  const wx = D * Math.tan(ap);
  const at = (tiltDeg - 90) / RAD;
  const wy = Math.hypot(wx, D) * Math.tan(at) - vOffMm;
  return { wx, wy };
}

/* detent-plot.html, mmToUV() ideal branch, lines 507-514. */
function detentMmToUV(x: number, y: number, throwMm: number, sepMm: number) {
  const a = Math.atan2(x, throwMm + sepMm);
  return { u: Math.tan(a), v: (y * Math.cos(a)) / throwMm };
}

/* detent-plot.html, uvToMm() ideal branch, lines 515-526. */
function detentUvToMm(u: number, v: number, throwMm: number, sepMm: number) {
  const a = Math.atan(u);
  return { x: (throwMm + sepMm) * u, y: (throwMm * v) / Math.cos(a) };
}

/* The two rigs as they are actually installed. */
const WASHER_BENCH: GimbalGeometry = {
  throwMm: 152, // 6 in throw
  sepMm: 0, // a pan/tilt head rotates about one point
  vOffMm: 305 / 2 - 70, // wallH/2 - mountH = 82.5
};

const DETENT_BENCH: GimbalGeometry = {
  throwMm: 150,
  sepMm: 22, // X mirror pivot to Y mirror pivot
  vOffMm: 0, // the beam axis already passes through the field centre
};

/* A spread of field points including the corners, where any disagreement between
 * the two forms would be largest. */
const PROBES: Point[] = [];
for (let x = -150; x <= 150; x += 25) {
  for (let y = -150; y <= 150; y += 25) {
    PROBES.push({ x, y });
  }
}

describe("the merged gimbal reproduces WASHER exactly with sep = 0", () => {
  it("agrees with the shipped ik() over the whole field", () => {
    for (const p of PROBES) {
      const want = washerIk(p.x, p.y, WASHER_BENCH.throwMm, WASHER_BENCH.vOffMm);
      const got = mmToAngles(p, WASHER_BENCH);

      /* The shipped code works in servo degrees referenced to 90; the merged model
       * works in signed radians about the axis. 90 + deg(theta) is the whole of the
       * conversion, and it belongs in the profile, not the geometry. */
      expect(90 + got.t1 * RAD).toBeCloseTo(want.pan, 10);
      expect(90 + got.t2 * RAD).toBeCloseTo(want.tilt, 10);
    }
  });

  it("agrees with the shipped fk() on the way back", () => {
    for (const p of PROBES) {
      const a = mmToAngles(p, WASHER_BENCH);
      const want = washerFk(90 + a.t1 * RAD, 90 + a.t2 * RAD, WASHER_BENCH.throwMm, WASHER_BENCH.vOffMm);

      expect(want.wx).toBeCloseTo(p.x, 8);
      expect(want.wy).toBeCloseTo(p.y, 8);
    }
  });
});

describe("the merged gimbal reproduces DETENT exactly with vOff = 0", () => {
  it("agrees with the shipped mmToUV() over the whole field", () => {
    for (const p of PROBES) {
      const want = detentMmToUV(p.x, p.y, DETENT_BENCH.throwMm, DETENT_BENCH.sepMm);
      const got = mmToUV(p, DETENT_BENCH);

      expect(got.u).toBeCloseTo(want.u, 12);
      expect(got.v).toBeCloseTo(want.v, 12);
    }
  });

  it("agrees with the shipped uvToMm() on the way back", () => {
    for (const p of PROBES) {
      const uv = mmToUV(p, DETENT_BENCH);
      const want = detentUvToMm(uv.u, uv.v, DETENT_BENCH.throwMm, DETENT_BENCH.sepMm);

      expect(want.x).toBeCloseTo(p.x, 8);
      expect(want.y).toBeCloseTo(p.y, 8);
    }
  });
});

describe("the two rigs really are the same model", () => {
  /*
   * The sharpest statement of the claim: give DETENT's model a zero separation and
   * WASHER's model a zero vertical offset and they become the same function of the
   * same parameters. If this ever fails, the profiles have diverged into two models
   * again and the shared planner is no longer honest.
   */
  it("detent with sep = 0 is washer with vOff = 0", () => {
    const g: GimbalGeometry = { throwMm: 150, sepMm: 0, vOffMm: 0 };

    for (const p of PROBES) {
      const asDetent = detentMmToUV(p.x, p.y, 150, 0);
      const asWasher = washerIk(p.x, p.y, 150, 0);

      expect(Math.tan((asWasher.pan - 90) / RAD)).toBeCloseTo(asDetent.u, 12);
      expect(Math.tan((asWasher.tilt - 90) / RAD)).toBeCloseTo(asDetent.v, 12);

      const merged = mmToUV(p, g);
      expect(merged.u).toBeCloseTo(asDetent.u, 12);
      expect(merged.v).toBeCloseTo(asDetent.v, 12);
    }
  });
});

describe("round trip", () => {
  /*
   * INV-01: the forward map and the inverse map must be exact inverses of each
   * other. Breaking this on the washer rig cost 159 mm of drawing offset once
   * already: fk inverted ik alone and ignored the home referencing that
   * wallToAngles applied on top, so the sim drew through a different mapping than
   * the one the beam was being aimed with.
   */
  for (const [name, g] of [
    ["washer", WASHER_BENCH],
    ["detent", DETENT_BENCH],
  ] as const) {
    it(`${name}: mm -> uv -> mm is the identity`, () => {
      let worst = 0;
      for (const p of PROBES) {
        const back = uvToMm(mmToUV(p, g), g);
        worst = Math.max(worst, Math.hypot(back.x - p.x, back.y - p.y));
      }
      expect(worst).toBeLessThan(1e-9);
    });
  }
});

describe("sweep readout", () => {
  it("shows a short throw eating angular range", () => {
    /* A short throw buys a big picture from a small rig and pays for it in servo
     * travel. At a 60 mm throw onto a 305 mm target the pan axis is asked for 137
     * degrees of its 180; back the rig off to 300 mm and the same target costs 54. */
    const tight: GimbalGeometry = { throwMm: 60, sepMm: 0, vOffMm: 82.5 };
    const roomy: GimbalGeometry = { throwMm: 300, sepMm: 0, vOffMm: 82.5 };

    expect(sweepDeg(305, 305, tight).t1).toBeCloseTo(137.046, 3);
    expect(sweepDeg(305, 305, roomy).t1).toBeCloseTo(53.891, 3);
  });

  it("records that the 40 mm throw floor caps pan sweep below the 170 degree warning", () => {
    /*
     * Worth pinning because it is not obvious: the washer app warns at 170 degrees
     * of demanded sweep, but its own 40 mm throw floor bounds pan sweep at about
     * 150 degrees for a 305 mm target, so that warning can only ever fire for pan
     * on a much wider field. The tilt axis reaches it sooner because vOff adds to
     * the demand asymmetrically. This is a real limit of the warning, not a bug,
     * and the merged readout should warn on the fraction of available travel used
     * rather than on a fixed 170.
     */
    const floored: GimbalGeometry = { throwMm: 40, sepMm: 0, vOffMm: 82.5 };
    expect(sweepDeg(305, 305, floored).t1).toBeLessThan(170);
    expect(sweepDeg(900, 900, floored).t1).toBeGreaterThan(165);
  });

  it("reports a workable sweep on the detent bench geometry", () => {
    const s = sweepDeg(120, 120, DETENT_BENCH);
    expect(s.t1).toBeGreaterThan(0);
    expect(s.t1).toBeLessThan(60);
    expect(s.t2).toBeLessThan(60);
  });
});
